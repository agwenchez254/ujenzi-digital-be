import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { buildInvitationLink, generateToken, hashToken } from '../common/utils/token.util';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

const PERSONNEL_INVITATION_TTL_MS = 48 * 60 * 60 * 1000;

function invitationStatus(personnel: {
  invitationAcceptedAt: Date | null;
  invitationExpiresAt: Date | null;
}): 'accepted' | 'expired' | 'pending' {
  if (personnel.invitationAcceptedAt) return 'accepted';
  if (!personnel.invitationExpiresAt || personnel.invitationExpiresAt.getTime() < Date.now()) return 'expired';
  return 'pending';
}

@Injectable()
export class PersonnelInvitationsService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
    private mailService: MailService,
    private configService: ConfigService,
  ) {}

  async previewByToken(token: string) {
    const personnel = await this.findByToken(token);
    const site = await this.prisma.site.findUniqueOrThrow({
      where: { id: personnel.siteId },
      select: { name: true, contractorId: true },
    });
    const inviter = await this.prisma.user.findUnique({ where: { id: site.contractorId }, select: { name: true } });

    return {
      siteName: site.name,
      role: personnel.role,
      invitedByName: inviter?.name ?? 'A site manager',
      status: invitationStatus(personnel),
      expiresAt: personnel.invitationExpiresAt,
      invitedEmail: personnel.email,
    };
  }

  async accept(token: string, user: AuthenticatedUser, ip?: string) {
    const personnel = await this.findByToken(token);

    if (personnel.invitationAcceptedAt) {
      throw new ConflictException('This invitation has already been accepted');
    }
    if (!personnel.invitationExpiresAt || personnel.invitationExpiresAt.getTime() < Date.now()) {
      throw new GoneException('This invitation has expired — ask the site owner to resend it');
    }

    const caller = await this.prisma.user.findUniqueOrThrow({ where: { id: user.userId }, select: { email: true } });
    if (!personnel.email || personnel.email.toLowerCase() !== caller.email.toLowerCase()) {
      throw new ForbiddenException('This invitation was not sent to your account');
    }

    await this.prisma.sitePersonnel.update({
      where: { id: personnel.id },
      data: { userId: user.userId, invitationAcceptedAt: new Date() },
    });

    await this.auditLogService.log(
      user.userId,
      'site.personnel_invitation_accepted',
      'Site',
      personnel.siteId,
      { role: personnel.role },
      ip,
    );
  }

  async resend(personnelId: string, user: AuthenticatedUser, ip?: string) {
    const personnel = await this.prisma.sitePersonnel.findUnique({ where: { id: personnelId } });
    if (!personnel) {
      throw new NotFoundException('Personnel entry not found');
    }
    const site = await this.prisma.site.findUniqueOrThrow({
      where: { id: personnel.siteId },
      select: { name: true, contractorId: true },
    });
    this.assertCanManage(site, user);

    if (!personnel.email || !personnel.invitationTokenHash) {
      throw new BadRequestException('No invitation exists for this personnel entry');
    }
    if (personnel.invitationAcceptedAt) {
      throw new ConflictException('This invitation has already been accepted');
    }

    // No "must be expired first" guard — see the same comment in
    // ContractorInvitationsService.resend(): this also serves as "get me
    // the invite link again" while it's still pending, not just once expired.
    const token = generateToken();
    await this.prisma.sitePersonnel.update({
      where: { id: personnel.id },
      data: {
        invitationTokenHash: hashToken(token),
        invitationExpiresAt: new Date(Date.now() + PERSONNEL_INVITATION_TTL_MS),
      },
    });

    await this.auditLogService.log(
      user.userId,
      'site.personnel_invitation_resent',
      'Site',
      personnel.siteId,
      { role: personnel.role },
      ip,
    );

    const inviter = await this.prisma.user.findUnique({ where: { id: user.userId }, select: { name: true } });
    await this.mailService.sendPersonnelInvitation({
      to: personnel.email,
      name: personnel.name ?? personnel.email.split('@')[0],
      role: personnel.role,
      siteName: site.name,
      invitedByName: inviter?.name ?? 'A site manager',
      token,
      isResend: true,
    });

    const origin = this.configService.get<string>('FRONTEND_ORIGIN') || 'http://localhost:8080';
    return { link: buildInvitationLink(origin, token, 'personnel') };
  }

  private assertCanManage(site: { contractorId: string }, user: AuthenticatedUser) {
    if (site.contractorId !== user.userId && !user.roles.includes('administrator')) {
      throw new ForbiddenException("You do not manage this site's personnel");
    }
  }

  private async findByToken(token: string) {
    const personnel = await this.prisma.sitePersonnel.findFirst({
      where: { invitationTokenHash: hashToken(token) },
    });
    if (!personnel) {
      throw new NotFoundException('Invitation not found');
    }
    return personnel;
  }
}
