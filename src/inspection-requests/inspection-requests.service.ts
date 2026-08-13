import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InspectionRequest, Site } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeEventsService } from '../realtime/realtime-events.service';
import { SitesService } from '../sites/sites.service';
import { AcceptInspectionRequestDto } from './dto/accept-inspection-request.dto';
import { CreateInspectionRequestDto } from './dto/create-inspection-request.dto';
import { UpdateInspectionRequestDto } from './dto/update-inspection-request.dto';

const REQUEST_INCLUDE = {
  site: {
    select: { id: true, name: true, address: true, latitude: true, longitude: true, geofenceRadius: true },
  },
  contractor: { select: { id: true, name: true, company: true } },
  engineer: { select: { id: true, name: true } },
} as const;

@Injectable()
export class InspectionRequestsService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
    private realtimeEventsService: RealtimeEventsService,
    private sitesService: SitesService,
  ) {}

  async findAll(user: AuthenticatedUser) {
    if (this.canSeeAll(user)) {
      return this.prisma.inspectionRequest.findMany({
        include: REQUEST_INCLUDE,
        orderBy: { createdAt: 'desc' },
      });
    }
    const siteIds = await this.sitesService.resolveTiedSiteIds(user.userId);
    return this.prisma.inspectionRequest.findMany({
      where: { siteId: { in: siteIds } },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const request = await this.findRequestOrThrow(id);
    await this.assertCanRead(request, user);
    return request;
  }

  async create(dto: CreateInspectionRequestDto, user: AuthenticatedUser, ip?: string) {
    const site = await this.findSiteOrThrow(dto.siteId);
    await this.assertTiedOrAdmin(site.id, user);

    const request = await this.prisma.inspectionRequest.create({
      data: {
        siteId: dto.siteId,
        contractorId: site.contractorId,
        requestedDate: new Date(dto.requestedDate),
        notes: dto.notes,
      },
      include: REQUEST_INCLUDE,
    });

    await this.auditLogService.log(
      user.userId,
      'inspection_request.created',
      'InspectionRequest',
      request.id,
      { siteId: dto.siteId, contractorId: site.contractorId },
      ip,
    );

    await this.realtimeEventsService.emit(
      'inspection-request.created',
      request,
      { siteIds: [request.siteId], roles: ['engineer', 'administrator'] },
      { title: 'New inspection request', body: `${request.site.name} — requested by ${request.contractor.name}` },
    );

    return request;
  }

  async update(id: string, dto: UpdateInspectionRequestDto, user: AuthenticatedUser, ip?: string) {
    const request = await this.findRequestOrThrow(id);
    await this.assertCanEdit(request, user);

    let contractorId: string | undefined;
    if (dto.siteId) {
      const site = await this.findSiteOrThrow(dto.siteId);
      await this.assertTiedOrAdmin(site.id, user);
      contractorId = site.contractorId;
    }

    const updated = await this.prisma.inspectionRequest.update({
      where: { id },
      data: {
        siteId: dto.siteId,
        contractorId,
        notes: dto.notes,
        requestedDate: dto.requestedDate ? new Date(dto.requestedDate) : undefined,
      },
      include: REQUEST_INCLUDE,
    });

    await this.auditLogService.log(user.userId, 'inspection_request.updated', 'InspectionRequest', id, { ...dto }, ip);

    return updated;
  }

  async accept(id: string, dto: AcceptInspectionRequestDto, user: AuthenticatedUser, ip?: string) {
    const request = await this.findRequestOrThrow(id);
    this.assertPending(request);
    const engineerId = this.resolveEngineerId(dto, user);

    const updated = await this.prisma.inspectionRequest.update({
      where: { id },
      data: { status: 'accepted', engineerId },
      include: REQUEST_INCLUDE,
    });

    await this.auditLogService.log(
      user.userId,
      'inspection_request.accepted',
      'InspectionRequest',
      id,
      { engineerId },
      ip,
    );

    await this.realtimeEventsService.emit(
      'inspection-request.accepted',
      updated,
      { siteIds: [updated.siteId] },
      {
        title: 'Inspection request accepted',
        body: `${updated.site.name} — accepted by ${updated.engineer?.name ?? 'an engineer'}`,
      },
    );

    return updated;
  }

  async reject(id: string, user: AuthenticatedUser, ip?: string) {
    const request = await this.findRequestOrThrow(id);
    this.assertPending(request);

    const updated = await this.prisma.inspectionRequest.update({
      where: { id },
      data: { status: 'rejected' },
      include: REQUEST_INCLUDE,
    });

    await this.auditLogService.log(user.userId, 'inspection_request.rejected', 'InspectionRequest', id, undefined, ip);

    await this.realtimeEventsService.emit(
      'inspection-request.rejected',
      updated,
      { siteIds: [updated.siteId] },
      { title: 'Inspection request rejected', body: updated.site.name },
    );

    return updated;
  }

  private canSeeAll(user: AuthenticatedUser): boolean {
    return user.roles.includes('engineer') || user.roles.includes('administrator');
  }

  private async assertTiedOrAdmin(siteId: string, user: AuthenticatedUser) {
    if (user.roles.includes('administrator')) {
      return;
    }
    const tied = await this.sitesService.isTiedToSite(siteId, user.userId);
    if (!tied) {
      throw new ForbiddenException('You are not tied to this site');
    }
  }

  private resolveEngineerId(dto: AcceptInspectionRequestDto, user: AuthenticatedUser): string {
    if (user.roles.includes('administrator')) {
      if (!dto.engineerId) {
        throw new ForbiddenException('engineerId is required when an administrator accepts a request');
      }
      return dto.engineerId;
    }
    return user.userId;
  }

  private assertPending(request: InspectionRequest) {
    if (request.status !== 'pending') {
      throw new ConflictException('Only pending requests can be accepted or rejected');
    }
  }

  private async assertCanRead(request: InspectionRequest, user: AuthenticatedUser) {
    if (this.canSeeAll(user)) {
      return;
    }
    if (!(await this.sitesService.isTiedToSite(request.siteId, user.userId))) {
      throw new ForbiddenException('You do not have access to this inspection request');
    }
  }

  private async assertCanEdit(request: InspectionRequest, user: AuthenticatedUser) {
    if (user.roles.includes('administrator')) {
      return;
    }
    if (!(await this.sitesService.isTiedToSite(request.siteId, user.userId))) {
      throw new ForbiddenException('You do not have access to this inspection request');
    }
    if (request.status !== 'pending') {
      throw new ForbiddenException('This request can no longer be edited');
    }
  }

  private async findSiteOrThrow(siteId: string): Promise<Site> {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new NotFoundException('Site not found');
    }
    return site;
  }

  private async findRequestOrThrow(id: string) {
    const request = await this.prisma.inspectionRequest.findUnique({
      where: { id },
      include: REQUEST_INCLUDE,
    });
    if (!request) {
      throw new NotFoundException('Inspection request not found');
    }
    return request;
  }
}
