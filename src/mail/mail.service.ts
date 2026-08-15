import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { renderContractorInvitationHtml } from './templates/contractor-invitation.template';
import { renderInspectionAssignmentHtml } from './templates/inspection-assignment.template';
import { renderPasswordResetHtml } from './templates/password-reset.template';
import { renderPersonnelInvitationHtml } from './templates/personnel-invitation.template';

export interface ContractorInvitationEmail {
  to: string;
  contractorName: string;
  siteName: string;
  developerName: string;
  token: string;
  isResend: boolean;
  // Non-sensitive site details shown in the email — no approvals, personnel,
  // or plot/legal identifiers.
  address: string;
  latitude: number;
  longitude: number;
  constructionPhase?: string | null;
  developmentType?: string | null;
  expectedEndDate?: Date | null;
  landmarks?: string[];
}

export interface PersonnelInvitationEmail {
  to: string;
  name: string;
  role: string;
  siteName: string;
  invitedByName: string;
  token: string;
  isResend: boolean;
}

export interface EmailChangeVerificationEmail {
  to: string;
  name: string;
  token: string;
}

export interface PasswordResetEmail {
  to: string;
  name: string;
  token: string;
}

export interface InspectionAssignmentEmail {
  to: string;
  engineerName: string;
  siteName: string;
  siteAddress: string;
  requestedByName: string;
  requestedDate: Date;
  notes?: string | null;
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

  private get frontendOrigin(): string {
    const raw = this.configService.get<string>('FRONTEND_ORIGIN') || 'http://localhost:8080';
    return raw.split(',')[0].trim();
  }

  async sendContractorInvitation(email: ContractorInvitationEmail): Promise<void> {
    const link = `${this.frontendOrigin}/invitations/accept?token=${email.token}&kind=contractor`;
    const subject = email.isResend
      ? `Reminder: you've been invited as contractor for ${email.siteName}`
      : `You've been invited as contractor for ${email.siteName}`;
    const text =
      `Hi ${email.contractorName},\n\n` +
      `${email.developerName} has named you as the contractor for "${email.siteName}" on Ujenzi Digital.\n\n` +
      `Site: ${email.siteName}\nAddress: ${email.address}\n\n` +
      `Accept the invitation here (expires in 48 hours):\n${link}\n\n` +
      `If you weren't expecting this, you can ignore this email.`;

    const html = renderContractorInvitationHtml({
      contractorName: email.contractorName,
      developerName: email.developerName,
      siteName: email.siteName,
      address: email.address,
      latitude: email.latitude,
      longitude: email.longitude,
      constructionPhase: email.constructionPhase,
      developmentType: email.developmentType,
      expectedEndDate: email.expectedEndDate,
      landmarks: email.landmarks,
      link,
      isResend: email.isResend,
    });

    await this.dispatch(email.to, subject, text, html, link);
  }

  async sendPersonnelInvitation(email: PersonnelInvitationEmail): Promise<void> {
    const link = `${this.frontendOrigin}/invitations/accept?token=${email.token}&kind=personnel`;
    const subject = email.isResend
      ? `Reminder: you've been added to ${email.siteName}`
      : `You've been added to ${email.siteName} on SiteInspect`;
    const text =
      `Hi ${email.name},\n\n` +
      `${email.invitedByName} has named you as the ${email.role.toLowerCase()} for "${email.siteName}" on Ujenzi Digital.\n\n` +
      `Create your account here (expires in 48 hours):\n${link}\n\n` +
      `If you weren't expecting this, you can ignore this email.`;

    const html = renderPersonnelInvitationHtml({
      name: email.name,
      role: email.role,
      siteName: email.siteName,
      invitedByName: email.invitedByName,
      link,
      isResend: email.isResend,
    });

    await this.dispatch(email.to, subject, text, html, link);
  }

  async sendEmailChangeVerification(email: EmailChangeVerificationEmail): Promise<void> {
    const link = `${this.frontendOrigin}/profile/confirm-email?token=${email.token}`;
    const subject = 'Confirm your new email address';
    const text =
      `Hi ${email.name},\n\n` +
      `Click the link below to confirm this is your new email address for SiteInspect (expires in 24 hours):\n${link}\n\n` +
      `If you didn't request this change, you can ignore this email and your address will stay the same.`;

    await this.dispatch(email.to, subject, text, undefined, link);
  }

  async sendInspectionAssignmentEmail(email: InspectionAssignmentEmail): Promise<void> {
    const link = `${this.frontendOrigin}/inspections`;
    const subject = `You've been requested to inspect ${email.siteName}`;
    const text =
      `Hi ${email.engineerName},\n\n` +
      `${email.requestedByName} has requested an inspection and named you as the engineer for "${email.siteName}" ` +
      `on Ujenzi Digital.\n\n` +
      `Site: ${email.siteName}\nAddress: ${email.siteAddress}\nRequested date: ${email.requestedDate.toDateString()}\n\n` +
      `View it here:\n${link}`;

    const html = renderInspectionAssignmentHtml({
      engineerName: email.engineerName,
      siteName: email.siteName,
      siteAddress: email.siteAddress,
      requestedByName: email.requestedByName,
      requestedDate: email.requestedDate,
      notes: email.notes,
      link,
    });

    await this.dispatch(email.to, subject, text, html, link);
  }

  async sendPasswordResetEmail(email: PasswordResetEmail): Promise<void> {
    const link = `${this.frontendOrigin}/reset-password?token=${email.token}`;
    const subject = 'Reset your SiteInspect password';
    const text =
      `Hi ${email.name},\n\n` +
      `We received a request to reset your password. Click the link below to choose a new one ` +
      `(expires in 1 hour):\n${link}\n\n` +
      `If you didn't request this, you can ignore this email and your password will stay the same.`;

    const html = renderPasswordResetHtml({ name: email.name, link });

    await this.dispatch(email.to, subject, text, html, link);
  }

  private async dispatch(to: string, subject: string, text: string, html: string | undefined, link: string) {
    if (!this.transporter) {
      this.logger.log(`[dev mail] To: ${to} | Subject: ${subject} | Link: ${link}`);
      return;
    }

    // Email delivery is best-effort — a rejected/failed send (bad recipient,
    // sandbox sender restrictions, transient SMTP issues) must never fail the
    // business operation it was triggered by, since that operation has
    // already been committed by the time we get here.
    try {
      await this.transporter.sendMail({
        from: this.configService.get<string>('SMTP_FROM'),
        to,
        subject,
        text,
        html,
      });
    } catch (error) {
      this.logger.warn(`Failed to send email to ${to}: ${(error as Error).message}`);
    }
  }
}
