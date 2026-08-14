import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Site } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { generateToken, hashToken } from '../common/utils/token.util';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';

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

@Injectable()
export class SitesService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
    private mailService: MailService,
  ) {}

  findAll() {
    return this.prisma.site.findMany({
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
        await tx.sitePersonnel.createMany({
          data: dto.personnel.map((p) => ({
            siteId: site.id,
            role: p.role,
            userId: p.userId,
            name: p.name,
            contact: p.contact,
          })),
        });
      }

      if (pendingContractor && invitationToken) {
        await tx.contractorInvitation.create({
          data: {
            siteId: site.id,
            invitedUserId: pendingContractor.userId,
            invitedById: user.userId,
            tokenHash: hashToken(invitationToken),
            expiresAt: new Date(Date.now() + CONTRACTOR_INVITATION_TTL_MS),
          },
        });
      }

      return site;
    });

    await this.auditLogService.log(user.userId, 'site.created', 'Site', created.id, { contractorId }, ip);

    if (pendingContractor && invitationToken) {
      await this.auditLogService.log(
        user.userId,
        'site.contractor_invited',
        'Site',
        created.id,
        { invitedUserId: pendingContractor.userId },
        ip,
      );
      const developer = await this.prisma.user.findUnique({ where: { id: user.userId }, select: { name: true } });
      this.mailService
        .sendContractorInvitation({
          to: pendingContractor.email,
          contractorName: pendingContractor.name,
          siteName: dto.name,
          developerName: developer?.name ?? 'A developer',
          token: invitationToken,
          isResend: false,
        })
        .catch((err) => {
          console.error('Failed to send contractor invitation email', err);
        });
    }

    return this.findSiteOrThrow(created.id);
  }

  async update(id: string, dto: UpdateSiteDto, user: AuthenticatedUser, ip?: string) {
    const site = await this.findSiteOrThrow(id);
    await this.assertOwnerOrAdmin(site, user);

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
        await tx.sitePersonnel.deleteMany({ where: { siteId: id } });
        if (dto.personnel.length) {
          await tx.sitePersonnel.createMany({
            data: dto.personnel.map((p) => ({
              siteId: id,
              role: p.role,
              userId: p.userId,
              name: p.name,
              contact: p.contact,
            })),
          });
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

    return this.findSiteOrThrow(id);
  }

  async remove(id: string, user: AuthenticatedUser, ip?: string) {
    const site = await this.findSiteOrThrow(id);
    await this.assertOwnerOrAdmin(site, user);

    await this.prisma.site.delete({ where: { id } });

    await this.auditLogService.log(user.userId, 'site.deleted', 'Site', id, undefined, ip);
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
  ): Promise<{ contractorId: string; pendingContractor?: { userId: string; email: string; name: string } }> {
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

    const contractorEntry = dto.personnel?.find((p) => p.role === 'CONTRACTOR' && p.userId);
    if (!contractorEntry?.userId) {
      throw new BadRequestException(
        'A contractor must be assigned via personnel (with a linked account) when registering a site as a developer',
      );
    }
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
