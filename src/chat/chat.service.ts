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
  ChatReceiptsEvent,
  MessageReceipt,
  ResolvedChannel,
  roomFor,
} from './chat.types';

/** Longest message excerpt shown in a notification. */
export const NOTIFICATION_PREVIEW_LENGTH = 100;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const CHAT_STORAGE_NAMESPACE = 'chat';

/** Messages older than this are not replayed on reconnect; history is still a fetch away. */
const BACKLOG_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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

/** Enough of a message to move a recipient's cursor and find its channel. */
type DeliveryMark = Pick<
  ChatMessageView,
  'channelType' | 'channelId' | 'siteId' | 'inspectionId' | 'createdAt'
>;

type ReceiptKind = 'delivered' | 'read';

type MessageRow = {
  id: string;
  clientId?: string | null;
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

  private receiptPublisher?: (authorId: string, event: ChatReceiptsEvent) => void;

  /** Registered by the gateway, which owns the sockets this service has no access to. */
  setReceiptPublisher(
    publisher: (authorId: string, event: ChatReceiptsEvent) => void,
  ): void {
    this.receiptPublisher = publisher;
  }

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
        select: { id: true, deletedAt: true },
      });
      if (!site || site.deletedAt) {
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
    opts: { before?: string; limit?: number; viewerId?: string },
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
    rows.reverse();
    // Ticks are only shown to the sender, under their own messages.
    const own = opts.viewerId
      ? rows.filter((row) => (row as { authorId?: string }).authorId === opts.viewerId)
      : [];
    const receipts = own.length
      ? await this.receiptsFor(
          channel,
          own.map((row) => ({
            id: row.id,
            authorId: opts.viewerId as string,
            createdAt: row.createdAt,
          })),
        )
      : new Map<string, MessageReceipt>();
    return rows.map((row) => this.toView(row, channel, receipts.get(row.id)));
  }

  /** The message this device already sent under `clientId`, if any (retry after reconnecting). */
  async findByClientId(
    channel: ResolvedChannel,
    userId: string,
    clientId: string,
  ): Promise<ChatMessageView | null> {
    const row = await this.prisma.chatMessage.findFirst({
      where: {
        authorId: userId,
        clientId,
        siteId: channel.siteId,
        inspectionId: channel.inspectionId,
      },
      include: MESSAGE_INCLUDE,
    });
    return row ? this.toView(row, channel) : null;
  }

  /**
   * Messages from other people that this user has not been delivered yet, oldest
   * first: what was sent while they were offline. Scoped to channels they can see
   * (sites they are tied to, plus inspections assigned to them) and to the replay window.
   */
  async collectBacklog(
    userId: string,
    limit: number,
  ): Promise<ChatMessageView[]> {
    // Same "tied to the site" rule resolveChannel applies, resolved fresh from the
    // database rather than trusting anything cached on the socket.
    const siteIds = await this.sitesService.resolveTiedSiteIds(userId);
    const floor = new Date(Date.now() - BACKLOG_MAX_AGE_MS);
    const cursors = await this.prisma.chatDelivery.findMany({
      where: { userId },
    });
    const alreadyDelivered = cursors.map((cursor) => {
      const [, type, id] = cursor.channelKey.split(':');
      return {
        ...(type === 'site'
          ? { siteId: id, inspectionId: null }
          : { inspectionId: id }),
        createdAt: { lte: cursor.deliveredUntil },
      };
    });

    const rows = await this.prisma.chatMessage.findMany({
      where: {
        authorId: { not: userId },
        createdAt: { gt: floor },
        site: { deletedAt: null },
        OR: [{ siteId: { in: siteIds } }, { inspection: { engineerId: userId } }],
        ...(alreadyDelivered.length ? { NOT: { OR: alreadyDelivered } } : {}),
      },
      include: MESSAGE_INCLUDE,
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((row) => this.toView(row, this.channelOfRow(row)));
  }

  /**
   * Moves each recipient's cursor forward to the newest of these messages per
   * channel. Never moves backwards, so a late or duplicate ack is harmless.
   */
  async markDelivered(userIds: string[], messages: DeliveryMark[]): Promise<void> {
    await this.advance(userIds, messages, 'delivered');
  }

  /** The user has opened the conversation and seen everything up to this message. */
  async markRead(
    channel: ResolvedChannel,
    messageId: string,
    userId: string,
  ): Promise<void> {
    await this.advance([userId], [await this.markOf(channel, messageId)], 'read');
  }

  /** A client confirming it has received messages up to `messageId` in a channel. */
  async acknowledge(
    channel: ResolvedChannel,
    messageId: string,
    userId: string,
  ): Promise<void> {
    await this.advance([userId], [await this.markOf(channel, messageId)], 'delivered');
  }

  /** Who has received / read one of your messages (the "message info" screen). */
  async getMessageReceipts(
    channel: ResolvedChannel,
    messageId: string,
    user: AuthenticatedUser,
  ) {
    const message = await this.prisma.chatMessage.findFirst({
      where: {
        id: messageId,
        siteId: channel.siteId,
        inspectionId: channel.inspectionId,
      },
      select: { authorId: true, createdAt: true },
    });
    if (!message) throw new NotFoundException('Message not found');
    if (message.authorId !== user.userId && !user.roles.includes('administrator')) {
      throw new ForbiddenException('Only the sender can see who has read a message');
    }

    const participants = (await this.loadParticipants(channel)).filter(
      (p) => p.user.id !== message.authorId,
    );
    const cursors = await this.prisma.chatDelivery.findMany({
      where: {
        channelKey: channel.room,
        userId: { in: participants.map((p) => p.user.id) },
      },
    });
    return participants.map(({ user: person, roleLabel }) => {
      const cursor = cursors.find((c) => c.userId === person.id);
      return {
        ...person,
        roleLabel,
        delivered: !!cursor && cursor.deliveredUntil >= message.createdAt,
        read: !!cursor?.readUntil && cursor.readUntil >= message.createdAt,
      };
    });
  }

  private async markOf(channel: ResolvedChannel, messageId: string): Promise<DeliveryMark> {
    const message = await this.prisma.chatMessage.findFirst({
      where: {
        id: messageId,
        siteId: channel.siteId,
        inspectionId: channel.inspectionId,
      },
      select: { createdAt: true },
    });
    if (!message) throw new NotFoundException('Message not found');
    return {
      channelType: channel.type,
      channelId: channel.inspectionId ?? channel.siteId,
      siteId: channel.siteId,
      inspectionId: channel.inspectionId,
      createdAt: message.createdAt.toISOString(),
    };
  }

  private async advance(
    userIds: string[],
    messages: DeliveryMark[],
    kind: ReceiptKind,
  ): Promise<void> {
    if (!userIds.length || !messages.length) return;

    const newest = new Map<string, { mark: DeliveryMark; at: Date }>();
    for (const mark of messages) {
      const key = roomFor(mark.channelType, mark.channelId);
      const at = new Date(mark.createdAt);
      if (!newest.has(key) || at > (newest.get(key) as { at: Date }).at) {
        newest.set(key, { mark, at });
      }
    }

    const floor = new Date(Date.now() - BACKLOG_MAX_AGE_MS);
    for (const [channelKey, { mark, at }] of newest) {
      // Where each cursor was, so only messages that actually changed state are re-announced.
      const before = await this.prisma.chatDelivery.findMany({
        where: { channelKey, userId: { in: userIds } },
      });
      let since = at;
      for (const userId of userIds) {
        const prev = before.find((c) => c.userId === userId);
        const delivered = prev?.deliveredUntil ?? floor;
        const position =
          kind === 'read'
            ? new Date(Math.min(delivered.getTime(), (prev?.readUntil ?? floor).getTime()))
            : delivered;
        if (position < since) since = position;
      }

      // GREATEST ignores NULL, so the first read simply sets readUntil.
      await Promise.all(
        userIds.map((userId) =>
          kind === 'read'
            ? this.prisma.$executeRaw`
                INSERT INTO "ChatDelivery" ("id", "userId", "channelKey", "deliveredUntil", "readUntil")
                VALUES (gen_random_uuid()::text, ${userId}, ${channelKey}, ${at}, ${at})
                ON CONFLICT ("userId", "channelKey") DO UPDATE SET
                  "deliveredUntil" = GREATEST("ChatDelivery"."deliveredUntil", EXCLUDED."deliveredUntil"),
                  "readUntil" = GREATEST("ChatDelivery"."readUntil", EXCLUDED."readUntil")`
            : this.prisma.$executeRaw`
                INSERT INTO "ChatDelivery" ("id", "userId", "channelKey", "deliveredUntil")
                VALUES (gen_random_uuid()::text, ${userId}, ${channelKey}, ${at})
                ON CONFLICT ("userId", "channelKey") DO UPDATE SET
                  "deliveredUntil" = GREATEST("ChatDelivery"."deliveredUntil", EXCLUDED."deliveredUntil")`,
        ),
      );

      await this.publishReceipts(mark, userIds, since, at);
    }
  }

  /** Tells the authors of the newly delivered / read messages, so their ticks update live. */
  private async publishReceipts(
    mark: DeliveryMark,
    recipientIds: string[],
    since: Date,
    upTo: Date,
  ): Promise<void> {
    if (!this.receiptPublisher) return;
    try {
      const channel: ResolvedChannel = {
        type: mark.channelType,
        siteId: mark.siteId,
        inspectionId: mark.inspectionId,
        room: roomFor(mark.channelType, mark.channelId),
      };
      const rows = await this.prisma.chatMessage.findMany({
        where: {
          siteId: mark.siteId,
          inspectionId: mark.inspectionId,
          createdAt: { gt: since, lte: upTo },
          authorId: { notIn: recipientIds },
        },
        select: { id: true, authorId: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });
      if (!rows.length) return;

      const receipts = await this.receiptsFor(channel, rows);
      const byAuthor = new Map<string, ChatReceiptsEvent['receipts']>();
      for (const row of rows) {
        const receipt = receipts.get(row.id);
        if (!receipt) continue;
        const list = byAuthor.get(row.authorId) ?? [];
        list.push({ messageId: row.id, ...receipt });
        byAuthor.set(row.authorId, list);
      }
      for (const [authorId, list] of byAuthor) {
        this.receiptPublisher(authorId, {
          channelType: mark.channelType,
          channelId: mark.channelId,
          receipts: list,
        });
      }
    } catch {
      // Ticks are best effort; the cursor has already moved and history carries the truth.
    }
  }

  /**
   * Sent / delivered / read for each message, judged against everyone else in the
   * conversation: delivered once every recipient has it, read once every one has seen it.
   */
  private async receiptsFor(
    channel: ResolvedChannel,
    rows: { id: string; authorId: string; createdAt: Date }[],
  ): Promise<Map<string, MessageReceipt>> {
    const participantIds = (await this.loadParticipants(channel)).map((p) => p.user.id);
    const cursors = await this.prisma.chatDelivery.findMany({
      where: { channelKey: channel.room, userId: { in: participantIds } },
    });
    const byUser = new Map(cursors.map((c) => [c.userId, c]));

    const result = new Map<string, MessageReceipt>();
    for (const row of rows) {
      const recipients = participantIds.filter((id) => id !== row.authorId);
      const delivered = recipients.filter((id) => {
        const cursor = byUser.get(id);
        return !!cursor && cursor.deliveredUntil >= row.createdAt;
      }).length;
      const read = recipients.filter((id) => {
        const cursor = byUser.get(id);
        return !!cursor?.readUntil && cursor.readUntil >= row.createdAt;
      }).length;
      const total = recipients.length;
      result.set(row.id, {
        status:
          total > 0 && read === total
            ? 'read'
            : total > 0 && delivered === total
              ? 'delivered'
              : 'sent',
        recipients: total,
        delivered,
        read,
      });
    }
    return result;
  }

  private channelOfRow(row: MessageRow): ResolvedChannel {
    const type: ChatChannelType = row.inspectionId ? 'inspection' : 'site';
    return {
      type,
      siteId: row.siteId,
      inspectionId: row.inspectionId,
      room: roomFor(type, row.inspectionId ?? row.siteId),
    };
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
          clientId: dto.clientId || null,
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

  /** Everyone taking part in a conversation, each with the label for why they are in it. */
  private async loadParticipants(
    channel: ResolvedChannel,
  ): Promise<
    {
      user: { id: string; name: string; avatarUrl: string | null };
      roleLabel: string;
    }[]
  > {
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

    const participants = new Map<
      string,
      {
        user: { id: string; name: string; avatarUrl: string | null };
        roleLabel: string;
      }
    >();
    const add = (
      user: { id: string; name: string; avatarUrl: string | null },
      roleLabel: string,
    ) => {
      if (!participants.has(user.id)) {
        participants.set(user.id, { user, roleLabel });
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
    return [...participants.values()];
  }

  async listMembers(
    channel: ResolvedChannel,
    isOnline: (userId: string) => boolean | Promise<boolean>,
  ): Promise<ChatMember[]> {
    const members: ChatMember[] = (await this.loadParticipants(channel)).map(
      ({ user, roleLabel }) => ({ ...user, roleLabel, online: false }),
    );
    await Promise.all(
      members.map(async (m) => {
        m.online = await isOnline(m.id);
      }),
    );
    return members.sort(
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

  private toView(
    row: MessageRow,
    channel: ResolvedChannel,
    receipt?: MessageReceipt,
  ): ChatMessageView {
    const type: ChatChannelType = channel.type;
    return {
      id: row.id,
      channelType: type,
      channelId: channel.inspectionId ?? channel.siteId,
      siteId: row.siteId,
      inspectionId: row.inspectionId,
      body: row.body,
      createdAt: row.createdAt.toISOString(),
      clientId: row.clientId ?? null,
      ...(receipt ? { receipt } : {}),
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
