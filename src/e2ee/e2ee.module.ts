import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { E2eeController } from './e2ee.controller';
import { E2eeService } from './e2ee.service';

@Module({
  imports: [AuditLogModule],
  controllers: [E2eeController],
  providers: [E2eeService],
})
export class E2eeModule {}
