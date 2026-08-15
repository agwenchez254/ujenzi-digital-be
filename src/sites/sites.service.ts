import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, Site } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { buildInvitationLink, generateToken, hashToken } from '../common/utils/token.util';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { CreateSiteDto } from './dto/create-site.dto';
import { SitePersonnelInputDto } from './dto/site-personnel-input.dto';
import { UpdateSiteDto } from './dto/update-site.dto';

interface PendingPersonnelInvite {
  name: string;
  role: string;
  email: string;
  token: string;
}

export interface PersonnelInvitationLink {
  name: string;
  role: string;
  link: string;
}

const CONTRACTOR_SELECT = { id: true, name: true, company: true } as const;
const PERSONNEL_INCLUDE = {
  personnel: {
    include: { user: { select: { id: true, name: true, email: true } } },
  },
} as const;
const EARTH_RADIUS_METERS = 6_371_000;
const CONTRACTOR_INVITATION_TTL_MS = 48 * 60 * 60 * 1000;

export interface SiteWithinRadiusRow {
  id: string;
  name: string;
  address: string;
  latitude: Prisma.Decimal;
  longitude: Prisma.Decimal;
  geofenceRadius: number;
  distanceMeters: number;
}

export interface MapPin {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  status: string;
  address: string;
  constructionPhase: string | null;
}

