import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module';
import { SitesModule } from '../sites/sites.module';
import { StorageModule } from '../storage/storage.module';
import { ChatController } from './chat.controller';
import { ChatKeysController } from './chat-keys.controller';
import { ChatKeysService } from './chat-keys.service';
import { ChatGateway } from './chat.gateway';
import { ChatService } from './chat.service';

@Module({
  imports: [SitesModule, RealtimeModule, StorageModule],
  controllers: [ChatController, ChatKeysController],
  providers: [ChatService, ChatKeysService, ChatGateway],
})
export class ChatModule {}
