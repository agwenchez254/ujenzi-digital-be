import { Body, Controller, Delete, Get, Param, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PutKeyBackupDto, RegisterDeviceDto } from './dto/e2ee.dto';
import { E2eeService } from './e2ee.service';

@ApiTags('End-to-end encryption')
@ApiBearerAuth()
@Controller('e2ee')
export class E2eeController {
  constructor(private e2ee: E2eeService) {}

  @ApiOperation({ summary: 'Register this device\'s public keys (the private keys never leave the device)' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('devices')
  register(@Body() dto: RegisterDeviceDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.e2ee.registerDevice(user.userId, dto, req.ip);
  }

  @ApiOperation({ summary: 'Your registered devices, including revoked ones' })
  @Get('devices')
  devices(@CurrentUser() user: AuthenticatedUser) {
    return this.e2ee.listDevices(user.userId);
  }

  @ApiOperation({ summary: 'Revoke a device: it can no longer send, and shared conversation keys are rotated' })
  @Delete('devices/:id')
  revoke(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.e2ee.revokeDevice(user.userId, id, req.ip);
  }

  @ApiOperation({ summary: 'Store the passphrase-encrypted backup of your private keys (opaque to the server)' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Put('backup')
  putBackup(@Body() dto: PutKeyBackupDto, @CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.e2ee.putBackup(user.userId, dto, req.ip);
  }

  @ApiOperation({ summary: 'Fetch your encrypted key backup to restore it on a new device' })
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Get('backup')
  getBackup(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.e2ee.getBackup(user.userId, req.ip);
  }

  @ApiOperation({ summary: 'Delete your key backup' })
  @Delete('backup')
  deleteBackup(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.e2ee.deleteBackup(user.userId, req.ip);
  }
}
