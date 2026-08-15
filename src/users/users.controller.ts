import { Body, Controller, Get, Ip, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { LookupUserDto } from './dto/lookup-user.dto';
import { RequestEmailChangeDto } from './dto/request-email-change.dto';
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

  @ApiOperation({ summary: "Request an email change — sends a confirmation link to the new address" })
  @Post('me/email-change')
  requestEmailChange(@CurrentUser() user: AuthenticatedUser, @Body() dto: RequestEmailChangeDto) {
    return this.usersService.requestEmailChange(user.userId, dto);
  }

  @ApiOperation({ summary: 'Confirm an email change via its emailed token (no auth required)' })
  @Public()
  @Post('email-change/confirm/:token')
  confirmEmailChange(@Param('token') token: string) {
    return this.usersService.confirmEmailChange(token);
  }

  @ApiOperation({ summary: 'Look up a user by email (any authenticated user) — for linking site personnel' })
  @Get('lookup')
  lookup(@Query() query: LookupUserDto) {
    return this.usersService.lookupByEmail(query.email);
  }

  @ApiOperation({ summary: 'List active engineers (any authenticated user) — for assigning inspection requests' })
  @Get('engineers')
  findEngineers() {
    return this.usersService.findEngineers();
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

  @ApiOperation({ summary: "Update another user's profile fields (administrator only)" })
  @Roles('administrator')
  @Patch(':id')
  updateUser(
    @Param('id') id: string,
    @Body() dto: UpdateProfileDto,
    @CurrentUser() admin: AuthenticatedUser,
    @Ip() ip: string,
  ) {
    return this.usersService.updateProfileAsAdmin(id, dto, admin.userId, ip);
  }
}
