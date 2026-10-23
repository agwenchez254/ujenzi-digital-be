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
    chatAttachment: { findUnique: jest.fn() },
    chatKeyEpoch: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findUnique: jest.fn() },
  };
  const sites = { isTiedToSite: jest.fn() };
  const storage = {
    save: jest.fn(
      async (_buf: Buffer, ns: string, name: string) => `${ns}/${name}`,
    ),
    delete: jest.fn().mockResolvedValue(undefined),
    read: jest.fn().mockReturnValue('STREAM'),
  };
  const service = new ChatService(
    prisma as never,
    sites as never,
    storage as never,
  );
  return { prisma, sites, storage, service };
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

const file = (over: Partial<Express.Multer.File> = {}) =>
  ({
    originalname: 'level2-slab.pdf',
    mimetype: 'application/pdf',
    size: 1024,
    buffer: Buffer.from('%PDF-1.4 test'),
    ...over,
  }) as Express.Multer.File;

describe('ChatService engineer access', () => {
  it('lets an engineer who is not on the project into the site chat', async () => {
    const { service, prisma, sites } = build();
    prisma.site.findUnique.mockResolvedValue({ id: 's1' });
    sites.isTiedToSite.mockResolvedValue(false);
    await expect(
      service.resolveChannel('site', 's1', engineer),
    ).resolves.toMatchObject({ room: 'chat:site:s1' });
    expect(sites.isTiedToSite).not.toHaveBeenCalled();
  });

  it('lets an engineer comment on an inspection they are not assigned to', async () => {
    const { service, prisma, sites } = build();
    prisma.inspection.findUnique.mockResolvedValue({
      id: 'i1',
      siteId: 's1',
      engineerId: 'someone-else',
    });
    sites.isTiedToSite.mockResolvedValue(false);
    await expect(
      service.resolveChannel('inspection', 'i1', engineer),
    ).resolves.toMatchObject({
      room: 'chat:inspection:i1',
    });
  });
});

describe('ChatService attachments', () => {
  const created = (attachments: unknown[] = []) => ({
    id: 'm1',
    siteId: 's1',
    inspectionId: 'i1',
    body: '',
    createdAt: new Date('2026-10-22T08:00:00Z'),
    author: { id: 'eng-1', name: 'Njeri Kamau', avatarUrl: null },
    attachments,
    replyTo: null,
  });

  it('accepts a message that is only a file', async () => {
    const { service, prisma, storage } = build();
    prisma.chatMessage.create.mockResolvedValue(
      created([
        {
          id: 'a1',
          fileName: 'level2-slab.pdf',
          mimeType: 'application/pdf',
          size: 1024,
        },
      ]),
    );
    const view = await service.createMessage(inspectionChannel, {}, engineer, [
      file(),
    ]);
    expect(storage.save).toHaveBeenCalledTimes(1);
    expect(storage.save.mock.calls[0][1]).toBe('chat');
    expect(view.attachments).toHaveLength(1);
    expect(
      prisma.chatMessage.create.mock.calls[0][0].data.attachments.create[0],
    ).toMatchObject({
      fileName: 'level2-slab.pdf',
      mimeType: 'application/pdf',
      size: 1024,
    });
  });

  it('rejects an empty message with no files', async () => {
    const { service } = build();
    await expect(
      service.createMessage(siteChannel, { body: ' ' }, engineer, []),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects types that could carry script (SVG, HTML, executables)', async () => {
    const { service, storage } = build();
    for (const bad of [
      file({ originalname: 'x.svg', mimetype: 'image/svg+xml' }),
      file({ originalname: 'x.html', mimetype: 'text/html' }),
      file({ originalname: 'x.exe', mimetype: 'application/x-msdownload' }),
    ]) {
      await expect(
        service.createMessage(siteChannel, { body: 'hi' }, engineer, [bad]),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(storage.save).not.toHaveBeenCalled();
  });

  it('rejects oversized files and too many files', async () => {
    const { service } = build();
    await expect(
      service.createMessage(siteChannel, { body: 'hi' }, engineer, [
        file({ size: 16 * 1024 * 1024 }),
      ]),
    ).rejects.toThrow(/larger than 15 MB/);
    await expect(
      service.createMessage(
        siteChannel,
        { body: 'hi' },
        engineer,
        Array.from({ length: 6 }, () => file()),
      ),
    ).rejects.toThrow(/up to 5 files/);
  });

  it('strips path segments from the stored display name', async () => {
    const { service, prisma } = build();
    prisma.chatMessage.create.mockResolvedValue(created());
    await service.createMessage(siteChannel, { body: 'hi' }, engineer, [
      file({ originalname: '../../etc/passwd.pdf' }),
    ]);
    expect(
      prisma.chatMessage.create.mock.calls[0][0].data.attachments.create[0]
        .fileName,
    ).toBe('passwd.pdf');
  });

  it('removes saved files again when the message insert fails', async () => {
    const { service, prisma, storage } = build();
    prisma.chatMessage.create.mockRejectedValue(new Error('db down'));
    await expect(
      service.createMessage(siteChannel, { body: 'hi' }, engineer, [
        file(),
        file(),
      ]),
    ).rejects.toThrow('db down');
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });

  it('only serves an attachment to someone allowed in its conversation', async () => {
    const { service, prisma, sites } = build();
    prisma.chatAttachment.findUnique.mockResolvedValue({
      storageKey: 'chat/a.pdf',
      fileName: 'a.pdf',
      mimeType: 'application/pdf',
      size: 10,
      message: { siteId: 's1', inspectionId: null },
    });
    prisma.site.findUnique.mockResolvedValue({ id: 's1' });
    sites.isTiedToSite.mockResolvedValue(false);

    await expect(service.getAttachment('a1', outsider)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.getAttachment('a1', engineer)).resolves.toMatchObject({
      fileName: 'a.pdf',
    });
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
      attachments: [],
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
