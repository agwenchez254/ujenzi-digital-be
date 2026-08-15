export interface PersonnelInvitationEmailData {
  name: string;
  role: string;
  siteName: string;
  invitedByName: string;
  link: string;
  isResend: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function humanizeRole(role: string): string {
  return role
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function renderPersonnelInvitationHtml(data: PersonnelInvitationEmailData): string {
  const roleLabel = humanizeRole(data.role);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Site Invitation</title>
<style>
  body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  @media only screen and (max-width: 600px) {
    .email-container { width: 100% !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:#f1f2f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f1f2f4;padding:32px 0;">
    <tr>
      <td align="center">
        <table role="presentation" class="email-container" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="background-color:#1a3366;padding:28px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.02em;">SiteInspect</td>
                  <td align="right" style="font-size:11px;font-weight:600;color:#ff9d5c;text-transform:uppercase;letter-spacing:0.08em;">
                    Construction QA
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr><td style="height:4px;background-color:#ff7a1a;line-height:4px;font-size:0;">&nbsp;</td></tr>

          <tr>
            <td style="padding:40px 40px 32px 40px;">
              <p style="margin:0 0 4px 0;font-size:13px;font-weight:600;color:#ff7a1a;text-transform:uppercase;letter-spacing:0.06em;">
                ${data.isResend ? 'Reminder — invitation pending' : "You're invited"}
              </p>
              <h1 style="margin:0 0 16px 0;font-size:24px;line-height:1.3;color:#111827;font-weight:700;">
                Hi ${escapeHtml(data.name)}, you've been added to a site
              </h1>
              <p style="margin:0 0 20px 0;font-size:15px;line-height:1.6;color:#4b5563;">
                <strong>${escapeHtml(data.invitedByName)}</strong> has named you as the
                <strong>${escapeHtml(roleLabel)}</strong> for <strong>${escapeHtml(data.siteName)}</strong> on
                SiteInspect. Create your account to get access.
              </p>

              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:8px;background-color:#ff7a1a;">
                    <a href="${data.link}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">
                      Create Account
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:16px 0 0 0;font-size:13px;color:#9ca3af;">This invitation expires in 48 hours.</p>
            </td>
          </tr>

          <tr>
            <td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
                If you weren't expecting this invitation, you can safely ignore this email.
              </p>
              <p style="margin:8px 0 0 0;font-size:12px;color:#9ca3af;word-break:break-all;">
                Or paste this link into your browser:
                <a href="${data.link}" style="color:#1a3366;">${data.link}</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