@Injectable()
export class SitesService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
    private mailService: MailService,
    private realtimeEventsService: RealtimeEventsService,
    private configService: ConfigService,
  ) {}

  // Invitation links are only ever available in plaintext at the moment a
  // token is generated (only its hash is persisted) — this is why every
  // link is handed back in the same response that creates/rotates the
  // token, rather than something a later GET could reconstruct.
  private linkForToken(token: string, kind: 'contractor' | 'personnel'): string {
    const origin = this.configService.get<string>('FRONTEND_ORIGIN') || 'http://localhost:8080';
    return buildInvitationLink(origin, token, kind);
  }

  private personnelInvitationLinks(invites: PendingPersonnelInvite[]): PersonnelInvitationLink[] {
    return invites.map((invite) => ({
      name: invite.name,
      role: invite.role,
      link: this.linkForToken(invite.token, 'personnel'),
    }));
  }

  async findAll(user: AuthenticatedUser) {
    const where = user.roles.includes('administrator')
      ? {}
      : { id: { in: await this.resolveTiedSiteIds(user.userId) } };

    return this.prisma.site.findMany({
      where,
      include: { contractor: { select: CONTRACTOR_SELECT }, ...PERSONNEL_INCLUDE },
      orderBy: { createdAt: 'desc' },
    });
  }

  findOne(id: string) {
    return this.findSiteOrThrow(id);
  }

  async create(dto: CreateSiteDto, user: AuthenticatedUser, ip?: string) {
    const { contractorId, pendingContractor } = await this.resolveContractorId(dto, user);
    const invitationToken = pendingContractor ? generateToken() : undefined;
    let personnelInvites: PendingPersonnelInvite[] = [];

    const created = await this.prisma.$transaction(async (tx) => {
      const site = await tx.site.create({
        data: {
          name: dto.name,
          contractorId,
          latitude: dto.latitude,
          longitude: dto.longitude,
          geofenceRadius: dto.geofenceRadius,
          address: dto.address,
          constructionPhase: dto.constructionPhase,
          developmentType: dto.developmentType,
          country: dto.country,
          county: dto.county,
          constituency: dto.constituency,
          town: dto.town,
          plotNumber: dto.plotNumber,
          expectedEndDate: dto.expectedEndDate ? new Date(dto.expectedEndDate) : undefined,
          landmarks: dto.landmarks,
          approvals: dto.approvals as unknown as Prisma.InputJsonValue | undefined,
        },
      });

      if (dto.personnel?.length) {
        const { rows, invites } = this.buildPersonnelRows(dto.personnel, site.id);
        personnelInvites = invites;
        await tx.sitePersonnel.createMany({ data: rows });
      }

      if (pendingContractor && invitationToken) {
        await tx.contractorInvitation.create({
          data: {
            siteId: site.id,
            invitedUserId: pendingContractor.userId,
            invitedEmail: pendingContractor.email,
            invitedById: user.userId,
            tokenHash: hashToken(invitationToken),
            expiresAt: new Date(Date.now() + CONTRACTOR_INVITATION_TTL_MS),
          },
        });
      }

      return site;
    });

    await this.auditLogService.log(user.userId, 'site.created', 'Site', created.id, { contractorId }, ip);

    await this.realtimeEventsService.emit(
      'site.created',
      created,
      { siteIds: [created.id], roles: ['administrator'] },
      { title: 'New Site Added', body: created.name, url: `/sites/${created.id}` },
    );

    if (pendingContractor && invitationToken) {
      await this.auditLogService.log(
        user.userId,
        'site.contractor_invited',
        'Site',
        created.id,
        { invitedEmail: pendingContractor.email },
        ip,
      );
      const developer = await this.prisma.user.findUnique({ where: { id: user.userId }, select: { name: true } });
      this.mailService
        .sendContractorInvitation({
          to: pendingContractor.email,
          contractorName: pendingContractor.name,
          siteName: created.name,
          developerName: developer?.name ?? 'A developer',
          token: invitationToken,
          isResend: false,
          address: created.address,
          latitude: Number(created.latitude),
          longitude: Number(created.longitude),
          constructionPhase: created.constructionPhase,
          developmentType: created.developmentType,
          expectedEndDate: created.expectedEndDate,
          landmarks: created.landmarks,
        })
        .catch((err) => {
          console.error('Failed to send contractor invitation email', err);
        });
    }

    if (personnelInvites.length) {
      const inviter = await this.prisma.user.findUnique({ where: { id: user.userId }, select: { name: true } });
      this.sendPersonnelInvites(personnelInvites, created.name, inviter?.name ?? 'A site manager');
    }

    const site = await this.findSiteOrThrow(created.id);
    return {
      ...site,
      contractorInvitationLink: invitationToken ? this.linkForToken(invitationToken, 'contractor') : undefined,
      personnelInvitationLinks: this.personnelInvitationLinks(personnelInvites),
    };
  }

  async update(id: string, dto: UpdateSiteDto, user: AuthenticatedUser, ip?: string) {
    const site = await this.findSiteOrThrow(id);
    await this.assertOwnerOrAdmin(site, user);
    let personnelInvites: PendingPersonnelInvite[] = [];

    await this.prisma.$transaction(async (tx) => {
      await tx.site.update({
        where: { id },
        data: {
          name: dto.name,
          latitude: dto.latitude,
          longitude: dto.longitude,
          geofenceRadius: dto.geofenceRadius,
          address: dto.address,
          constructionPhase: dto.constructionPhase,
          status: dto.status,
          developmentType: dto.developmentType,
          country: dto.country,
          county: dto.county,
          constituency: dto.constituency,
          town: dto.town,
          plotNumber: dto.plotNumber,
          expectedEndDate: dto.expectedEndDate ? new Date(dto.expectedEndDate) : undefined,
          landmarks: dto.landmarks,
          approvals: dto.approvals as unknown as Prisma.InputJsonValue | undefined,
        },
      });

      if (dto.personnel) {
        // Reconcile against existing rows by id rather than deleting and
        // recreating everything: a wholesale replace would wipe every
        // matched row's invitation state (email/token/expiry/acceptedAt),
        // permanently invalidating a still-pending invite's emailed link
        // and resetting an already-accepted member's status back to
        // "expired" — on every ordinary edit, not just personnel changes.
        const existing = await tx.sitePersonnel.findMany({ where: { siteId: id } });
        const existingById = new Map(existing.map((p) => [p.id, p]));
        const submittedIds = new Set(dto.personnel.map((p) => p.id).filter((pid): pid is string => Boolean(pid)));

        const removedIds = existing.filter((p) => !submittedIds.has(p.id)).map((p) => p.id);
        if (removedIds.length) {
          await tx.sitePersonnel.deleteMany({ where: { id: { in: removedIds } } });
        }

        const newEntries: SitePersonnelInputDto[] = [];
        for (const p of dto.personnel) {
          const match = p.id ? existingById.get(p.id) : undefined;
          if (match) {
            // Never touch invitation-tracking fields for a matched row —
            // changing an invited email/resending is a separate, explicit
            // action (the dedicated resend endpoint, or remove-and-re-add).
            await tx.sitePersonnel.update({
              where: { id: match.id },
              data: { role: p.role, userId: p.userId, name: p.name, contact: p.contact },
            });
          } else {
            newEntries.push(p);
          }
        }

        if (newEntries.length) {
          const { rows, invites } = this.buildPersonnelRows(newEntries, id);
          personnelInvites = invites;
          await tx.sitePersonnel.createMany({ data: rows });
        }
      }
    });

    await this.auditLogService.log(
      user.userId,
      'site.updated',
      'Site',
      id,
      { ...dto } as unknown as Prisma.InputJsonValue,
      ip,
    );

    if (personnelInvites.length) {
      const inviter = await this.prisma.user.findUnique({ where: { id: user.userId }, select: { name: true } });
      this.sendPersonnelInvites(personnelInvites, dto.name ?? site.name, inviter?.name ?? 'A site manager');
    }

    const updated = await this.findSiteOrThrow(id);
    return { ...updated, personnelInvitationLinks: this.personnelInvitationLinks(personnelInvites) };
  }

  // Deliberately add-only and separate from update(): any contractor/developer
  // already tied to the site (not just its owner or the linked DEVELOPER
  // entry) can grow the roster this way, but editing/removing existing
  // personnel — and every other site field — still requires being the
  // owner, the linked developer, or an administrator via update()/remove().
  async addPersonnel(id: string, entries: SitePersonnelInputDto[], user: AuthenticatedUser, ip?: string) {
    const site = await this.findSiteOrThrow(id);

    if (!user.roles.includes('administrator')) {
      const hasEligibleRole = user.roles.includes('contractor') || user.roles.includes('developer');
      const tied = hasEligibleRole && (await this.isTiedToSite(id, user.userId));
      if (!tied) {
        throw new ForbiddenException(
          'You must be a contractor or developer already tied to this site to add personnel',
        );
      }
    }

    const { rows, invites } = this.buildPersonnelRows(entries, id);
    await this.prisma.sitePersonnel.createMany({ data: rows });

    await this.auditLogService.log(user.userId, 'site.personnel_added', 'Site', id, { count: rows.length }, ip);

    if (invites.length) {
      const inviter = await this.prisma.user.findUnique({ where: { id: user.userId }, select: { name: true } });
      this.sendPersonnelInvites(invites, site.name, inviter?.name ?? 'A site manager');
    }

    const updated = await this.findSiteOrThrow(id);
    return { ...updated, personnelInvitationLinks: this.personnelInvitationLinks(invites) };
  }

  async remove(id: string, user: AuthenticatedUser, ip?: string) {
    const site = await this.findSiteOrThrow(id);
    await this.assertOwnerOrAdmin(site, user);

    await this.prisma.site.delete({ where: { id } });

    await this.auditLogService.log(user.userId, 'site.deleted', 'Site', id, undefined, ip);
  }

  async setPublicSharing(id: string, enabled: boolean, user: AuthenticatedUser, ip?: string) {
    const site = await this.findSiteOrThrow(id);
    await this.assertOwnerOrAdmin(site, user);

    await this.prisma.site.update({ where: { id }, data: { isPubliclyShared: enabled } });

    await this.auditLogService.log(
      user.userId,
      enabled ? 'site.public_sharing_enabled' : 'site.public_sharing_disabled',
      'Site',
      id,
      undefined,
      ip,
    );
  }

  isWithinGeofence(lat: number, lon: number, site: Site): boolean {
    const radiusMeters = site.geofenceRadius ?? 500;
    const distanceMeters = this.haversineDistanceMeters(lat, lon, Number(site.latitude), Number(site.longitude));
    return distanceMeters <= radiusMeters;
  }

  findWithinRadius(lat: number, lon: number, radiusMeters: number) {
    return this.prisma.$queryRaw<SiteWithinRadiusRow[]>`
      SELECT
        id,
        name,
        address,
        latitude,
        longitude,
        "geofenceRadius",
        ST_Distance(location, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography) AS "distanceMeters"
      FROM "Site"
      WHERE ST_DWithin(location, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography, ${radiusMeters})
      ORDER BY "distanceMeters" ASC
    `;
  }

  async isTiedToSite(siteId: string, userId: string): Promise<boolean> {
    const site = await this.prisma.site.findUnique({ where: { id: siteId }, select: { contractorId: true } });
    if (!site) {
      return false;
    }
    if (site.contractorId === userId) {
      return true;
    }
    const personnel = await this.prisma.sitePersonnel.findFirst({ where: { siteId, userId } });
    return !!personnel;
  }

  async resolveTiedSiteIds(userId: string): Promise<string[]> {
    const [personnelSites, ownedSites] = await Promise.all([
      this.prisma.sitePersonnel.findMany({ where: { userId }, select: { siteId: true } }),
      this.prisma.site.findMany({ where: { contractorId: userId }, select: { id: true } }),
    ]);
    const ids = new Set<string>();
    personnelSites.forEach((p) => ids.add(p.siteId));
    ownedSites.forEach((s) => ids.add(s.id));
    return [...ids];
  }

  async findMapPins(user: AuthenticatedUser): Promise<MapPin[]> {
    const where = user.roles.includes('administrator')
      ? {}
      : { id: { in: await this.resolveTiedSiteIds(user.userId) } };

    const sites = await this.prisma.site.findMany({
      where,
      select: {
        id: true,
        name: true,
        latitude: true,
        longitude: true,
        status: true,
        address: true,
        constructionPhase: true,
      },
    });

    return sites.map((site) => ({
      id: site.id,
      name: site.name,
      latitude: Number(site.latitude),
      longitude: Number(site.longitude),
      status: site.status,
      address: site.address,
      constructionPhase: site.constructionPhase,
    }));
  }

  private haversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (deg: number) => (deg * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

    return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private async resolveContractorId(
    dto: CreateSiteDto,
    user: AuthenticatedUser,
  ): Promise<{ contractorId: string; pendingContractor?: { userId?: string; email: string; name: string } }> {
    if (user.roles.includes('administrator')) {
      if (!dto.contractorId) {
        throw new ForbiddenException('contractorId is required when an administrator creates a site');
      }
      return { contractorId: dto.contractorId };
    }

    if (user.roles.includes('contractor')) {
      if (dto.contractorId && dto.contractorId !== user.userId) {
        throw new ForbiddenException('Cannot create a site for another contractor');
      }
      return { contractorId: user.userId };
    }

    const contractorEntry = dto.personnel?.find((p) => p.role === 'CONTRACTOR');
    if (!contractorEntry) {
      throw new BadRequestException(
        'A contractor must be assigned via personnel when registering a site as a developer',
      );
    }

    if (contractorEntry.userId) {
      const invitedUser = await this.prisma.user.findFirst({
        where: { id: contractorEntry.userId, roles: { some: { role: 'contractor' } } },
        select: { id: true, email: true, name: true },
      });
      if (!invitedUser) {
        throw new BadRequestException('The linked personnel account must have the contractor role');
      }
      return {
        contractorId: user.userId,
        pendingContractor: { userId: invitedUser.id, email: invitedUser.email, name: invitedUser.name },
      };
    }

    // Freeform contractor — the DTO validator already guarantees an email is
    // present for this role, since site ownership can't transfer to no one.
    return {
      contractorId: user.userId,
      pendingContractor: { email: contractorEntry.email!, name: contractorEntry.name! },
    };
  }

  // Builds the SitePersonnel rows for create()/update(), generating a signup
  // invitation token for any freeform, non-contractor entry that requested
  // one. IDs are pre-assigned so the invite tokens can be persisted in the
  // same createMany call, matching this row up with its emailed link.
  private buildPersonnelRows(personnel: SitePersonnelInputDto[] | undefined, siteId: string) {
    const invites: PendingPersonnelInvite[] = [];
    const rows = (personnel ?? []).map((p) => {
      const wantsInvite = p.role !== 'CONTRACTOR' && p.sendInvite && p.email && !p.userId;
      let invitationTokenHash: string | undefined;
      let invitationExpiresAt: Date | undefined;
      if (wantsInvite) {
        const token = generateToken();
        invitationTokenHash = hashToken(token);
        invitationExpiresAt = new Date(Date.now() + CONTRACTOR_INVITATION_TTL_MS);
        invites.push({ name: p.name!, role: p.role, email: p.email!, token });
      }
      return {
        siteId,
        role: p.role,
        userId: p.userId,
        name: p.name,
        contact: p.contact,
        email: wantsInvite ? p.email : undefined,
        invitationTokenHash,
        invitationExpiresAt,
      };
    });
    return { rows, invites };
  }

  private sendPersonnelInvites(invites: PendingPersonnelInvite[], siteName: string, invitedByName: string) {
    for (const invite of invites) {
      this.mailService
        .sendPersonnelInvitation({
          to: invite.email,
          name: invite.name,
          role: invite.role,
          siteName,
          invitedByName,
          token: invite.token,
          isResend: false,
        })
        .catch((err) => {
          console.error('Failed to send personnel invitation email', err);
        });
    }
  }

  private async assertOwnerOrAdmin(site: Site, user: AuthenticatedUser) {
    if (site.contractorId === user.userId || user.roles.includes('administrator')) {
      return;
    }
    const isLinkedDeveloper = await this.prisma.sitePersonnel.findFirst({
      where: { siteId: site.id, userId: user.userId, role: 'DEVELOPER' },
    });
    if (!isLinkedDeveloper) {
      throw new ForbiddenException('You do not own this site');
    }
  }

  private async findSiteOrThrow(id: string) {
    const site = await this.prisma.site.findUnique({
      where: { id },
      include: { contractor: { select: CONTRACTOR_SELECT }, ...PERSONNEL_INCLUDE },
    });
    if (!site) {
      throw new NotFoundException('Site not found');
    }
    return site;
  }
}
