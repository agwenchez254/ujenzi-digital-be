import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { PrismaService } from '../prisma/prisma.service';
import { SitesService } from '../sites/sites.service';
import { StorageService } from '../storage/storage.service';
import { CreateChatMessageDto } from './dto/create-chat-message.dto';
import {
  CHAT_ALLOWED_FILE_TYPES,
  CHAT_MAX_FILES,
  CHAT_MAX_FILE_BYTES,
  CHAT_REPLY_PREVIEW_LENGTH,
  ChatChannelType,
  ChatMember,
  ChatMessageView,
  ResolvedChannel,
  roomFor,
} from './chat.types';

/** Longest message excerpt shown in a notification. */
export const NOTIFICATION_PREVIEW_LENGTH = 100;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CHAT_STORAGE_NAMESPACE = 'chat';

const MESSAGE_INCLUDE = {
  author: { select: { id: true, name: true, avatarUrl: true } },
  attachments: {
    select: { id: true, fileName: true, mimeType: true, size: true },
    orderBy: { createdAt: 'asc' as const },
  },
  replyTo: {
    select: {
      id: true,
      body: true,
      author: { select: { name: true } },
      attachments: { select: { id: true }, take: 1 },
    },
  },
} as const;

type MessageRow = {
  id: string;
  siteId: string;
  inspectionId: string | null;
  body: string;
  createdAt: Date;
  author: { id: string; name: string; avatarUrl: string | null };
  attachments: {
    id: string;
    fileName: string;
    mimeType: string;
    size: number;
  }[];
  replyTo: {
    id: string;
    body: string;
    author: { name: string };
    attachments: { id: string }[];
  } | null;
};

