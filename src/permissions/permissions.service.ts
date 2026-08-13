import { Injectable } from '@nestjs/common';
import { AppRole } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { Permission } from './permission.constants';

@Injectable()
export class PermissionsService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
  ) {}

  async getAllRolePermissions(): Promise<Record<AppRole, Permission[]>> {
    const rows = await this.prisma.rolePermission.findMany();
    const result = Object.fromEntries(
      Object.values(AppRole).map((role) => [role, [] as Permission[]]),
    ) as Record<AppRole, Permission[]>;

    for (const row of rows) {
      result[row.role].push(row.permission as Permission);
    }
    return result;
  }

  async resolvePermissionsForRoles(roles: AppRole[]): Promise<Permission[]> {
    if (roles.length === 0) {
      return [];
    }
    const rows = await this.prisma.rolePermission.findMany({
      where: { role: { in: roles } },
    });
    return [...new Set(rows.map((row) => row.permission))] as Permission[];
  }

  async replaceRolePermissions(
    role: AppRole,
    permissions: Permission[],
    adminUserId: string,
    ip?: string,
  ): Promise<Permission[]> {
    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { role } }),
      this.prisma.rolePermission.createMany({
        data: permissions.map((permission) => ({ role, permission })),
      }),
    ]);

    await this.auditLogService.log(
      adminUserId,
      'role_permissions.updated',
      'RolePermission',
      role,
      { role, permissions },
      ip,
    );

    return permissions;
  }
}
