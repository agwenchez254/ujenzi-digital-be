import { Controller, Get, Ip, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { ContractorInvitationsService } from './contractor-invitations.service';

@ApiTags('Contractor Invitations')
@Controller()
export class ContractorInvitationsController {
  constructor(private contractorInvitationsService: ContractorInvitationsService) {}

  @ApiOperation({ summary: 'Preview a contractor invitation by its emailed token (no auth required)' })
  @Public()
  @Get('contractor-invitations/:token')
  preview(@Param('token') token: string) {
    return this.contractorInvitationsService.previewByToken(token);
  }

  @ApiOperation({ summary: 'Accept a contractor invitation (must be logged in as the invited account)' })
  @ApiBearerAuth()
  @Post('contractor-invitations/:token/accept')
  accept(@Param('token') token: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.contractorInvitationsService.accept(token, user, ip);
  }

  @ApiOperation({ summary: "Get a site's pending contractor invitation status (current contractorId holder or admin only)" })
  @ApiBearerAuth()
  @Get('sites/:id/contractor-invitation')
  getForSite(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.contractorInvitationsService.getForSite(id, user);
  }

  @ApiOperation({ summary: 'Resend an expired contractor invitation (current contractorId holder or admin only)' })
  @ApiBearerAuth()
  @Post('sites/:id/contractor-invitation/resend')
  resend(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser, @Ip() ip: string) {
    return this.contractorInvitationsService.resend(id, user, ip);
  }
}
