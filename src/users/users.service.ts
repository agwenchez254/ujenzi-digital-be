import { BadRequestException, ConflictException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { AppRole, User } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { generateToken, hashToken } from '../common/utils/token.util';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { RequestEmailChangeDto } from './dto/request-email-change.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateRolesDto } from './dto/update-roles.dto';
import { UpdateStatusDto } from './dto/update-status.dto';

type UserWithRoles = User & { roles: { role: AppRole }[] };

const EMAIL_CHANGE_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
    private mailService: MailService,
  ) {}

  async findSelf(userId: string) {
    return this.toSafeUser(await this.findUserOrThrow(userId));
  }

  async updateSelf(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: dto,
      include: { roles: true },
    });
    return this.toSafeUser(user);
  }

  async findAll() {
    const users = await this.prisma.user.findMany({ include: { roles: true } });
    return users.map((user) => this.toSafeUser(user));
  }

  async updateStatus(targetUserId: string, dto: UpdateStatusDto, adminUserId: string, ip?: string) {
    await this.findUserOrThrow(targetUserId);

    const user = await this.prisma.user.update({
      where: { id: targetUserId },
      data: { status: dto.status },
      include: { roles: true },
    });

    await this.auditLogService.log(
      adminUserId,
      'user.status_updated',
      'User',
      targetUserId,
      { status: dto.status },
      ip,
    );

    return this.toSafeUser(user);
  }

  async updateRoles(targetUserId: string, dto: UpdateRolesDto, adminUserId: string, ip?: string) {
    await this.findUserOrThrow(targetUserId);

    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({ where: { userId: targetUserId } }),
      this.prisma.userRole.createMany({
        data: dto.roles.map((role) => ({ userId: targetUserId, role })),
      }),
    ]);

    await this.auditLogService.log(
      adminUserId,
      'user.roles_updated',
      'User',
      targetUserId,
      { roles: dto.roles },
      ip,
    );

    return this.toSafeUser(await this.findUserOrThrow(targetUserId));
  }

  async updateProfileAsAdmin(
    targetUserId: string,
    dto: UpdateProfileDto,
    adminUserId: string,
    ip?: string,
  ) {
    await this.findUserOrThrow(targetUserId);

    const user = await this.prisma.user.update({
      where: { id: targetUserId },
      data: dto,
      include: { roles: true },
    });

    await this.auditLogService.log(adminUserId, 'user.profile_updated', 'User', targetUserId, { ...dto }, ip);

    return this.toSafeUser(user);
  }

  async requestEmailChange(userId: string, dto: RequestEmailChangeDto) {
    const user = await this.findUserOrThrow(userId);

    const inUse = await this.prisma.user.findUnique({ where: { email: dto.newEmail } });
    if (inUse) {
      throw new ConflictException('That email is already in use');
    }

    const token = generateToken();
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: {
        pendingEmail: dto.newEmail,
        emailChangeTokenHash: hashToken(token),
        emailChangeExpiresAt: new Date(Date.now() + EMAIL_CHANGE_TTL_MS),
      },
      include: { roles: true },
    });

    await this.mailService.sendEmailChangeVerification({ to: dto.newEmail, name: user.name, token });

    return this.toSafeUser(updated);
  }

  async confirmEmailChange(token: string) {
    const user = await this.prisma.user.findFirst({ where: { emailChangeTokenHash: hashToken(token) } });
    if (!user) {
      throw new NotFoundException('Invalid or expired confirmation link');
    }
    if (!user.emailChangeExpiresAt || user.emailChangeExpiresAt.getTime() < Date.now()) {
      throw new GoneException('This confirmation link has expired — request the change again');
    }
    if (!user.pendingEmail) {
      throw new BadRequestException('No pending email change found');
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: { email: user.pendingEmail, pendingEmail: null, emailChangeTokenHash: null, emailChangeExpiresAt: null },
      include: { roles: true },
    });

    return this.toSafeUser(updated);
  }

  // Open to any authenticated user (not just admins) so inspection requests can
  // search for an engineer to assign — deliberately narrow columns, no status
  // or role details about anyone leak beyond "is an active engineer".
  async findEngineers() {
    return this.prisma.user.findMany({
      where: { status: 'active', roles: { some: { role: 'engineer' } } },
      select: { id: true, name: true, email: true, avatarUrl: true },
      orderBy: { name: 'asc' },
    });
  }

  async lookupByEmail(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, name: true },
    });
    if (!user) {
      throw new NotFoundException('No user found with that email');
    }
    return user;
  }

  private async findUserOrThrow(userId: string): Promise<UserWithRoles> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { roles: true },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  private toSafeUser(user: UserWithRoles) {
    const { passwordHash: _passwordHash, emailChangeTokenHash: _hash, roles, ...safe } = user;
    return { ...safe, roles: roles.map((r) => r.role) };
  }
}
