import { Logger } from '@nestjs/common';
import { ThrottlerStorage } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';

/**
 * Shares rate-limit counters across instances. Fails open: if Redis is unreachable
 * requests are allowed rather than rejected, because losing rate limiting briefly is
 * better than taking the whole API down with it.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger('Throttler');

  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const hitKey = `throttle:${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;
    try {
      const blockedMs = await this.redis.pttl(blockKey);
      if (blockedMs > 0) {
        return {
          totalHits: limit + 1,
          timeToExpire: blockedMs,
          isBlocked: true,
          timeToBlockExpire: blockedMs,
        };
      }

      const results = await this.redis
        .multi()
        .incr(hitKey)
        .pexpire(hitKey, ttl, 'NX')
        .pttl(hitKey)
        .exec();
      const totalHits = Number(results?.[0]?.[1] ?? 1);
      const timeToExpire = Math.max(Number(results?.[2]?.[1] ?? ttl), 0);

      if (totalHits > limit && blockDuration > 0) {
        await this.redis.set(blockKey, '1', 'PX', blockDuration);
        return { totalHits, timeToExpire, isBlocked: true, timeToBlockExpire: blockDuration };
      }
      return { totalHits, timeToExpire, isBlocked: totalHits > limit, timeToBlockExpire: 0 };
    } catch (err) {
      this.logger.warn(`Redis unavailable, allowing request: ${(err as Error).message}`);
      return { totalHits: 0, timeToExpire: ttl, isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}
