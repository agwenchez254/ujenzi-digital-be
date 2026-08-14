import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { SitesModule } from '../sites/sites.module';
import { StorageModule } from '../storage/storage.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

@Module({
  imports: [AuditLogModule, StorageModule, SitesModule],
  controllers: [MediaController],
  providers: [MediaService],
})
export class MediaModule {}
