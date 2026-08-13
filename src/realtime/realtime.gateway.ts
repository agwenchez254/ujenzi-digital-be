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
  server: Server;

  constructor(
    private jwtService: JwtService,
    private prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
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

    await client.join(`user:${payload.sub}`);
    await Promise.all(payload.roles.map((role) => client.join(`role:${role}`)));

    const siteIds = await this.resolveSiteIds(payload.sub);
    await Promise.all(siteIds.map((siteId) => client.join(`site:${siteId}`)));

    const delay = Math.max(payload.exp * 1000 - Date.now(), 0);
    client.data.expiryTimeout = setTimeout(() => client.disconnect(true), delay);
  }

  handleDisconnect(client: Socket): void {
    const expiryTimeout = client.data?.expiryTimeout as NodeJS.Timeout | undefined;
    if (expiryTimeout) {
      clearTimeout(expiryTimeout);
    }
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
