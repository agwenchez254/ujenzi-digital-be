import { Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { TokenBucket } from '../realtime/socket-rate-limit';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { ChatService } from './chat.service';
import { ChatMessageView, ResolvedChannel, roomFor } from './chat.types';

interface ChannelPayload {
  type?: unknown;
  id?: unknown;
  typing?: unknown;
  messageId?: unknown;
}

// Replay is sent in batches, each confirmed by the client before the next, so a
// long absence never produces one enormous payload.
const BACKLOG_BATCH_SIZE = 100;
const BACKLOG_MAX_BATCHES = 5;
const BACKLOG_ACK_TIMEOUT_MS = 10_000;

// Per-socket event budget: a burst of 30, refilling 10 a second. A socket that keeps
// hammering past it is cut off rather than left to tie up the database.
const EVENT_BURST = 30;
const EVENT_REFILL_PER_SECOND = 10;
const MAX_VIOLATIONS_BEFORE_DISCONNECT = 20;
const RATE_LIMITED: { ok: false; error: string } = { ok: false, error: 'Too many requests' };

// What RealtimeGateway and this gateway stash on socket.data.
interface SocketData {
  ready?: Promise<void>;
  userId?: string;
  roles?: AuthenticatedUser['roles'];
  chatName?: string;
  chatRooms?: Set<string>;
  bucket?: TokenBucket;
  violations?: number;
}

const dataOf = (client: Socket): SocketData => client.data as SocketData;

interface Ack {
  ok: boolean;
  error?: string;
}

// Same default namespace and socket.io server as RealtimeGateway, which owns
// authentication: it verifies the token on connect and fills client.data.
@WebSocketGateway()
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(ChatGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(private chatService: ChatService) {
    // The author's sockets all sit in their user room, whichever instance they are on.
    this.chatService.setReceiptPublisher?.((authorId, event) => {
      this.server.to(`user:${authorId}`).emit('chat:receipts', event);
    });
  }

  /**
   * The user has the conversation open and has seen everything up to `messageId`.
   * Senders see their ticks turn blue (`chat:receipts`).
   */
  @SubscribeMessage('chat:read')
  async read(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChannelPayload,
  ): Promise<Ack> {
    if (this.throttled(client)) return RATE_LIMITED;
    const user = await this.authenticatedUser(client);
    if (!user) return { ok: false, error: 'Not authenticated' };
    if (
      typeof body?.type !== 'string' ||
      typeof body?.id !== 'string' ||
      typeof body?.messageId !== 'string'
    ) {
      return { ok: false, error: 'Invalid payload' };
    }
    try {
      const channel = await this.chatService.resolveChannel(body.type, body.id, user);
      await this.chatService.markRead(channel, body.messageId, user.userId);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to mark as read',
      };
    }
  }

  /**
   * Delivers what arrived while this user was offline. Each batch is emitted as
   * `chat:backlog` ({ messages }) with an acknowledgement callback; the delivery
   * cursor only advances once the client confirms, so a dropped connection mid-way
   * simply resumes from the same point next time.
   */
  async handleConnection(client: Socket): Promise<void> {
    try {
      const user = await this.authenticatedUser(client);
      if (!user) return;

      for (let batch = 0; batch < BACKLOG_MAX_BATCHES; batch++) {
        const messages = await this.chatService.collectBacklog(
          user.userId,
          BACKLOG_BATCH_SIZE,
        );
        if (messages.length === 0) return;
        await client
          .timeout(BACKLOG_ACK_TIMEOUT_MS)
          .emitWithAck('chat:backlog', { messages });
        await this.chatService.markDelivered([user.userId], messages);
        if (messages.length < BACKLOG_BATCH_SIZE) return;
      }
    } catch (error) {
      // No ack in time (client does not handle the event, or it dropped): leave the
      // cursor alone so these are offered again on the next connection.
      this.logger.debug(
        `Backlog not confirmed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  @SubscribeMessage('chat:ack')
  async acknowledge(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChannelPayload,
  ): Promise<Ack> {
    if (this.throttled(client)) return RATE_LIMITED;
    const user = await this.authenticatedUser(client);
    if (!user) return { ok: false, error: 'Not authenticated' };
    if (
      typeof body?.type !== 'string' ||
      typeof body?.id !== 'string' ||
      typeof body?.messageId !== 'string'
    ) {
      return { ok: false, error: 'Invalid payload' };
    }
    try {
      const channel = await this.chatService.resolveChannel(body.type, body.id, user);
      await this.chatService.acknowledge(channel, body.messageId, user.userId);
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to acknowledge',
      };
    }
  }

  @SubscribeMessage('chat:join')
  async join(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChannelPayload,
  ): Promise<Ack> {
    if (this.throttled(client)) return RATE_LIMITED;
    const user = await this.authenticatedUser(client);
    if (!user) return { ok: false, error: 'Not authenticated' };
    if (typeof body?.type !== 'string' || typeof body?.id !== 'string') {
      return { ok: false, error: 'Invalid channel' };
    }

    try {
      const channel = await this.chatService.resolveChannel(
        body.type,
        body.id,
        user,
      );
      await client.join(channel.room);
      this.rooms(client).add(channel.room);
      const data = dataOf(client);
      data.chatName ??= await this.chatService.getUserName(user.userId);
      client
        .to(channel.room)
        .emit('presence:update', { userId: user.userId, online: true });
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'Unable to join',
      };
    }
  }

  @SubscribeMessage('chat:leave')
  async leave(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChannelPayload,
  ): Promise<Ack> {
    if (this.throttled(client)) return RATE_LIMITED;
    if (typeof body?.type !== 'string' || typeof body?.id !== 'string') {
      return { ok: false, error: 'Invalid channel' };
    }
    const room = roomFor(body.type as 'site' | 'inspection', body.id);
    this.emitTyping(client, room, body.type, body.id, false);
    await client.leave(room);
    this.rooms(client).delete(room);
    return { ok: true };
  }

  @SubscribeMessage('chat:typing')
  async typing(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChannelPayload,
  ): Promise<Ack> {
    if (this.throttled(client)) return RATE_LIMITED;
    const user = await this.authenticatedUser(client);
    if (!user) return { ok: false, error: 'Not authenticated' };
    if (
      typeof body?.type !== 'string' ||
      typeof body?.id !== 'string' ||
      typeof body?.typing !== 'boolean'
    ) {
      return { ok: false, error: 'Invalid payload' };
    }

    // Only someone who passed the access check in chat:join is in the room.
    const room = roomFor(body.type as 'site' | 'inspection', body.id);
    if (!client.rooms.has(room))
      return { ok: false, error: 'Join the conversation first' };

    this.emitTyping(client, room, body.type, body.id, body.typing);
    return { ok: true };
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const { chatRooms: rooms, userId, chatName } = dataOf(client);
    if (!rooms || !userId) return;

    // Rooms are already gone at this point, so remember them ourselves to tell
    // peers this person stopped typing and (if no other tab) went offline.
    const stillOnline =
      (await this.server.in(`user:${userId}`).fetchSockets()).length > 0;
    for (const room of rooms) {
      const [, type, id] = room.split(':');
      this.server.to(room).emit('chat:typing', {
        channelType: type,
        channelId: id,
        userId,
        name: chatName ?? 'Someone',
        typing: false,
      });
      if (!stillOnline) {
        this.server.to(room).emit('presence:update', { userId, online: false });
      }
    }
  }

  /** Tells everyone in the conversation to refetch its key state (new epoch or new copies). */
  emitKeysChanged(channel: ResolvedChannel, epoch: number): void {
    this.server.to(channel.room).emit('chat:keys', {
      channelType: channel.type,
      channelId: channel.inspectionId ?? channel.siteId,
      epoch,
    });
  }

  emitMessage(message: ChatMessageView): void {
    this.server
      .to(roomFor(message.channelType, message.channelId))
      .emit('chat:message', message);
  }

  /**
   * Whoever is in the room when a message is emitted is connected, so counts as
   * delivered. Everyone else keeps it as backlog until they next connect.
   */
  async trackDelivery(message: ChatMessageView): Promise<void> {
    try {
      const sockets = await this.server
        .in(roomFor(message.channelType, message.channelId))
        .fetchSockets();
      const userIds = [
        ...new Set(
          sockets
            .map((s) => (s.data as SocketData).userId)
            .filter((id): id is string => !!id && id !== message.author.id),
        ),
      ];
      if (userIds.length) await this.chatService.markDelivered(userIds, [message]);
    } catch (error) {
      this.logger.warn(
        `Could not record delivery: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** True when this socket has used up its event budget. */
  private throttled(client: Socket): boolean {
    const data = dataOf(client);
    data.bucket ??= new TokenBucket(EVENT_BURST, EVENT_REFILL_PER_SECOND);
    if (data.bucket.take()) return false;
    data.violations = (data.violations ?? 0) + 1;
    if (data.violations >= MAX_VIOLATIONS_BEFORE_DISCONNECT) client.disconnect(true);
    return true;
  }

  private emitTyping(
    client: Socket,
    room: string,
    type: string,
    id: string,
    typing: boolean,
  ): void {
    client.to(room).emit('chat:typing', {
      channelType: type,
      channelId: id,
      userId: dataOf(client).userId,
      name: dataOf(client).chatName ?? 'Someone',
      typing,
    });
  }

  private rooms(client: Socket): Set<string> {
    const data = dataOf(client);
    data.chatRooms ??= new Set<string>();
    return data.chatRooms;
  }

  private async authenticatedUser(
    client: Socket,
  ): Promise<AuthenticatedUser | null> {
    // RealtimeGateway.handleConnection is async; wait for it before trusting data.
    const data = dataOf(client);
    await data.ready;
    if (!data.userId) return null;
    return { userId: data.userId, roles: data.roles ?? [], permissions: [] };
  }
}
