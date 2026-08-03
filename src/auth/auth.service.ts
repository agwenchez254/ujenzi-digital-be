import { ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AppRole, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'crypto';
import { Response } from 'express';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { SignupDto } from './dto/signup.dto';
import { GoogleProfile } from './strategies/google.strategy';

const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_TTL = '15m';

export interface AuthResult {
  accessToken: string;
  user: Record<string, unknown>;
  needsRoleSelection: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private auditLogService: AuditLogService,
  ) {}

  async signup(dto: SignupDto, res: Response, ip?: string): Promise<AuthResult> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email is already registered');
    }

    const passwordHash = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash,
        name: dto.name,
        phone: dto.phone,
        company: dto.company,
        certificationDetails: dto.certificationDetails,
        roles: { create: dto.roles.map((role) => ({ role })) },
      },
    });

    await this.auditLogService.log(
      user.id,
      'user.roles_assigned',
      'User',
      user.id,
      { roles: dto.roles },
      ip,
    );

    return this.issueTokens(user.id, res);
  }

  async validateCredentials(email: string, password: string): Promise<User | null> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.passwordHash) {
      return null;
    }
    const matches = await bcrypt.compare(password, user.passwordHash);
    return matches ? user : null;
  }

  async login(user: User, res: Response): Promise<AuthResult> {
    return this.issueTokens(user.id, res);
  }

  async loginWithGoogle(profile: GoogleProfile, res: Response): Promise<AuthResult> {
    let user = await this.prisma.user.findUnique({ where: { googleId: profile.googleId } });

    if (!user) {
      const existingByEmail = await this.prisma.user.findUnique({ where: { email: profile.email } });
      user = existingByEmail
        ? await this.prisma.user.update({
            where: { id: existingByEmail.id },
            data: { googleId: profile.googleId },
          })
        : await this.prisma.user.create({
            data: {
              email: profile.email,
              googleId: profile.googleId,
              name: profile.name,
              avatarUrl: profile.avatarUrl,
            },
          });
    }

    return this.issueTokens(user.id, res);
  }

  async completeProfile(
    userId: string,
    dto: CompleteProfileDto,
    res: Response,
    ip?: string,
  ): Promise<AuthResult> {
    const existingRoles = await this.getRoles(userId);
    if (existingRoles.length > 0) {
      throw new ForbiddenException('Profile roles already set');
    }

    await this.prisma.userRole.createMany({
      data: dto.roles.map((role) => ({ userId, role })),
      skipDuplicates: true,
    });

    await this.auditLogService.log(userId, 'user.roles_assigned', 'User', userId, { roles: dto.roles }, ip);

    return this.issueTokens(userId, res);
  }

  async refresh(rawRefreshToken: string | undefined, res: Response): Promise<AuthResult> {
    if (!rawRefreshToken) {
      throw new UnauthorizedException('Missing refresh token');
    }

    let payload: { sub: string };
    try {
      payload = await this.jwtService.verifyAsync(rawRefreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const tokenHash = this.hashToken(rawRefreshToken);
    const stored = await this.prisma.refreshToken.findFirst({
      where: { userId: payload.sub, tokenHash },
    });

    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      // Reuse of an already-rotated/revoked token: treat as compromise, kill the whole session.
      await this.prisma.refreshToken.updateMany({
        where: { userId: payload.sub, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Refresh token has been revoked');
    }

    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });

    return this.issueTokens(payload.sub, res);
  }

  async logout(rawRefreshToken: string | undefined, res: Response): Promise<void> {
    if (rawRefreshToken) {
      const tokenHash = this.hashToken(rawRefreshToken);
      await this.prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/auth' });
  }

  private async getRoles(userId: string): Promise<AppRole[]> {
    const roles = await this.prisma.userRole.findMany({ where: { userId } });
    return roles.map((r) => r.role);
  }

  private async issueTokens(userId: string, res: Response): Promise<AuthResult> {
    const [user, roles] = await Promise.all([
      this.prisma.user.findUniqueOrThrow({ where: { id: userId } }),
      this.getRoles(userId),
    ]);

    const accessToken = await this.jwtService.signAsync(
      { sub: userId, roles },
      {
        secret: this.configService.get<string>('JWT_ACCESS_SECRET'),
        expiresIn: ACCESS_TOKEN_TTL,
      },
    );

    const refreshToken = await this.jwtService.signAsync(
      { sub: userId, jti: randomUUID() },
      {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: '7d',
      },
    );

    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashToken(refreshToken),
        expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
      },
    });

    res.cookie(REFRESH_COOKIE_NAME, refreshToken, {
      httpOnly: true,
      secure: this.configService.get<string>('NODE_ENV') === 'production',
      sameSite: 'lax',
      path: '/auth',
      maxAge: REFRESH_TOKEN_TTL_MS,
    });

    const { passwordHash: _passwordHash, ...safeUser } = user;

    return {
      accessToken,
      user: { ...safeUser, roles },
      needsRoleSelection: roles.length === 0,
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
