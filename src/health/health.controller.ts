import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/public.decorator';
import { PrismaService } from '../prisma/prisma.service';

const DB_CHECK_TIMEOUT_MS = 2000;

/**
 * Liveness vs readiness are separate on purpose: a DB outage should take the instance
 * out of the load balancer (readiness) without making the orchestrator restart it
 * (liveness), which would only add connection storms to a recovering database.
 */
@Public()
@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('live')
  live() {
    return { status: 'ok', uptime: Math.round(process.uptime()) };
  }

  @Get('ready')
  async ready() {
    const started = Date.now();
    try {
      await Promise.race([
        this.prisma.$queryRaw`SELECT 1`,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), DB_CHECK_TIMEOUT_MS).unref(),
        ),
      ]);
    } catch {
      throw new ServiceUnavailableException({ status: 'unavailable', database: 'down' });
    }
    return { status: 'ok', database: 'up', dbLatencyMs: Date.now() - started };
  }
}
