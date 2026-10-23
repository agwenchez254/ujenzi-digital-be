import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InspectionRequest, Site } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { MailService } from '../mail/mail.service';
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
  engineer: { select: { id: true, name: true, avatarUrl: true } },
  // At most one Inspection is ever active per request in practice (starting one
  // flips the request off `accepted`), so the most recent row is "the" inspection.
  inspections: {
    take: 1,
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      media: {
        take: 4,
        orderBy: { createdAt: 'desc' },
        select: { id: true, type: true },
      },
      _count: { select: { media: true } },
    },
  },
} as const;

@Injectable()
export class InspectionRequestsService {
  constructor(
    private prisma: PrismaService,
    private auditLogService: AuditLogService,
    private realtimeEventsService: RealtimeEventsService,
    private sitesService: SitesService,
    private mailService: MailService,
  ) {}

  async findAll(user: AuthenticatedUser) {
    if (this.canSeeAll(user)) {
      return this.prisma.inspectionRequest.findMany({
        where: { site: { deletedAt: null } },
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

    const assignedEngineer = await this.findEngineerOrThrow(dto.engineerId);

    const request = await this.prisma.inspectionRequest.create({
      data: {
        siteId: dto.siteId,
        contractorId: site.contractorId,
        engineerId: assignedEngineer.id,
        requestedByUserId: user.userId,
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
      { siteId: dto.siteId, contractorId: site.contractorId, engineerId: assignedEngineer.id },
      ip,
    );

    // Only engineers (who might pick it up) and admins need to know a request
    // exists — the site's own contractor/personnel already know, they just
    // made it. No siteIds target here on purpose: that would fan this out to
    // everyone tied to the site, not just the people who can act on it.
    await this.realtimeEventsService.emit(
      'inspection-request.created',
      request,
      { userIds: [assignedEngineer.id], roles: ['administrator'] },
      {
        title: "You've been requested for an inspection",
        body: `${request.site.name} — requested by ${request.contractor.name}`,
        url: '/inspections',
      },
    );

    await this.mailService.sendInspectionAssignmentEmail({
      to: assignedEngineer.email,
      engineerName: assignedEngineer.name,
      siteName: request.site.name,
      siteAddress: request.site.address,
      requestedByName: request.contractor.name,
      requestedDate: request.requestedDate,
      notes: request.notes,
    });

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

    // Only a request nobody has acted on yet can be handed to a different engineer;
    // after that the accepting engineer owns it.
    const engineerChanged = Boolean(dto.engineerId) && dto.engineerId !== request.engineerId;
    if (engineerChanged && request.status !== 'pending') {
      throw new ConflictException('The engineer can only be changed while the request is pending');
    }
    const newEngineer = engineerChanged ? await this.findEngineerOrThrow(dto.engineerId as string) : null;

    const updated = await this.prisma.inspectionRequest.update({
      where: { id },
      data: {
        siteId: dto.siteId,
        contractorId,
        engineerId: newEngineer?.id,
        notes: dto.notes,
        requestedDate: dto.requestedDate ? new Date(dto.requestedDate) : undefined,
      },
      include: REQUEST_INCLUDE,
    });

    await this.auditLogService.log(user.userId, 'inspection_request.updated', 'InspectionRequest', id, { ...dto }, ip);

    if (newEngineer) {
      await this.realtimeEventsService.emit(
        'inspection-request.reassigned',
        updated,
        { userIds: [newEngineer.id], roles: ['administrator'] },
        {
          title: "You've been requested for an inspection",
          body: `${updated.site.name} - requested by ${updated.contractor.name}`,
          url: '/inspections',
        },
      );
      await this.mailService.sendInspectionAssignmentEmail({
        to: newEngineer.email,
        engineerName: newEngineer.name,
        siteName: updated.site.name,
        siteAddress: updated.site.address,
        requestedByName: updated.contractor.name,
        requestedDate: updated.requestedDate,
        notes: updated.notes,
      });
      // The engineer who was chosen before should stop seeing it as theirs.
      if (request.engineerId) {
        await this.realtimeEventsService.emit(
          'inspection-request.unassigned',
          updated,
          { userIds: [request.engineerId] },
          {
            title: 'Inspection request reassigned',
            body: `${updated.site.name} was assigned to another engineer`,
            url: '/inspections',
          },
        );
      }
    }

    return updated;
  }

  async accept(id: string, dto: AcceptInspectionRequestDto, user: AuthenticatedUser, ip?: string) {
    const request = await this.findRequestOrThrow(id);
    this.assertPending(request);
    const engineerId = this.resolveEngineerId(dto, user, request);

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

    // Only the person who actually submitted the request needs to know it
    // was accepted — not every engineer who saw the original broadcast, and
    // not the site's other personnel.
    await this.realtimeEventsService.emit(
      'inspection-request.accepted',
      updated,
      { userIds: [updated.requestedByUserId ?? updated.contractorId] },
      {
        title: 'Inspection request accepted',
        body: `${updated.site.name} — accepted by ${updated.engineer?.name ?? 'an engineer'}`,
        url: `/inspections/${updated.id}`,
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
      { userIds: [updated.requestedByUserId ?? updated.contractorId] },
      { title: 'Inspection request rejected', body: updated.site.name, url: '/inspections' },
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

  private resolveEngineerId(dto: AcceptInspectionRequestDto, user: AuthenticatedUser, request: InspectionRequest): string {
    if (user.roles.includes('administrator')) {
      const engineerId = dto.engineerId ?? request.engineerId;
      if (!engineerId) {
        throw new ForbiddenException('engineerId is required when an administrator accepts a request');
      }
      return engineerId;
    }
    if (request.engineerId && request.engineerId !== user.userId) {
      throw new ForbiddenException('This request is already assigned to another engineer');
    }
    return user.userId;
  }

  private async findEngineerOrThrow(engineerId: string) {
    const engineer = await this.prisma.user.findUnique({
      where: { id: engineerId },
      include: { roles: true },
    });
    if (!engineer || engineer.status !== 'active' || !engineer.roles.some((r) => r.role === 'engineer')) {
      throw new NotFoundException('Engineer not found');
    }
    return { id: engineer.id, name: engineer.name, email: engineer.email };
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
    if (!site || site.deletedAt) {
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
