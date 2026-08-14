import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { MailModule } from '../mail/mail.module';
import { ContractorInvitationsController } from './contractor-invitations.controller';
import { ContractorInvitationsService } from './contractor-invitations.service';

@Module({
  imports: [AuditLogModule, MailModule],
  controllers: [ContractorInvitationsController],
  providers: [ContractorInvitationsService],
})
export class ContractorInvitationsModule {}
