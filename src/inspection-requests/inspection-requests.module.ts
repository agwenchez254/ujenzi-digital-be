import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { InspectionRequestsController } from './inspection-requests.controller';
import { InspectionRequestsService } from './inspection-requests.service';

@Module({
  imports: [AuditLogModule],
  controllers: [InspectionRequestsController],
  providers: [InspectionRequestsService],
})
export class InspectionRequestsModule {}
