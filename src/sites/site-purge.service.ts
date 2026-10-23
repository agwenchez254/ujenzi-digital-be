import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SitesService } from './sites.service';

// Arbitrary constant identifying this job in Postgres advisory locks.
const PURGE_LOCK_ID = 727_001;
const LOCK_TX_TIMEOUT_MS = 30 * 60 * 1000;

const FIRST_RUN_DELAY_MS = 60 * 1000;
const RUN_EVERY_MS = 6 * 60 * 60 * 1000;

/** Removes sites for good once they have been soft deleted for longer than the retention window. */
@Injectable()
export class SitePurgeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SitePurgeService.name);
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private sitesService: SitesService,
    private prisma: PrismaService,
  ) {}

  onModuleInit() {
    if (process.env.NODE_ENV === 'test') return;
    const first = setTimeout(() => void this.run(), FIRST_RUN_DELAY_MS);
    const repeat = setInterval(() => void this.run(), RUN_EVERY_MS);
    // Never keep the process alive just for housekeeping.
    first.unref();
    repeat.unref();
    this.timers = [first, repeat];
  }

  onModuleDestroy() {
    this.timers.forEach((timer) => clearTimeout(timer));
  }

  async run(): Promise<void> {
    try {
      // With N instances every one runs this timer. A transaction-scoped advisory lock
      // (held by an otherwise idle transaction while the work uses other pooled
      // connections) lets exactly one instance do the purge per cycle.
      await this.prisma.$transaction(
        async (tx) => {
          const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${PURGE_LOCK_ID}) AS locked`;
          if (!locked) return;
          const purged = await this.sitesService.purgeExpired();
          if (purged > 0) this.logger.log(`Purged ${purged} site(s) deleted more than 30 days ago`);
        },
        { timeout: LOCK_TX_TIMEOUT_MS, maxWait: 5000 },
      );
    } catch (error) {
      this.logger.error('Site purge failed', error instanceof Error ? error.stack : String(error));
    }
  }
}
