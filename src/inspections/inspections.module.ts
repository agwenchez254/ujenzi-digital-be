import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { SitesModule } from '../sites/sites.module';
import { InspectionsController } from './inspections.controller';
import { InspectionsService } from './inspections.service';

@Module({
  imports: [AuditLogModule, SitesModule, RealtimeModule],
  controllers: [InspectionsController],
  providers: [InspectionsService],
})
export class InspectionsModule {}
