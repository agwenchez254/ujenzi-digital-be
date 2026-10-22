import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { PrismaService } from '../prisma/prisma.service';
import { SitesService } from '../sites/sites.service';
import { CreateChatMessageDto } from './dto/create-chat-message.dto';
import {
  CHAT_REPLY_PREVIEW_LENGTH,
  ChatChannelType,
  ChatMember,
  ChatMessageView,
  ResolvedChannel,
  roomFor,
} from './chat.types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

const MESSAGE_INCLUDE = {
  author: { select: { id: true, name: true, avatarUrl: true } },
  replyTo: {
    select: { id: true, body: true, author: { select: { name: true } } },
  },
} as const;

type MessageRow = {
  id: string;
  siteId: string;
  inspectionId: string | null;
  body: string;
  createdAt: Date;
  author: { id: string; name: string; avatarUrl: string | null };
  replyTo: { id: string; body: string; author: { name: string } } | null;
};

function humanise(value: string): string {
  const text = value.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

@Injectable()
export class ChatService {
  constructor(
    private prisma: PrismaService,
    private sitesService: SitesService,
  ) {}

  /**
   * Maps a (type, id) pair from the URL or a socket payload to the site /
   * inspection it refers to, and checks the caller may take part. The rule
   * mirrors InspectionsService.assertCanView: administrators, the assigned
   * engineer, and anyone tied to the site (its contractor or personnel).
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
    const isAdmin = user.roles.includes('administrator');

    if (type === 'site') {
      const site = await this.prisma.site.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!site) {
        throw new NotFoundException('Site not found');
      }
      if (
        !isAdmin &&
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
      isAdmin ||
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
  ) {
    const body = dto.body.trim();
    if (!body) {
      throw new BadRequestException('Message cannot be empty');
    }

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

    const row = await this.prisma.chatMessage.create({
      data: {
        siteId: channel.siteId,
        inspectionId: channel.inspectionId,
        authorId: user.userId,
        body,
        replyToId: dto.replyToId,
      },
      include: MESSAGE_INCLUDE,
    });
    return this.toView(row, channel);
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

  async getUserName(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    return user?.name ?? 'Someone';
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
      replyTo: row.replyTo
        ? {
            id: row.replyTo.id,
            body: row.replyTo.body.slice(0, CHAT_REPLY_PREVIEW_LENGTH),
            authorName: row.replyTo.author.name,
          }
        : null,
    };
  }
}
