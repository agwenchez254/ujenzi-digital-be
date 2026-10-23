import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { ServerOptions } from 'socket.io';

/** Chat messages travel over REST; socket events are tiny, so a small buffer is plenty. */
const MAX_SOCKET_PAYLOAD_BYTES = 64 * 1024;

/**
 * The one place socket.io is configured, so every gateway gets the same protections:
 *
 * - Only the frontend origins may open a browser connection. WebSockets are not covered
 *   by CORS, so the Origin header is checked on every handshake (cross-site WebSocket
 *   hijacking). Clients that send no Origin (native apps, curl) are still allowed, as
 *   with the HTTP CORS policy; they must authenticate with a token either way.
 * - Oversized payloads are refused by the transport.
 * - When REDIS_URL is set, events are relayed between instances through Redis pub/sub.
 *   It uses its own pub/sub connections with ioredis defaults (queue + reconnect): the
 *   adapter publishes without catching errors and subscribes before the socket is open.
 *   Local delivery still works during a Redis outage.
 */
export class RealtimeIoAdapter extends IoAdapter {
  private readonly logger = new Logger('RealtimeIoAdapter');
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private readonly clients: Redis[] = [];

  constructor(
    app: INestApplicationContext,
    private readonly allowedOrigins: string[],
    private readonly redisUrl?: string,
  ) {
    super(app);
  }

  connect(): void {
    if (!this.redisUrl) return;
    const [pub, sub] = [new Redis(this.redisUrl), new Redis(this.redisUrl)];
    for (const client of [pub, sub]) {
      client.on('error', (err) => this.logger.error(`Connection error: ${err.message}`));
      this.clients.push(client);
    }
    this.adapterConstructor = createAdapter(pub, sub);
  }

  isOriginAllowed(origin: string | undefined): boolean {
    return (
      !origin || this.allowedOrigins.includes('*') || this.allowedOrigins.includes(origin)
    );
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: this.allowedOrigins, credentials: true },
      maxHttpBufferSize: MAX_SOCKET_PAYLOAD_BYTES,
      allowRequest: (req, callback) => {
        const allowed = this.isOriginAllowed(req.headers.origin);
        if (!allowed) this.logger.warn(`Rejected socket from origin ${req.headers.origin}`);
        callback(null, allowed);
      },
    } as ServerOptions);
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }

  async dispose(): Promise<void> {
    await super.dispose();
    await Promise.all(this.clients.map((c) => c.quit().catch(() => undefined)));
  }
}
