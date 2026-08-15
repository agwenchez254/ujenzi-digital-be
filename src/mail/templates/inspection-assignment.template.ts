export interface InspectionAssignmentEmailData {
  engineerName: string;
  siteName: string;
  siteAddress: string;
  requestedByName: string;
  requestedDate: Date;
  notes?: string | null;
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

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function renderInspectionAssignmentHtml(data: InspectionAssignmentEmailData): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Inspection Request</title>
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
            <td style="padding:40px 40px 24px 40px;">
              <p style="margin:0 0 4px 0;font-size:13px;font-weight:600;color:#ff7a1a;text-transform:uppercase;letter-spacing:0.06em;">
                You've been requested for an inspection
              </p>
              <h1 style="margin:0 0 16px 0;font-size:24px;line-height:1.3;color:#111827;font-weight:700;">
                Hi ${escapeHtml(data.engineerName)}, ${escapeHtml(data.requestedByName)} needs your help
              </h1>
              <p style="margin:0;font-size:15px;line-height:1.6;color:#4b5563;">
                <strong>${escapeHtml(data.requestedByName)}</strong> has requested an inspection and named you as the
                engineer for it on SiteInspect.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:0 40px 24px 40px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e5e7eb;border-radius:10px;">
                <tr>
                  <td style="padding:20px 24px;">
                    <p style="margin:0 0 4px 0;font-size:17px;font-weight:700;color:#111827;">
                      ${escapeHtml(data.siteName)}
                    </p>
                    <p style="margin:0 0 14px 0;font-size:14px;color:#6b7280;">📍 ${escapeHtml(data.siteAddress)}</p>
                    <p style="margin:0;font-size:13px;color:#6b7280;">
                      <strong style="color:#374151;">Requested date:</strong> ${formatDate(data.requestedDate)}
                    </p>
                    ${
                      data.notes
                        ? `<p style="margin:8px 0 0 0;font-size:13px;color:#6b7280;">
                            <strong style="color:#374151;">Notes:</strong> ${escapeHtml(data.notes)}
                          </p>`
                        : ''
                    }
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:0 40px 32px 40px;" align="center">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="border-radius:8px;background-color:#ff7a1a;">
                    <a href="${data.link}" style="display:inline-block;padding:14px 32px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">
                      View Request
                    </a>
                  </td>
                </tr>
              </table>
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
