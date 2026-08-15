export interface PasswordResetEmailData {
  name: string;
  link: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderPasswordResetHtml(data: PasswordResetEmailData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Reset Your Password</title>
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
                Password reset requested
              </p>
              <h1 style="margin:0 0 16px 0;font-size:24px;line-height:1.3;color:#111827;font-weight:700;">
                Hi ${escapeHtml(data.name)}, reset your password
              </h1>
              <p style="margin:0 0 20px 0;font-size:15px;line-height:1.6;color:#4b5563;">
                We received a request to reset your SiteInspect password. Click the button below to choose a new one.
                If you didn't request this, you can safely ignore this email — your password won't change.
              </p>

              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:8px;background-color:#ff7a1a;">
                    <a href="${data.link}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">
                      Reset Password
                    </a>
                  </td>
                </tr>
              </table>
              <p style="margin:16px 0 0 0;font-size:13px;color:#9ca3af;">This link expires in 1 hour.</p>
            </td>
          </tr>

          <tr>
            <td style="padding:24px 40px;background-color:#f8fafc;border-top:1px solid #e5e7eb;">
              <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
                Or paste this link into your browser:
                <a href="${data.link}" style="color:#1a3366;word-break:break-all;">${data.link}</a>
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
