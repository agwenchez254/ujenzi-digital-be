import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

export interface ContractorInvitationEmail {
  to: string;
  contractorName: string;
  siteName: string;
  developerName: string;
  token: string;
  isResend: boolean;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;

  constructor(private configService: ConfigService) {
    const host = this.configService.get<string>('SMTP_HOST');
    if (host) {
      this.transporter = nodemailer.createTransport({
        host,
        port: this.configService.get<number>('SMTP_PORT') ?? 587,
        auth: {
          user: this.configService.get<string>('SMTP_USER'),
          pass: this.configService.get<string>('SMTP_PASS'),
        },
      });
    }
  }

  async sendContractorInvitation(email: ContractorInvitationEmail): Promise<void> {
    const link = `${this.configService.get<string>('FRONTEND_ORIGIN')}/invitations/accept?token=${email.token}`;
    const subject = email.isResend
      ? `Reminder: you've been invited as contractor for ${email.siteName}`
      : `You've been invited as contractor for ${email.siteName}`;
    const text =
      `Hi ${email.contractorName},\n\n` +
      `${email.developerName} has named you as the contractor for "${email.siteName}" on Ujenzi Digital.\n\n` +
      `Accept the invitation here (expires in 48 hours):\n${link}\n\n` +
      `If you weren't expecting this, you can ignore this email.`;

    if (!this.transporter) {
      this.logger.log(`[dev mail] To: ${email.to} | Subject: ${subject} | Link: ${link}`);
      return;
    }

    await this.transporter.sendMail({
      from: this.configService.get<string>('SMTP_FROM'),
      to: email.to,
      subject,
      text,
    });
  }
}
