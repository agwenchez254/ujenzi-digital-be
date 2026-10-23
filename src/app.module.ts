import { MiddlewareConsumer, Module, NestModule, RequestMethod } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import Redis from 'ioredis';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuditLogModule } from './audit-log/audit-log.module';
import { AuthModule } from './auth/auth.module';
import { ChatModule } from './chat/chat.module';
import { CommonModule } from './common/common.module';
import { CsrfMiddleware } from './common/csrf/csrf.middleware';
import { HttpLoggerMiddleware } from './common/middleware/http-logger.middleware';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { ContractorInvitationsModule } from './contractor-invitations/contractor-invitations.module';
import { E2eeModule } from './e2ee/e2ee.module';
import { HealthController } from './health/health.controller';
import { InspectionRequestsModule } from './inspection-requests/inspection-requests.module';
import { InspectionsModule } from './inspections/inspections.module';
import { MailModule } from './mail/mail.module';
import { MediaModule } from './media/media.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PermissionsModule } from './permissions/permissions.module';
import { PersonnelInvitationsModule } from './personnel-invitations/personnel-invitations.module';
import { PrismaModule } from './prisma/prisma.module';
import { REDIS_CLIENT, RedisModule } from './redis/redis.module';
import { RedisThrottlerStorage } from './redis/redis-throttler.storage';
import { RealtimeModule } from './realtime/realtime.module';
import { SitesModule } from './sites/sites.module';
import { UsersModule } from './users/users.module';
import { createObserveModule } from '@nestjs/observe';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY,
      appSecret: process.env.OBSERVE_APP_SECRET,
      serviceId: 'ujenzi-digital',
    }),
    ConfigModule.forRoot({ isGlobal: true }),
    RedisModule,
    ThrottlerModule.forRootAsync({
      inject: [REDIS_CLIENT],
      useFactory: (redis: Redis | null) => ({
        throttlers: [{ ttl: 60_000, limit: 20 }],
        // Shared counters when Redis is configured, in-memory otherwise.
        ...(redis ? { storage: new RedisThrottlerStorage(redis) } : {}),
      }),
    }),
    PrismaModule,
    CommonModule,
    AuditLogModule,
    AuthModule,
    ChatModule,
    ContractorInvitationsModule,
    E2eeModule,
    InspectionRequestsModule,
    InspectionsModule,
    MailModule,
    MediaModule,
    NotificationsModule,
    PermissionsModule,
    PersonnelInvitationsModule,
    RealtimeModule,
    SitesModule,
    UsersModule,
  ],
  controllers: [AppController, HealthController],
  providers: [
    AppService,
    // Global — previously only applied to AuthController, leaving every
    // other public/unauthenticated route (contractor/personnel invitation
    // preview, the public site page, the VAPID key, email-change confirm)
    // with no throttling at all.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(HttpLoggerMiddleware).forRoutes('*');

    consumer
      .apply(CsrfMiddleware)
      .forRoutes(
        { path: 'auth/refresh', method: RequestMethod.POST },
        { path: 'auth/logout', method: RequestMethod.POST },
      );
  }
}
