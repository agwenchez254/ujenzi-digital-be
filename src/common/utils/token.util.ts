import { createHash, randomBytes } from 'crypto';

export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// Shared by every place that needs to hand someone an invitation link — the
// email templates, and the API responses that expose the same link directly
// (e.g. for copying/sharing outside of email) so both channels always agree
// on the exact URL format.
export function buildInvitationLink(
  frontendOrigin: string,
  token: string,
  kind: 'contractor' | 'personnel',
): string {
  const origin = frontendOrigin.split(',')[0].trim();
  return `${origin}/invitations/accept?token=${token}&kind=${kind}`;
}
