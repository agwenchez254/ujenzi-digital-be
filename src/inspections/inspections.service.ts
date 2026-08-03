import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Inspection, Prisma, Site } from '@prisma/client';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { PrismaService } from '../prisma/prisma.service';
import { SitesService } from '../sites/sites.service';
import { CreateInspectionDto } from './dto/create-inspection.dto';
import { SubmitInspectionDto } from './dto/submit-inspection.dto';
import { UpdateInspectionDto } from './dto/update-inspection.dto';

const INSPECTION_INCLUDE = {
  site: { select: { id: true, name: true, address: true } },
  engineer: { select: { id: true, name: true } },
} as const;

@Injectable()
export class InspectionsService {
  constructor(
    private prisma: PrismaService,
    private sitesService: SitesService,
    private auditLogService: AuditLogService,
  ) {}

  findAll() {
    return this.prisma.inspection.findMany({
      include: INSPECTION_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });
  }

  findOne(id: string) {
    return this.findInspectionOrThrow(id);
  }

  async create(dto: CreateInspectionDto, user: AuthenticatedUser, ip?: string) {
    const request = await this.prisma.inspectionRequest.findUnique({
      where: { id: dto.requestId },
      include: { site: true },
    });
    if (!request) {
      throw new NotFoundException('Inspection request not found');
    }
    if (request.status !== 'accepted') {
      throw new ConflictException('Only an accepted request can be started');
    }
    this.assertAssignedEngineerOrAdmin(request.engineerId, user);
    this.assertWithinGeofence(dto.latitude, dto.longitude, request.site);

    // Accepted requests always have engineerId set (InspectionRequestsService.accept).
    const [inspection] = await this.prisma.$transaction([
      this.prisma.inspection.create({
        data: {
          requestId: request.id,
          siteId: request.siteId,
          engineerId: request.engineerId!,
          status: 'in_progress',
          startTime: new Date(),
          latitude: dto.latitude,
          longitude: dto.longitude,
        },
        include: INSPECTION_INCLUDE,
      }),
      this.prisma.inspectionRequest.update({
        where: { id: request.id },
        data: { status: 'in_progress' },
      }),
    ]);

    await this.auditLogService.log(
      user.userId,
      'inspection.started',
      'Inspection',
      inspection.id,
      { requestId: request.id },
      ip,
    );

    return inspection;
  }

  async update(id: string, dto: UpdateInspectionDto, user: AuthenticatedUser, ip?: string) {
    const inspection = await this.findInspectionOrThrow(id);
    this.assertOwnerOrAdmin(inspection, user);
    this.assertInProgress(inspection);

    const updated = await this.prisma.inspection.update({
      where: { id },
      data: {
        notes: dto.notes,
        observations: dto.observations,
        recommendations: dto.recommendations,
        riskLevel: dto.riskLevel,
        checklistResponses: dto.checklistResponses as unknown as Prisma.InputJsonValue | undefined,
      },
      include: INSPECTION_INCLUDE,
    });

    await this.auditLogService.log(
      user.userId,
      'inspection.updated',
      'Inspection',
      id,
      { ...dto } as unknown as Prisma.InputJsonValue,
      ip,
    );

    return updated;
  }

  async submit(id: string, dto: SubmitInspectionDto, user: AuthenticatedUser, ip?: string) {
    const inspection = await this.findInspectionOrThrow(id);
    this.assertOwnerOrAdmin(inspection, user);

    if (inspection.status !== 'in_progress') {
      throw new ConflictException('Only an in-progress inspection can be submitted');
    }

    const site = await this.prisma.site.findUniqueOrThrow({ where: { id: inspection.siteId } });
    this.assertWithinGeofence(dto.latitude, dto.longitude, site);

    const [updated] = await this.prisma.$transaction([
      this.prisma.inspection.update({
        where: { id },
        data: {
          notes: dto.notes,
          observations: dto.observations,
          recommendations: dto.recommendations,
          riskLevel: dto.riskLevel,
          checklistResponses: dto.checklistResponses as unknown as Prisma.InputJsonValue | undefined,
          latitude: dto.latitude,
          longitude: dto.longitude,
          endTime: new Date(),
          status: 'submitted',
        },
        include: INSPECTION_INCLUDE,
      }),
      this.prisma.inspectionRequest.update({
        where: { id: inspection.requestId },
        data: { status: 'completed' },
      }),
    ]);

    await this.auditLogService.log(
      user.userId,
      'inspection.submitted',
      'Inspection',
      id,
      { ...dto } as unknown as Prisma.InputJsonValue,
      ip,
    );

    return updated;
  }

  private assertAssignedEngineerOrAdmin(engineerId: string | null, user: AuthenticatedUser) {
    if (user.roles.includes('administrator')) {
      return;
    }
    if (engineerId !== user.userId) {
      throw new ForbiddenException('Only the assigned engineer can start this inspection');
    }
  }

  private assertOwnerOrAdmin(inspection: Inspection, user: AuthenticatedUser) {
    if (inspection.engineerId !== user.userId && !user.roles.includes('administrator')) {
      throw new ForbiddenException('You do not own this inspection');
    }
  }

  private assertInProgress(inspection: Inspection) {
    if (inspection.status !== 'in_progress') {
      throw new ForbiddenException('This inspection can no longer be edited');
    }
  }

  private assertWithinGeofence(lat: number, lon: number, site: Site) {
    if (!this.sitesService.isWithinGeofence(lat, lon, site)) {
      throw new ForbiddenException("Outside the site's geofence");
    }
  }

  private async findInspectionOrThrow(id: string) {
    const inspection = await this.prisma.inspection.findUnique({
      where: { id },
      include: INSPECTION_INCLUDE,
    });
    if (!inspection) {
      throw new NotFoundException('Inspection not found');
    }
    return inspection;
  }
}
