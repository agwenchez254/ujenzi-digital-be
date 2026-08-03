import { Body, Controller, Get, Ip, Param, Patch } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateRolesDto } from './dto/update-roles.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { UsersService } from './users.service';

@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private usersService: UsersService) {}

  @ApiOperation({ summary: "Get the caller's own profile" })
  @Get('me')
  getSelf(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.findSelf(user.userId);
  }

  @ApiOperation({ summary: "Update the caller's own profile fields" })
  @Patch('me')
  updateSelf(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateSelf(user.userId, dto);
  }

  @ApiOperation({ summary: 'List all users (administrator only)' })
  @Roles('administrator')
  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  @ApiOperation({ summary: "Update a user's active/inactive status (administrator only)" })
  @Roles('administrator')
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateStatusDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.usersService.updateStatus(id, dto, admin.userId, ip);
  }

  @ApiOperation({ summary: "Replace a user's roles (administrator only)" })
  @Roles('administrator')
  @Patch(':id/roles')
  updateRoles(
    @Param('id') id: string,
    @Body() dto: UpdateRolesDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.usersService.updateRoles(id, dto, admin.userId, ip);
  }
}
