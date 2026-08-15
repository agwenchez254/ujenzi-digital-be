import { Controller, Get, Ip, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { PersonnelInvitationsService } from './personnel-invitations.service';

@ApiTags('Personnel Invitations')
@Controller()
export class PersonnelInvitationsController {
  constructor(private personnelInvitationsService: PersonnelInvitationsService) {}

  @ApiOperation({ summary: 'Preview a personnel invitation by its emailed token (no auth required)' })
  @Public()
  @Get('personnel-invitations/:token')
  preview(@Param('token') token: string) {
    return this.personnelInvitationsService.previewByToken(token);
  }

  @ApiOperation({ summary: 'Accept a personnel invitation (must be logged in with the invited email)' })
  @ApiBearerAuth()
  @Post('personnel-invitations/:token/accept')
  accept(@Param('token') token: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.personnelInvitationsService.accept(token, user, ip);
  }

  @ApiOperation({ summary: 'Resend an expired personnel invitation (site contractor or administrator only)' })
  @ApiBearerAuth()
  @Post('site-personnel/:id/resend-invitation')
  resend(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.personnelInvitationsService.resend(id, user, ip);
  }
}
