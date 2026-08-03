import { Injectable, NotFoundException } from '@nestjs/common';
import { AppRole, User } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateRolesDto } from './dto/update-roles.dto';
import { UpdateStatusDto } from './dto/update-status.dto';

type UserWithRoles = User & { roles: { role: AppRole }[] };

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
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
    const { passwordHash: _passwordHash, roles, ...safe } = user;
    return { ...safe, roles: roles.map((r) => r.role) };
  }
}
