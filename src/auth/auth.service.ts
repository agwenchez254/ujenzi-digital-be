import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { AppRole, User } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { createHash, randomUUID } from 'crypto';
import { Response } from 'express';
import { AuditLogService } from '../audit-log/audit-log.service';
import { generateToken, hashToken } from '../common/utils/token.util';
import { MailService } from '../mail/mail.service';
import { PermissionsService } from '../permissions/permissions.service';
import { PrismaService } from '../prisma/prisma.service';
import { CompleteProfileDto } from './dto/complete-profile.dto';
import { SignupDto } from './dto/signup.dto';
import { GoogleProfile } from './strategies/google.strategy';

const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ACCESS_TOKEN_TTL = '15m';
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;
const PASSWORD_HISTORY_SIZE = 2;

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
    private permissionsService: PermissionsService,
    private mailService: MailService,
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

      if (existingByEmail?.passwordHash) {
        throw new ConflictException(
          'An account with this email already exists. Log in with your password to link Google from account settings.',
        );
      }

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

  async requestPasswordReset(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Always behave the same whether or not the email exists, so a caller
    // can't use this endpoint to discover which emails are registered.
    if (!user || !user.passwordHash) {
      return;
    }

    const token = generateToken();
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: hashToken(token),
        passwordResetExpiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
      },
    });

    await this.mailService.sendPasswordResetEmail({ to: user.email, name: user.name, token });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findFirst({ where: { passwordResetTokenHash: hashToken(token) } });
    if (!user) {
      throw new NotFoundException('Invalid or expired reset link');
    }
    if (!user.passwordResetExpiresAt || user.passwordResetExpiresAt.getTime() < Date.now()) {
      throw new GoneException('This reset link has expired — request a new one');
    }

    const recentHashes = [user.passwordHash, ...user.previousPasswordHashes].filter(
      (hash): hash is string => Boolean(hash),
    );
    for (const hash of recentHashes) {
      if (await bcrypt.compare(newPassword, hash)) {
        throw new BadRequestException(
          `Your new password must be different from your last ${PASSWORD_HISTORY_SIZE} passwords`,
        );
      }
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const previousPasswordHashes = [user.passwordHash, ...user.previousPasswordHashes]
      .filter((hash): hash is string => Boolean(hash))
      .slice(0, PASSWORD_HISTORY_SIZE);

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          previousPasswordHashes,
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
        },
      }),
      // A password reset means the old credentials may have been compromised
      // — kill every existing session rather than leaving them valid.
      this.prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    await this.auditLogService.log(user.id, 'user.password_reset', 'User', user.id, undefined, undefined);
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
    const permissions = await this.permissionsService.resolvePermissionsForRoles(roles);

    const accessToken = await this.jwtService.signAsync(
      { sub: userId, roles, permissions },
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
      user: { ...safeUser, roles, permissions },
      needsRoleSelection: roles.length === 0,
    };
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
