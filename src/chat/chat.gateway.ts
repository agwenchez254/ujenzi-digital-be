import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { AuthenticatedUser } from '../auth/types/jwt-payload.type';
import { ChatService } from './chat.service';
import { ChatMessageView, roomFor } from './chat.types';

interface ChannelPayload {
  type?: unknown;
  id?: unknown;
  typing?: unknown;
}

// What RealtimeGateway and this gateway stash on socket.data.
interface SocketData {
  ready?: Promise<void>;
  userId?: string;
  roles?: AuthenticatedUser['roles'];
  chatName?: string;
  chatRooms?: Set<string>;
}

const dataOf = (client: Socket): SocketData => client.data as SocketData;

interface Ack {
  ok: boolean;
  error?: string;
}

// Same default namespace and socket.io server as RealtimeGateway, which owns
// authentication: it verifies the token on connect and fills client.data.
@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class ChatGateway implements OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  constructor(private chatService: ChatService) {}

  @SubscribeMessage('chat:join')
  async join(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: ChannelPayload,
  ): Promise<Ack> {
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

  handleDisconnect(client: Socket): void {
    const { chatRooms: rooms, userId, chatName } = dataOf(client);
    if (!rooms || !userId) return;

    // Rooms are already gone at this point, so remember them ourselves to tell
    // peers this person stopped typing and (if no other tab) went offline.
    const stillOnline =
      (this.server.sockets.adapter.rooms.get(`user:${userId}`)?.size ?? 0) > 0;
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

  emitMessage(message: ChatMessageView): void {
    this.server
      .to(roomFor(message.channelType, message.channelId))
      .emit('chat:message', message);
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
