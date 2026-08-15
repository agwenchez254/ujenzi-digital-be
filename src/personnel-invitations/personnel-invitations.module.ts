import { Module } from '@nestjs/common';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { MailModule } from '../mail/mail.module';
import { PersonnelInvitationsController } from './personnel-invitations.controller';
import { PersonnelInvitationsService } from './personnel-invitations.service';

@Module({
  imports: [AuditLogModule, MailModule],
  controllers: [PersonnelInvitationsController],
  providers: [PersonnelInvitationsService],
})
export class PersonnelInvitationsModule {}
