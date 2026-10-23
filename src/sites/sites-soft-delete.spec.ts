import { ConflictException, ForbiddenException } from '@nestjs/common';
import { SITE_RETENTION_DAYS, SitesService } from './sites.service';

const DAY_MS = 24 * 60 * 60 * 1000;

function build() {
  const prisma = {
    site: { findUnique: jest.fn(), update: jest.fn(), findMany: jest.fn(), delete: jest.fn() },
    sitePersonnel: { findFirst: jest.fn() },
    inspectionRequest: { count: jest.fn() },
    inspection: { count: jest.fn() },
    media: { findMany: jest.fn() },
    chatAttachment: { findMany: jest.fn() },
    siteDocument: { findMany: jest.fn() },
  };
  const audit = { log: jest.fn() };
  const storage = { delete: jest.fn().mockResolvedValue(undefined) };
  const service = new SitesService(
    prisma as never,
    audit as never,
    {} as never,
    {} as never,
    {} as never,
    storage as never,
  );
  return { prisma, audit, storage, service };
}

const owner = { userId: 'owner', roles: ['contractor'], permissions: [] } as never;
const admin = { userId: 'admin', roles: ['administrator'], permissions: [] } as never;
const site = { id: 's1', contractorId: 'owner', deletedAt: null, personnel: [] };

describe('SitesService.remove (soft delete)', () => {
  it('lets an owner delete a site with no work in progress, without removing any rows', async () => {
    const { prisma, service } = build();
    prisma.site.findUnique.mockResolvedValue(site);
    prisma.inspectionRequest.count.mockResolvedValue(0);
    prisma.inspection.count.mockResolvedValue(0);

    const result = await service.remove('s1', owner);

    expect(prisma.site.delete).not.toHaveBeenCalled();
    const data = prisma.site.update.mock.calls[0][0].data;
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(data.deletedById).toBe('owner');
    expect(new Date(result.purgeAt).getTime() - data.deletedAt.getTime()).toBe(SITE_RETENTION_DAYS * DAY_MS);
  });

  it('stops an owner deleting a site that has inspections in progress', async () => {
    const { prisma, service } = build();
    prisma.site.findUnique.mockResolvedValue(site);
    prisma.inspectionRequest.count.mockResolvedValue(1);
    prisma.inspection.count.mockResolvedValue(0);

    await expect(service.remove('s1', owner)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.site.update).not.toHaveBeenCalled();
  });

  it('lets an administrator delete a site with work in progress (still a soft delete)', async () => {
    const { prisma, audit, service } = build();
    prisma.site.findUnique.mockResolvedValue(site);
    prisma.inspectionRequest.count.mockResolvedValue(2);
    prisma.inspection.count.mockResolvedValue(1);

    await service.remove('s1', admin);

    expect(prisma.site.delete).not.toHaveBeenCalled();
    expect(prisma.site.update).toHaveBeenCalled();
    expect(audit.log.mock.calls[0][4]).toMatchObject({ ongoingWork: 3 });
  });
});

describe('SitesService.restore', () => {
  it('restores a site inside the retention window', async () => {
    const { prisma, service } = build();
    prisma.site.findUnique.mockResolvedValue({ ...site, deletedAt: new Date(Date.now() - 5 * DAY_MS) });
    await service.restore('s1', admin);
    expect(prisma.site.update).toHaveBeenCalledWith({ where: { id: 's1' }, data: { deletedAt: null, deletedById: null } });
  });

  it('refuses once the 30 days are over', async () => {
    const { prisma, service } = build();
    prisma.site.findUnique.mockResolvedValue({ ...site, deletedAt: new Date(Date.now() - 31 * DAY_MS) });
    await expect(service.restore('s1', admin)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('SitesService.purgeExpired', () => {
  it('deletes expired sites and then their files', async () => {
    const { prisma, storage, service } = build();
    prisma.site.findMany.mockResolvedValue([{ id: 's1' }]);
    prisma.media.findMany.mockResolvedValue([{ url: 'media/a.jpg' }]);
    prisma.chatAttachment.findMany.mockResolvedValue([{ storageKey: 'chat/b.pdf' }]);
    prisma.siteDocument.findMany.mockResolvedValue([{ storageKey: 'site-documents/c.pdf' }]);

    const purged = await service.purgeExpired();

    expect(purged).toBe(1);
    expect(prisma.site.delete).toHaveBeenCalledWith({ where: { id: 's1' } });
    expect(storage.delete).toHaveBeenCalledTimes(3);
    const cutoff = prisma.site.findMany.mock.calls[0][0].where.deletedAt.lt as Date;
    expect(Date.now() - cutoff.getTime()).toBeGreaterThanOrEqual(SITE_RETENTION_DAYS * DAY_MS - 1000);
  });
});
