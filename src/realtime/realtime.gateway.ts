import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { JwtService } from '@nestjs/jwt';
import { Server, Socket } from 'socket.io';
import { PrismaService } from '../prisma/prisma.service';
import { AccessTokenPayload } from '../auth/types/jwt-payload.type';

interface VerifiedAccessTokenPayload extends AccessTokenPayload {
  exp: number;
}

@WebSocketGateway({ cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  constructor(
    private jwtService: JwtService,
    private prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    // Other gateways (chat) await this before trusting client.data.userId,
    // since socket.io fires their message handlers as soon as the socket opens.
    client.data.ready = this.authenticate(client);
    await client.data.ready;
  }

  private async authenticate(client: Socket): Promise<void> {
    const token = client.handshake.auth?.token as string | undefined;
    if (!token) {
      client.disconnect(true);
      return;
    }

    let payload: VerifiedAccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync(token, {
        secret: process.env.JWT_ACCESS_SECRET,
      });
    } catch {
      client.disconnect(true);
      return;
    }

    client.data.userId = payload.sub;
    client.data.roles = payload.roles;

    await client.join(`user:${payload.sub}`);
    await Promise.all(payload.roles.map((role) => client.join(`role:${role}`)));

    const siteIds = await this.resolveSiteIds(payload.sub);
    client.data.siteIds = siteIds;
    await Promise.all(siteIds.map((siteId) => client.join(`site:${siteId}`)));

    // First socket for this user: tell the people they work with they're online.
    if ((await this.socketCount(payload.sub)) === 1) {
      this.emitPresence(siteIds, payload.sub, true);
    }

    const delay = Math.max(payload.exp * 1000 - Date.now(), 0);
    client.data.expiryTimeout = setTimeout(() => client.disconnect(true), delay);
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const expiryTimeout = client.data?.expiryTimeout as NodeJS.Timeout | undefined;
    if (expiryTimeout) {
      clearTimeout(expiryTimeout);
    }

    // Last socket gone (not just one of several tabs): they're offline.
    const userId = client.data?.userId as string | undefined;
    if (userId && (await this.socketCount(userId)) === 0) {
      this.emitPresence((client.data.siteIds as string[] | undefined) ?? [], userId, false);
    }
  }

  // fetchSockets spans every instance when the Redis adapter is active.
  private async socketCount(userId: string): Promise<number> {
    return (await this.server.in(`user:${userId}`).fetchSockets()).length;
  }

  private emitPresence(siteIds: string[], userId: string, online: boolean): void {
    if (!siteIds.length) return;
    this.server.to(siteIds.map((id) => `site:${id}`)).emit('presence:update', { userId, online });
  }

  private async resolveSiteIds(userId: string): Promise<string[]> {
    const [personnelSites, ownedSites] = await Promise.all([
      this.prisma.sitePersonnel.findMany({ where: { userId }, select: { siteId: true } }),
      this.prisma.site.findMany({ where: { contractorId: userId }, select: { id: true } }),
    ]);
    const ids = new Set<string>();
    personnelSites.forEach((p) => ids.add(p.siteId));
    ownedSites.forEach((s) => ids.add(s.id));
    return [...ids];
  }
}
