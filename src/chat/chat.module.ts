import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { SitesModule } from '../sites/sites.module';
import { ChatController } from './chat.controller';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';

@Module({
  imports: [SitesModule, RealtimeModule],
  controllers: [ChatController],
  providers: [ChatService, ChatGateway],
})
export class ChatModule {}
