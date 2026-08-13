import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PushSubscriptionsController } from './push-subscriptions.controller';
import { PushSubscriptionsService } from './push-subscriptions.service';
import { PushService } from './push.service';
import { RealtimeEventsService } from './realtime-events.service';
import { RealtimeGateway } from './realtime.gateway';

@Module({
  imports: [JwtModule.register({})],
  controllers: [PushSubscriptionsController],
  providers: [RealtimeGateway, RealtimeEventsService, PushService, PushSubscriptionsService],
  exports: [RealtimeEventsService],
})
export class RealtimeModule {}
