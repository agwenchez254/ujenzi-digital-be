import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { MailModule } from '../mail/mail.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { StorageModule } from '../storage/storage.module';
import { SiteDocumentsController } from './site-documents.controller';
import { SiteDocumentsService } from './site-documents.service';
import { PublicSitesController } from './public-sites.controller';
import { SitesController } from './sites.controller';
import { SitesService } from './sites.service';

@Module({
  imports: [AuditLogModule, MailModule, RealtimeModule, StorageModule],
  controllers: [SitesController, SiteDocumentsController, PublicSitesController],
  providers: [SitesService, SiteDocumentsService],
  exports: [SitesService],
})
export class SitesModule {}
