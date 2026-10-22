import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ChatService } from './chat.service';
import { ResolvedChannel } from './chat.types';

const admin = {
  userId: 'admin-1',
  roles: ['administrator'],
  permissions: [],
} as never;
const engineer = {
  userId: 'eng-1',
  roles: ['engineer'],
  permissions: [],
} as never;
const outsider = {
  userId: 'out-1',
  roles: ['contractor'],
  permissions: [],
} as never;

function build() {
  const prisma = {
    site: { findUnique: jest.fn() },
    inspection: { findUnique: jest.fn() },
    chatMessage: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
    },
    user: { findUnique: jest.fn() },
  };
  const sites = { isTiedToSite: jest.fn() };
  const service = new ChatService(prisma as never, sites as never);
  return { prisma, sites, service };
}

const siteChannel: ResolvedChannel = {
  type: 'site',
  siteId: 's1',
  inspectionId: null,
  room: 'chat:site:s1',
};
const inspectionChannel: ResolvedChannel = {
  type: 'inspection',
  siteId: 's1',
  inspectionId: 'i1',
  room: 'chat:inspection:i1',
};

describe('ChatService.resolveChannel', () => {
  it('rejects an unknown channel type', async () => {
    const { service } = build();
    await expect(
      service.resolveChannel('group', 'x', admin),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('404s for a missing site', async () => {
    const { service, prisma } = build();
    prisma.site.findUnique.mockResolvedValue(null);
    await expect(
      service.resolveChannel('site', 's1', admin),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets an administrator into any site without a membership lookup', async () => {
    const { service, prisma, sites } = build();
    prisma.site.findUnique.mockResolvedValue({ id: 's1' });
    await expect(
      service.resolveChannel('site', 's1', admin),
    ).resolves.toMatchObject({ room: 'chat:site:s1' });
    expect(sites.isTiedToSite).not.toHaveBeenCalled();
  });

  it('forbids someone not tied to the site', async () => {
    const { service, prisma, sites } = build();
    prisma.site.findUnique.mockResolvedValue({ id: 's1' });
    sites.isTiedToSite.mockResolvedValue(false);
    await expect(
      service.resolveChannel('site', 's1', outsider),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets the assigned engineer into an inspection even if not tied to the site', async () => {
    const { service, prisma, sites } = build();
    prisma.inspection.findUnique.mockResolvedValue({
      id: 'i1',
      siteId: 's1',
      engineerId: 'eng-1',
    });
    sites.isTiedToSite.mockResolvedValue(false);
    await expect(
      service.resolveChannel('inspection', 'i1', engineer),
    ).resolves.toMatchObject({
      siteId: 's1',
      inspectionId: 'i1',
      room: 'chat:inspection:i1',
    });
  });

  it('forbids an unrelated user from an inspection thread', async () => {
    const { service, prisma, sites } = build();
    prisma.inspection.findUnique.mockResolvedValue({
      id: 'i1',
      siteId: 's1',
      engineerId: 'eng-1',
    });
    sites.isTiedToSite.mockResolvedValue(false);
    await expect(
      service.resolveChannel('inspection', 'i1', outsider),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('ChatService.createMessage', () => {
  it('rejects a whitespace-only body', async () => {
    const { service } = build();
    await expect(
      service.createMessage(siteChannel, { body: '   \n ' }, engineer),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a reply to a message from another conversation', async () => {
    const { service, prisma } = build();
    prisma.chatMessage.findFirst.mockResolvedValue(null);
    await expect(
      service.createMessage(
        inspectionChannel,
        { body: 'hi', replyToId: 'other' },
        engineer,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.chatMessage.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'other', siteId: 's1', inspectionId: 'i1' },
      }),
    );
  });

  it('trims the body and returns the view the clients render', async () => {
    const { service, prisma } = build();
    prisma.chatMessage.create.mockResolvedValue({
      id: 'm1',
      siteId: 's1',
      inspectionId: 'i1',
      body: 'Foundation looks fine',
      createdAt: new Date('2026-10-22T08:00:00Z'),
      author: { id: 'eng-1', name: 'Njeri Kamau', avatarUrl: null },
      replyTo: null,
    });
    const view = await service.createMessage(
      inspectionChannel,
      { body: '  Foundation looks fine ' },
      engineer,
    );
    expect(prisma.chatMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          body: 'Foundation looks fine',
          authorId: 'eng-1',
        }),
      }),
    );
    expect(view).toMatchObject({
      channelType: 'inspection',
      channelId: 'i1',
      createdAt: '2026-10-22T08:00:00.000Z',
      replyTo: null,
    });
  });
});

describe('ChatService.listMessages', () => {
  it('keeps site chat separate from inspection threads and returns oldest first', async () => {
    const { service, prisma } = build();
    const row = (id: string, at: string) => ({
      id,
      siteId: 's1',
      inspectionId: null,
      body: id,
      createdAt: new Date(at),
      author: { id: 'u', name: 'U', avatarUrl: null },
      replyTo: null,
    });
    prisma.chatMessage.findMany.mockResolvedValue([
      row('new', '2026-10-22T09:00:00Z'),
      row('old', '2026-10-22T08:00:00Z'),
    ]);

    const messages = await service.listMessages(siteChannel, { limit: 500 });

    expect(messages.map((m) => m.id)).toEqual(['old', 'new']);
    const args = prisma.chatMessage.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ siteId: 's1', inspectionId: null });
    expect(args.take).toBe(100);
  });

  it('rejects a malformed "before" cursor', async () => {
    const { service } = build();
    await expect(
      service.listMessages(siteChannel, { before: 'yesterday-ish' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ChatService.listMembers', () => {
  it('dedupes people, labels roles, and lists online members first', async () => {
    const { service, prisma } = build();
    prisma.site.findUnique.mockResolvedValue({
      contractor: { id: 'c1', name: 'Wanjiku Mwangi', avatarUrl: null },
      personnel: [
        {
          role: 'SITE_ENGINEER',
          user: { id: 'p1', name: 'Otieno Ochieng', avatarUrl: null },
        },
        {
          role: 'CONTRACTOR',
          user: { id: 'c1', name: 'Wanjiku Mwangi', avatarUrl: null },
        },
      ],
    });
    prisma.inspection.findUnique.mockResolvedValue({
      engineer: { id: 'eng-1', name: 'Njeri Kamau', avatarUrl: null },
    });

    const members = await service.listMembers(
      inspectionChannel,
      (id) => id === 'p1',
    );

    // Online first, then alphabetical by name.
    expect(members.map((m) => m.id)).toEqual(['p1', 'eng-1', 'c1']);
    expect(members[0]).toMatchObject({
      id: 'p1',
      online: true,
      roleLabel: 'Site engineer',
    });
    expect(members.filter((m) => m.id === 'c1')).toHaveLength(1);
    expect(members.find((m) => m.id === 'eng-1')?.roleLabel).toBe('Engineer');
    expect(members.find((m) => m.id === 'c1')?.roleLabel).toBe('Contractor');
  });
});
