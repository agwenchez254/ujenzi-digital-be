import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { MediaService } from './media.service';

describe('MediaService.replace', () => {
  const engineer: AuthenticatedUser = { userId: 'engineer-1', roles: ['engineer'], permissions: [] };
  const otherEngineer: AuthenticatedUser = { userId: 'engineer-2', roles: ['engineer'], permissions: [] };
  const admin: AuthenticatedUser = { userId: 'admin-1', roles: ['administrator'], permissions: [] };

  const baseMedia = {
    id: 'media-1',
    inspectionId: 'inspection-1',
    type: 'photo',
    url: 'media/old-file.jpg',
    latitude: -1.29 as unknown,
    longitude: 36.82 as unknown,
    caption: 'Original caption',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  const baseInspection = {
    id: 'inspection-1',
    engineerId: 'engineer-1',
    siteId: 'site-1',
    status: 'in_progress',
  };

  const newFile = {
    buffer: Buffer.from('new-file-contents'),
    mimetype: 'image/png',
    originalname: 'replacement.png',
  } as Express.Multer.File;

  function buildService(overrides?: { mediaData?: object; inspectionData?: object }) {
    const media = { ...baseMedia, ...(overrides?.mediaData ?? {}) };
    const inspection = { ...baseInspection, ...(overrides?.inspectionData ?? {}) };

    const prisma = {
      media: {
        findUnique: jest.fn().mockResolvedValue(media),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...media, ...data })),
      },
      inspection: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(inspection),
      },
    };
    const storageService = {
      save: jest.fn().mockResolvedValue('media/new-file.png'),
      delete: jest.fn().mockResolvedValue(undefined),
      read: jest.fn(),
    };
    const auditLogService = { log: jest.fn().mockResolvedValue(undefined) };
    const sitesService = { isTiedToSite: jest.fn() };

    const service = new MediaService(
      prisma as never,
      storageService as never,
      auditLogService as never,
      sitesService as never,
    );

    return { service, prisma, storageService, auditLogService, media, inspection };
  }

  it('replaces the stored file and keeps the same media id, caption, and coordinates', async () => {
    const { service, prisma, storageService, auditLogService, media } = buildService();

    const result = await service.replace(media.id, newFile, engineer, '127.0.0.1');

    expect(storageService.delete).toHaveBeenCalledWith(media.url);
    expect(storageService.save).toHaveBeenCalledWith(newFile.buffer, 'media', expect.stringContaining('.png'));
    expect(prisma.media.update).toHaveBeenCalledWith({
      where: { id: media.id },
      data: { url: 'media/new-file.png', type: 'photo' },
    });
    expect(result.id).toBe(media.id);
    expect(result.caption).toBe(media.caption);
    expect(result.latitude).toBe(media.latitude);
    expect(result.url).toBe('media/new-file.png');
    expect(auditLogService.log).toHaveBeenCalledWith(
      engineer.userId,
      'media.replaced',
      'Media',
      media.id,
      { inspectionId: media.inspectionId },
      '127.0.0.1',
    );
  });

  it('throws NotFoundException when the media does not exist', async () => {
    const { service, prisma } = buildService();
    prisma.media.findUnique.mockResolvedValue(null);

    await expect(service.replace('missing-media', newFile, engineer)).rejects.toThrow(NotFoundException);
  });

  it('throws ForbiddenException when the caller is neither the owning engineer nor an administrator', async () => {
    const { service } = buildService();

    await expect(service.replace(baseMedia.id, newFile, otherEngineer)).rejects.toThrow(ForbiddenException);
  });

  it('allows an administrator to replace media they do not own', async () => {
    const { service, storageService } = buildService();

    await service.replace(baseMedia.id, newFile, admin);

    expect(storageService.save).toHaveBeenCalled();
  });

  it('throws ConflictException when the inspection is not in_progress', async () => {
    const { service } = buildService({ inspectionData: { status: 'submitted' } });

    await expect(service.replace(baseMedia.id, newFile, engineer)).rejects.toThrow(ConflictException);
  });
});
