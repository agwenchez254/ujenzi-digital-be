import { Body, Controller, Get, Ip, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppRole } from '@prisma/client';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UpdateRolePermissionsDto } from './dto/update-role-permissions.dto';
import { PermissionsService } from './permissions.service';

@ApiTags('Permissions')
@ApiBearerAuth()
@Controller('roles')
export class PermissionsController {
  constructor(private permissionsService: PermissionsService) {}

  @ApiOperation({ summary: "Get every role's current permission set (administrator only)" })
  @Roles('administrator')
  @Get('permissions')
  getAll() {
    return this.permissionsService.getAllRolePermissions();
  }

  @ApiOperation({ summary: "Replace a role's permission set (administrator only)" })
  @Roles('administrator')
  @Put(':role/permissions')
  replace(
    @Param('role') role: AppRole,
    @Body() dto: UpdateRolePermissionsDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.permissionsService.replaceRolePermissions(role, dto.permissions, admin.userId, ip);
  }
}
