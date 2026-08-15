import { ConflictException, ForbiddenException, GoneException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { buildInvitationLink, generateToken, hashToken } from '../common/utils/token.util';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

const CONTRACTOR_INVITATION_TTL_MS = 48 * 60 * 60 * 1000;

function invitationStatus(invitation: { acceptedAt: Date | null; expiresAt: Date }): 'accepted' | 'expired' | 'pending' {
  if (invitation.acceptedAt) return 'accepted';
  if (invitation.expiresAt.getTime() < Date.now()) return 'expired';
  return 'pending';
}

function displayName(invited: { name: string } | null, email: string): string {
  return invited?.name ?? email.split('@')[0];
}

@Injectable()
export class ContractorInvitationsService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
    private mailService: MailService,
    private configService: ConfigService,
  ) {}

  async previewByToken(token: string) {
    const invitation = await this.findByToken(token);
    return {
      siteName: invitation.site.name,
      invitedByName: invitation.invitedBy.name,
      status: invitationStatus(invitation),
      expiresAt: invitation.expiresAt,
      invitedEmail: invitation.invitedEmail,
      // False means no account exists yet for this invite — the frontend
      // should show a signup form instead of a login-and-accept prompt.
      hasAccount: invitation.invitedUserId !== null,
    };
  }

  async accept(token: string, user: AuthenticatedUser, ip?: string) {
    const invitation = await this.findByToken(token);

    if (invitation.acceptedAt) {
      throw new ConflictException('This invitation has already been accepted');
    }
    if (invitation.expiresAt.getTime() < Date.now()) {
      throw new GoneException('This invitation has expired — ask the site owner to resend it');
    }

    if (invitation.invitedUserId) {
      if (invitation.invitedUserId !== user.userId) {
        throw new ForbiddenException('This invitation was not sent to your account');
      }
    } else {
      // Freeform invite — first account whose email matches claims it.
      const caller = await this.prisma.user.findUniqueOrThrow({ where: { id: user.userId }, select: { email: true } });
      if (invitation.invitedEmail.toLowerCase() !== caller.email.toLowerCase()) {
        throw new ForbiddenException('This invitation was not sent to your account');
      }
    }

    await this.prisma.$transaction([
      this.prisma.contractorInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date(), invitedUserId: user.userId },
      }),
      this.prisma.site.update({
        where: { id: invitation.siteId },
        data: { contractorId: user.userId },
      }),
      this.prisma.sitePersonnel.updateMany({
        where: { siteId: invitation.siteId, role: 'CONTRACTOR' },
        data: { userId: user.userId },
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
      invitedUserName: displayName(invitation.invited, invitation.invitedEmail),
      invitedUserEmail: invitation.invitedEmail,
      status: invitationStatus(invitation),
      expiresAt: invitation.expiresAt,
    };
  }

  async resend(siteId: string, user: AuthenticatedUser, ip?: string) {
    const site = await this.prisma.site.findUnique({
      where: { id: siteId },
      select: {
        contractorId: true,
        name: true,
        address: true,
        latitude: true,
        longitude: true,
        constructionPhase: true,
        developmentType: true,
        expectedEndDate: true,
        landmarks: true,
      },
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

    // No "must be expired first" guard — this doubles as the "get me the
    // invite link again" action (e.g. to share outside of email), which is
    // useful anytime the invitation is still pending, not just once it's
    // expired. Rotating the token is safe either way: the old one just
    // stops working.
    const token = generateToken();
    await this.prisma.contractorInvitation.update({
      where: { id: invitation.id },
      data: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + CONTRACTOR_INVITATION_TTL_MS) },
    });

    await this.auditLogService.log(user.userId, 'site.contractor_invitation_resent', 'Site', siteId, undefined, ip);

    await this.mailService.sendContractorInvitation({
      to: invitation.invitedEmail,
      contractorName: displayName(invitation.invited, invitation.invitedEmail),
      siteName: site.name,
      developerName: invitation.invitedBy.name,
      token,
      isResend: true,
      address: site.address,
      latitude: Number(site.latitude),
      longitude: Number(site.longitude),
      constructionPhase: site.constructionPhase,
      developmentType: site.developmentType,
      expectedEndDate: site.expectedEndDate,
      landmarks: site.landmarks,
    });

    const origin = this.configService.get<string>('FRONTEND_ORIGIN') || 'http://localhost:8080';
    return { link: buildInvitationLink(origin, token, 'contractor') };
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
