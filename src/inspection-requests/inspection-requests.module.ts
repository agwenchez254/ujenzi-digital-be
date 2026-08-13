import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { InspectionRequestsController } from './inspection-requests.controller';
import { InspectionRequestsService } from './inspection-requests.service';

@Module({
  imports: [AuditLogModule, RealtimeModule],
  controllers: [InspectionRequestsController],
  providers: [InspectionRequestsService],
})
export class InspectionRequestsModule {}
