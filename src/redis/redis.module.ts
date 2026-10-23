import { Global, Inject, Logger, Module, OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');

/**
 * Redis is optional: without REDIS_URL the provider is null and every consumer falls
 * back to per-process behaviour (fine for local dev and a single instance). Multiple
 * instances need it so rate limits and realtime events are shared between them.
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (): Redis | null => {
        const url = process.env.REDIS_URL;
        if (!url) return null;
        const logger = new Logger('Redis');
        const client = new Redis(url, {
          // Fail fast instead of queueing commands while Redis is down, so a Redis
          // outage degrades features rather than stalling every request.
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
          connectTimeout: 3000,
          retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
        });
        client.on('error', (err) => logger.error(`Connection error: ${err.message}`));
        client.on('ready', () => logger.log('Connected'));
        return client;
      },
    },
  ],
  exports: [REDIS_CLIENT],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis | null) {}

  async onApplicationShutdown() {
    await this.redis?.quit().catch(() => undefined);
  }
}
