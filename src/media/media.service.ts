import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { PrismaService } from '../prisma/prisma.service';
import { SitesService } from '../sites/sites.service';
import { StorageService } from '../storage/storage.service';
import { UploadMediaDto } from './dto/upload-media.dto';

const MEDIA_NAMESPACE = 'media';

@Injectable()
export class MediaService {
  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
    private auditLogService: AuditLogService,
    private sitesService: SitesService,
  ) {}

  async findAllForInspection(inspectionId: string, user: AuthenticatedUser) {
    const inspection = await this.prisma.inspection.findUnique({ where: { id: inspectionId } });
    if (!inspection) {
      throw new NotFoundException('Inspection not found');
    }
    await this.assertCanView(inspection.siteId, inspection.engineerId, user);

    return this.prisma.media.findMany({
      where: { inspectionId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async upload(
    inspectionId: string,
    file: Express.Multer.File,
    dto: UploadMediaDto,
    user: AuthenticatedUser,
    ip?: string,
  ) {
    const inspection = await this.prisma.inspection.findUnique({ where: { id: inspectionId } });
    if (!inspection) {
      throw new NotFoundException('Inspection not found');
    }
    this.assertOwnerOrAdmin(inspection.engineerId, user);
    if (inspection.status !== 'in_progress') {
      throw new ConflictException('Media can only be added to an in-progress inspection');
    }

    const type = file.mimetype.startsWith('video/') ? 'video' : 'photo';
    const extension = path.extname(file.originalname);
    const filename = `${randomUUID()}${extension}`;
    const url = await this.storageService.save(file.buffer, MEDIA_NAMESPACE, filename);

    const media = await this.prisma.media.create({
      data: {
        inspectionId,
        type,
        url,
        latitude: dto.latitude,
        longitude: dto.longitude,
        caption: dto.caption,
      },
    });

    await this.auditLogService.log(user.userId, 'media.uploaded', 'Media', media.id, { inspectionId, type }, ip);

    return media;
  }

  async getFileStream(id: string, user: AuthenticatedUser) {
    const media = await this.findMediaOrThrow(id);
    const inspection = await this.prisma.inspection.findUniqueOrThrow({ where: { id: media.inspectionId } });
    await this.assertCanView(inspection.siteId, inspection.engineerId, user);

    return { stream: this.storageService.read(media.url), extension: path.extname(media.url) };
  }

  async replace(id: string, file: Express.Multer.File, user: AuthenticatedUser, ip?: string) {
    const media = await this.findMediaOrThrow(id);
    const inspection = await this.prisma.inspection.findUniqueOrThrow({ where: { id: media.inspectionId } });
    this.assertOwnerOrAdmin(inspection.engineerId, user);
    if (inspection.status !== 'in_progress') {
      throw new ConflictException('Media can only be replaced on an in-progress inspection');
    }

    const type = file.mimetype.startsWith('video/') ? 'video' : 'photo';
    const extension = path.extname(file.originalname);
    const filename = `${randomUUID()}${extension}`;
    const url = await this.storageService.save(file.buffer, MEDIA_NAMESPACE, filename);
    await this.storageService.delete(media.url);

    const updated = await this.prisma.media.update({ where: { id }, data: { url, type } });

    await this.auditLogService.log(user.userId, 'media.replaced', 'Media', id, { inspectionId: media.inspectionId }, ip);

    return updated;
  }

  async remove(id: string, user: AuthenticatedUser, ip?: string) {
    const media = await this.findMediaOrThrow(id);
    const inspection = await this.prisma.inspection.findUniqueOrThrow({ where: { id: media.inspectionId } });
    this.assertOwnerOrAdmin(inspection.engineerId, user);

    await this.storageService.delete(media.url);
    await this.prisma.media.delete({ where: { id } });

    await this.auditLogService.log(
      user.userId,
      'media.deleted',
      'Media',
      id,
      { inspectionId: media.inspectionId },
      ip,
    );
  }

  private assertOwnerOrAdmin(engineerId: string, user: AuthenticatedUser) {
    if (engineerId !== user.userId && !user.roles.includes('administrator')) {
      throw new ForbiddenException('You do not own this inspection');
    }
  }

  private async assertCanView(siteId: string, engineerId: string, user: AuthenticatedUser) {
    // Read-only for any engineer; uploads, replacements and deletes still require ownership.
    if (user.roles.includes('administrator') || user.roles.includes('engineer')) {
      return;
    }
    if (engineerId === user.userId) {
      return;
    }
    if (!(await this.sitesService.isTiedToSite(siteId, user.userId))) {
      throw new ForbiddenException('You do not have access to this inspection');
    }
  }

  private async findMediaOrThrow(id: string) {
    const media = await this.prisma.media.findUnique({ where: { id } });
    if (!media) {
      throw new NotFoundException('Media not found');
    }
    return media;
  }
}