function humanise(value: string): string {
  const text = value.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Display name only: strips any path, control characters and over-long names. */
function cleanFileName(original: string): string {
  const base = path.basename(original.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex
  const safe = base.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  return (safe || 'file').slice(0, 120);
}

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private sitesService: SitesService,
    private storage: StorageService,
  ) {}

  /**
   * Maps a (type, id) pair from the URL or a socket payload to the site /
   * inspection it refers to, and checks the caller may take part. Administrators
   * and engineers can join any conversation (an engineer who is not on the
   * project can comment; every other action keeps its own permission check).
   * Everyone else must be the contractor or site personnel.
   */
  async resolveChannel(
    type: string,
    id: string,
    user: AuthenticatedUser,
  ): Promise<ResolvedChannel> {
    if (type !== 'site' && type !== 'inspection') {
      throw new BadRequestException(
        'Channel type must be "site" or "inspection"',
      );
    }
    if (!id) {
      throw new BadRequestException('Channel id is required');
    }
    const canJoinAny =
      user.roles.includes('administrator') || user.roles.includes('engineer');

    if (type === 'site') {
      const site = await this.prisma.site.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!site) {
        throw new NotFoundException('Site not found');
      }
      if (
        !canJoinAny &&
        !(await this.sitesService.isTiedToSite(site.id, user.userId))
      ) {
        throw new ForbiddenException('You are not part of this project');
      }
      return {
        type,
        siteId: site.id,
        inspectionId: null,
        room: roomFor(type, site.id),
      };
    }

    const inspection = await this.prisma.inspection.findUnique({
      where: { id },
      select: { id: true, siteId: true, engineerId: true },
    });
    if (!inspection) {
      throw new NotFoundException('Inspection not found');
    }
    const allowed =
      canJoinAny ||
      inspection.engineerId === user.userId ||
      (await this.sitesService.isTiedToSite(inspection.siteId, user.userId));
    if (!allowed) {
      throw new ForbiddenException('You do not have access to this inspection');
    }
    return {
      type,
      siteId: inspection.siteId,
      inspectionId: inspection.id,
      room: roomFor(type, inspection.id),
    };
  }

  async listMessages(
    channel: ResolvedChannel,
    opts: { before?: string; limit?: number },
  ): Promise<ChatMessageView[]> {
    // Number('abc') is NaN, which Prisma rejects as `take`; fall back instead.
    const requested = Number.isFinite(opts.limit)
      ? (opts.limit as number)
      : DEFAULT_LIMIT;
    const limit = Math.min(Math.max(requested, 1), MAX_LIMIT);
    const before = opts.before ? new Date(opts.before) : undefined;
    if (before && Number.isNaN(before.getTime())) {
      throw new BadRequestException('"before" must be an ISO date');
    }

    const rows = await this.prisma.chatMessage.findMany({
      where: {
        siteId: channel.siteId,
        inspectionId: channel.inspectionId,
        ...(before ? { createdAt: { lt: before } } : {}),
      },
      include: MESSAGE_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.reverse().map((row) => this.toView(row, channel));
  }

  async createMessage(
    channel: ResolvedChannel,
    dto: CreateChatMessageDto,
    user: AuthenticatedUser,
    files: Express.Multer.File[] = [],
  ) {
    const body = (dto.body ?? '').trim();
    if (!body && files.length === 0) {
      throw new BadRequestException('Write a message or attach a file');
    }
    this.validateFiles(files);

    if (dto.replyToId) {
      const parent = await this.prisma.chatMessage.findFirst({
        where: {
          id: dto.replyToId,
          siteId: channel.siteId,
          inspectionId: channel.inspectionId,
        },
        select: { id: true },
      });
      if (!parent) {
        throw new BadRequestException(
          'The message you are replying to is not in this conversation',
        );
      }
    }

    // Files first, so the message row never points at bytes that do not exist.
    // If the insert then fails, the saved bytes are removed again.
    const stored: { key: string; file: Express.Multer.File }[] = [];
    try {
      for (const file of files) {
        const key = await this.storage.save(
          file.buffer,
          CHAT_STORAGE_NAMESPACE,
          `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`,
        );
        stored.push({ key, file });
      }

      const row = await this.prisma.chatMessage.create({
        data: {
          siteId: channel.siteId,
          inspectionId: channel.inspectionId,
          authorId: user.userId,
          body,
          replyToId: dto.replyToId,
          attachments: {
            create: stored.map(({ key, file }) => ({
              fileName: cleanFileName(file.originalname),
              mimeType: file.mimetype,
              size: file.size,
              storageKey: key,
            })),
          },
        },
        include: MESSAGE_INCLUDE,
      });
      return this.toView(row, channel);
    } catch (error) {
      await Promise.all(
        stored.map(({ key }) =>
          this.storage.delete(key).catch(() => undefined),
        ),
      );
      throw error;
    }
  }

  /** Resolves an attachment to its file, after checking the caller may see its conversation. */
  async getAttachment(id: string, user: AuthenticatedUser) {
    const attachment = await this.prisma.chatAttachment.findUnique({
      where: { id },
      include: { message: { select: { siteId: true, inspectionId: true } } },
    });
    if (!attachment) {
      throw new NotFoundException('Attachment not found');
    }
    const { siteId, inspectionId } = attachment.message;
    await this.resolveChannel(
      inspectionId ? 'inspection' : 'site',
      inspectionId ?? siteId,
      user,
    );
    return {
      stream: this.storage.read(attachment.storageKey),
      fileName: attachment.fileName,
      mimeType: attachment.mimeType,
      size: attachment.size,
    };
  }

  async listMembers(
    channel: ResolvedChannel,
    isOnline: (userId: string) => boolean,
  ): Promise<ChatMember[]> {
    const site = await this.prisma.site.findUnique({
      where: { id: channel.siteId },
      select: {
        contractor: { select: { id: true, name: true, avatarUrl: true } },
        personnel: {
          where: { userId: { not: null } },
          select: {
            role: true,
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
      },
    });
    if (!site) {
      throw new NotFoundException('Site not found');
    }

    const members = new Map<string, ChatMember>();
    const add = (
      user: { id: string; name: string; avatarUrl: string | null },
      roleLabel: string,
    ) => {
      if (!members.has(user.id)) {
        members.set(user.id, { ...user, roleLabel, online: isOnline(user.id) });
      }
    };

    if (channel.inspectionId) {
      const inspection = await this.prisma.inspection.findUnique({
        where: { id: channel.inspectionId },
        select: {
          engineer: { select: { id: true, name: true, avatarUrl: true } },
        },
      });
      if (inspection) add(inspection.engineer, 'Engineer');
    }
    add(site.contractor, 'Contractor');
    for (const person of site.personnel) {
      if (person.user) add(person.user, humanise(person.role));
    }

    return [...members.values()].sort(
      (a, b) =>
        Number(b.online) - Number(a.online) || a.name.localeCompare(b.name),
    );
  }

  /** Where a "new message" notification should take the recipient, and what to call the conversation. */
  async getNotificationTarget(
    channel: ResolvedChannel,
  ): Promise<{ label: string; link: string }> {
    const site = await this.prisma.site.findUnique({
      where: { id: channel.siteId },
      select: { name: true },
    });
    const siteName = site?.name ?? 'a site';
    if (!channel.inspectionId) {
      return {
        label: `${siteName} project chat`,
        link: `/sites/${channel.siteId}?tab=chat`,
      };
    }
    const inspection = await this.prisma.inspection.findUnique({
      where: { id: channel.inspectionId },
      select: { requestId: true },
    });
    return {
      label: `${siteName} inspection discussion`,
      link: inspection
        ? `/inspections/${inspection.requestId}?tab=discussion`
        : `/sites/${channel.siteId}`,
    };
  }

  async getUserName(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    return user?.name ?? 'Someone';
  }

  private validateFiles(files: Express.Multer.File[]) {
    if (files.length > CHAT_MAX_FILES) {
      throw new BadRequestException(
        `You can attach up to ${CHAT_MAX_FILES} files per message`,
      );
    }
    for (const file of files) {
      if (!CHAT_ALLOWED_FILE_TYPES.has(file.mimetype)) {
        throw new BadRequestException(
          `"${cleanFileName(file.originalname)}" is not an allowed file type. Use images, PDF, Word, Excel, PowerPoint, text, CSV or ZIP files.`,
        );
      }
      if (file.size > CHAT_MAX_FILE_BYTES) {
        throw new BadRequestException(
          `"${cleanFileName(file.originalname)}" is larger than ${CHAT_MAX_FILE_BYTES / 1024 / 1024} MB`,
        );
      }
    }
  }

  private toView(row: MessageRow, channel: ResolvedChannel): ChatMessageView {
    const type: ChatChannelType = channel.type;
    return {
      id: row.id,
      channelType: type,
      channelId: channel.inspectionId ?? channel.siteId,
      siteId: row.siteId,
      inspectionId: row.inspectionId,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      author: row.author,
      attachments: row.attachments,
      replyTo: row.replyTo
        ? {
            id: row.replyTo.id,
            body:
              row.replyTo.body.slice(0, CHAT_REPLY_PREVIEW_LENGTH) ||
              (row.replyTo.attachments.length ? 'Attachment' : ''),
            authorName: row.replyTo.author.name,
          }
        : null,
    };
  }
}
