import { BadRequestException, ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { generateToken, hashToken } from '../common/utils/token.util';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

const CONTRACTOR_INVITATION_TTL_MS = 48 * 60 * 60 * 1000;

function invitationStatus(invitation: { acceptedAt: Date | null; expiresAt: Date }): 'accepted' | 'expired' | 'pending' {
  if (invitation.acceptedAt) return 'accepted';
  if (invitation.expiresAt.getTime() < Date.now()) return 'expired';
  return 'pending';
}

@Injectable()
export class ContractorInvitationsService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
    private mailService: MailService,
  ) {}

  async previewByToken(token: string) {
    const invitation = await this.findByToken(token);
    return {
      siteName: invitation.site.name,
      invitedByName: invitation.invitedBy.name,
      status: invitationStatus(invitation),
      expiresAt: invitation.expiresAt,
    };
  }

  async accept(token: string, user: AuthenticatedUser, ip?: string) {
    const invitation = await this.findByToken(token);

    if (invitation.invitedUserId !== user.userId) {
      throw new ForbiddenException('This invitation was not sent to your account');
    }
    if (invitation.acceptedAt) {
      throw new ConflictException('This invitation has already been accepted');
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new GoneException('This invitation has expired — ask the site owner to resend it');
    }

    await this.prisma.$transaction([
      this.prisma.contractorInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      }),
      this.prisma.site.update({
        where: { id: invitation.siteId },
        data: { contractorId: invitation.invitedUserId },
      }),
    ]);

    await this.auditLogService.log(
      user.userId,
      'site.contractor_invitation_accepted',
      'Site',
      invitation.siteId,
      undefined,
      ip,
    );
  }

  async getForSite(siteId: string, user: AuthenticatedUser) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId }, select: { contractorId: true } });
    if (!site) {
      throw new NotFoundException('Site not found');
    }
    this.assertCanManage(site, user);

    const invitation = await this.prisma.contractorInvitation.findUnique({
      where: { siteId },
      include: { invited: { select: { name: true, email: true } } },
    });
    if (!invitation) {
      throw new NotFoundException('No invitation exists for this site');
    }

    return {
      invitedUserName: invitation.invited.name,
      invitedUserEmail: invitation.invited.email,
      status: invitationStatus(invitation),
      expiresAt: invitation.expiresAt,
    };
  }

  async resend(siteId: string, user: AuthenticatedUser, ip?: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: { contractorId: true, name: true },
    });
    if (!site) {
      throw new NotFoundException('Site not found');
    }
    this.assertCanManage(site, user);

    const invitation = await this.prisma.contractorInvitation.findUnique({
      where: { siteId },
      include: {
        invited: { select: { name: true, email: true } },
        invitedBy: { select: { name: true } },
      },
    });
    if (!invitation) {
      throw new NotFoundException('No invitation exists for this site');
    }
    if (invitation.acceptedAt) {
      throw new ConflictException('This invitation has already been accepted');
    }
    if (invitation.expiresAt.getTime() >= Date.now()) {
      throw new BadRequestException('This invitation has not expired yet');
    }

    const token = generateToken();
    await this.prisma.contractorInvitation.update({
      where: { id: invitation.id },
      data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + CONTRACTOR_INVITATION_TTL_MS) },
    });

    await this.auditLogService.log(user.userId, 'site.contractor_invitation_resent', 'Site', siteId, undefined, ip);

    await this.mailService.sendContractorInvitation({
      to: invitation.invited.email,
      contractorName: invitation.invited.name,
      siteName: site.name,
      developerName: invitation.invitedBy.name,
      token,
      isResend: true,
    });
  }

  private assertCanManage(site: { contractorId: string }, user: AuthenticatedUser) {
    if (site.contractorId !== user.userId && !user.roles.includes('administrator')) {
      throw new ForbiddenException('You do not manage this site\'s contractor invitation');
    }
  }

  private async findByToken(token: string) {
    const invitation = await this.prisma.contractorInvitation.findFirst({
      where: { tokenHash: hashToken(token) },
      include: { site: { select: { name: true } }, invitedBy: { select: { name: true } } },
    });
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    return invitation;
  }
}
