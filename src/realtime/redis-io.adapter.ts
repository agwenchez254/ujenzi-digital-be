import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { ServerOptions } from 'socket.io';

/**
 * Relays socket.io events through Redis pub/sub so `server.to(room).emit()` reaches
 * clients connected to any instance, not just the one that emitted.
 *
 * Uses its own pub/sub connections with ioredis defaults (queue + reconnect) rather
 * than the app's fail-fast client: the adapter publishes without catching errors, and
 * subscribes before the socket is open. Local delivery still works during an outage.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger('RedisIoAdapter');
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private readonly clients: Redis[] = [];

  constructor(
    app: INestApplicationContext,
    private readonly redisUrl: string,
  ) {
    super(app);
  }

  connect(): void {
    const [pub, sub] = [new Redis(this.redisUrl), new Redis(this.redisUrl)];
    for (const client of [pub, sub]) {
      client.on('error', (err) => this.logger.error(`Connection error: ${err.message}`));
      this.clients.push(client);
    }
    this.adapterConstructor = createAdapter(pub, sub);
  }

  createIOServer(port: number, options?: ServerOptions) {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }

  async dispose(): Promise<void> {
    await super.dispose();
    await Promise.all(this.clients.map((c) => c.quit().catch(() => undefined)));
  }
}
