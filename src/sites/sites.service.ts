import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Site } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';

const CONTRACTOR_SELECT = { id: true, name: true, company: true } as const;
const EARTH_RADIUS_METERS = 6_371_000;

@Injectable()
export class SitesService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
  ) {}

  findAll() {
    return this.prisma.site.findMany({
      include: { contractor: { select: CONTRACTOR_SELECT } },
      orderBy: { createdAt: 'desc' },
    });
  }

  findOne(id: string) {
    return this.findSiteOrThrow(id);
  }

  async create(dto: CreateSiteDto, user: AuthenticatedUser, ip?: string) {
    const contractorId = this.resolveContractorId(dto.contractorId, user);

    const site = await this.prisma.site.create({
      data: {
        name: dto.name,
        contractorId,
        latitude: dto.latitude,
        longitude: dto.longitude,
        geofenceRadius: dto.geofenceRadius,
        address: dto.address,
        constructionPhase: dto.constructionPhase,
      },
      include: { contractor: { select: CONTRACTOR_SELECT } },
    });

    await this.auditLogService.log(user.userId, 'site.created', 'Site', site.id, { contractorId }, ip);

    return site;
  }

  async update(id: string, dto: UpdateSiteDto, user: AuthenticatedUser, ip?: string) {
    const site = await this.findSiteOrThrow(id);
    this.assertOwnerOrAdmin(site, user);

    const updated = await this.prisma.site.update({
      where: { id },
      data: dto,
      include: { contractor: { select: CONTRACTOR_SELECT } },
    });

    await this.auditLogService.log(user.userId, 'site.updated', 'Site', id, { ...dto }, ip);

    return updated;
  }

  async remove(id: string, user: AuthenticatedUser, ip?: string) {
    const site = await this.findSiteOrThrow(id);
    this.assertOwnerOrAdmin(site, user);

    await this.prisma.site.delete({ where: { id } });

    await this.auditLogService.log(user.userId, 'site.deleted', 'Site', id, undefined, ip);
  }

  isWithinGeofence(lat: number, lon: number, site: Site): boolean {
    const radiusMeters = site.geofenceRadius ?? 100;
    const distanceMeters = this.haversineDistanceMeters(lat, lon, Number(site.latitude), Number(site.longitude));
    return distanceMeters <= radiusMeters;
  }

  private haversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (deg: number) => (deg * Math.PI) / 180;

    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
      Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;

    return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  private resolveContractorId(dtoContractorId: string | undefined, user: AuthenticatedUser): string {
    const isAdmin = user.roles.includes('administrator');

    if (isAdmin) {
      if (!dtoContractorId) {
        throw new ForbiddenException('contractorId is required when an administrator creates a site');
      }
      return dtoContractorId;
    }

    if (dtoContractorId && dtoContractorId !== user.userId) {
      throw new ForbiddenException('Cannot create a site for another contractor');
    }

    return user.userId;
  }

  private assertOwnerOrAdmin(site: Site, user: AuthenticatedUser) {
    if (site.contractorId !== user.userId && !user.roles.includes('administrator')) {
      throw new ForbiddenException('You do not own this site');
    }
  }

  private async findSiteOrThrow(id: string) {
    const site = await this.prisma.site.findUnique({
      where: { id },
      include: { contractor: { select: CONTRACTOR_SELECT } },
    });
    if (!site) {
      throw new NotFoundException('Site not found');
    }
    return site;
  }
}
