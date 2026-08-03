import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InspectionRequest } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { PrismaService } from '../prisma/prisma.service';
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
  ) {}

  findAll(user: AuthenticatedUser) {
    const canSeeAll = this.canSeeAll(user);

    return this.prisma.inspectionRequest.findMany({
      where: canSeeAll ? undefined : { contractorId: user.userId },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, user: AuthenticatedUser) {
    const request = await this.findRequestOrThrow(id);
    this.assertCanRead(request, user);
    return request;
  }

  async create(dto: CreateInspectionRequestDto, user: AuthenticatedUser, ip?: string) {
    const contractorId = this.resolveContractorId(dto.contractorId, user);
    await this.assertSiteExists(dto.siteId);

    const request = await this.prisma.inspectionRequest.create({
      data: {
        siteId: dto.siteId,
        contractorId,
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
      { siteId: dto.siteId, contractorId },
      ip,
    );

    return request;
  }

  async update(id: string, dto: UpdateInspectionRequestDto, user: AuthenticatedUser, ip?: string) {
    const request = await this.findRequestOrThrow(id);
    this.assertCanEdit(request, user);

    if (dto.siteId) {
      await this.assertSiteExists(dto.siteId);
    }

    const updated = await this.prisma.inspectionRequest.update({
      where: { id },
      data: {
        siteId: dto.siteId,
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

    return updated;
  }

  private canSeeAll(user: AuthenticatedUser): boolean {
    return user.roles.includes('engineer') || user.roles.includes('administrator');
  }

  private resolveContractorId(dtoContractorId: string | undefined, user: AuthenticatedUser): string {
    const isAdmin = user.roles.includes('administrator');

    if (isAdmin) {
      if (!dtoContractorId) {
        throw new ForbiddenException(
          'contractorId is required when an administrator creates an inspection request',
        );
      }
      return dtoContractorId;
    }

    if (dtoContractorId && dtoContractorId !== user.userId) {
      throw new ForbiddenException('Cannot create an inspection request for another contractor');
    }

    return user.userId;
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

  private assertCanRead(request: InspectionRequest, user: AuthenticatedUser) {
    if (!this.canSeeAll(user) && request.contractorId !== user.userId) {
      throw new ForbiddenException('You do not have access to this inspection request');
    }
  }

  private assertCanEdit(request: InspectionRequest, user: AuthenticatedUser) {
    if (user.roles.includes('administrator')) {
      return;
    }
    if (request.contractorId !== user.userId) {
      throw new ForbiddenException('You do not own this inspection request');
    }
    if (request.status !== 'pending') {
      throw new ForbiddenException('This request can no longer be edited');
    }
  }

  private async assertSiteExists(siteId: string) {
    const site = await this.prisma.site.findUnique({ where: { id: siteId } });
    if (!site) {
      throw new NotFoundException('Site not found');
    }
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
