export interface ContractorInvitationEmailData {
  contractorName: string;
  developerName: string;
  siteName: string;
  address: string;
  latitude: number;
  longitude: number;
  constructionPhase?: string | null;
  developmentType?: string | null;
  expectedEndDate?: Date | null;
  landmarks?: string[];
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

function humanize(value: string): string {
  return value
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function badge(label: string): string {
  return `
    <td style="padding:0 8px 0 0;">
      <span style="display:inline-block;padding:4px 10px;border-radius:999px;background-color:#eef2ff;color:#1a3366;font-size:12px;font-weight:600;">
        ${escapeHtml(label)}
      </span>
    </td>`;
}

export function renderContractorInvitationHtml(data: ContractorInvitationEmailData): string {
  const badges = [
    data.constructionPhase ? badge(data.constructionPhase) : '',
    data.developmentType ? badge(humanize(data.developmentType)) : '',
  ]
    .filter(Boolean)
    .join('');

  const mapUrl = `https://www.google.com/maps?q=${data.latitude},${data.longitude}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Contractor Invitation</title>
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
                ${data.isResend ? 'Reminder — invitation pending' : "You're invited"}
              </p>
              <h1 style="margin:0 0 16px 0;font-size:24px;line-height:1.3;color:#111827;font-weight:700;">
                Hi ${escapeHtml(data.contractorName)}, you've been named contractor
              </h1>
              <p style="margin:0;font-size:15px;line-height:1.6;color:#4b5563;">
                <strong>${escapeHtml(data.developerName)}</strong> has named you as the contractor of record for the
                site below on SiteInspect. Accept the invitation to take ownership and start managing inspections
                for it.
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
                    <p style="margin:0 0 14px 0;font-size:14px;color:#6b7280;">📍 ${escapeHtml(data.address)}</p>

                    ${badges ? `<table role="presentation" cellpadding="0" cellspacing="0"><tr>${badges}</tr></table>` : ''}

                    ${
                      data.expectedEndDate
                        ? `<p style="margin:14px 0 0 0;font-size:13px;color:#6b7280;">
                            <strong style="color:#374151;">Expected completion:</strong> ${formatDate(data.expectedEndDate)}
                          </p>`
                        : ''
                    }
                    ${
                      data.landmarks && data.landmarks.length > 0
                        ? `<p style="margin:8px 0 0 0;font-size:13px;color:#6b7280;">
                            <strong style="color:#374151;">Nearby:</strong> ${escapeHtml(data.landmarks.join(', '))}
                          </p>`
                        : ''
                    }

                    <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:16px;">
                      <tr>
                        <td style="border-radius:8px;background-color:#ffffff;border:1px solid #d1d5db;">
                          <a href="${mapUrl}" style="display:inline-block;padding:10px 18px;font-size:13px;font-weight:600;color:#1a3366;text-decoration:none;">
                            🗺️ View site location on map
                          </a>
                        </td>
                      </tr>
                    </table>
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
                      Accept Invitation
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
                If you weren't expecting this invitation, you can safely ignore this email — no account changes will
                be made without your acceptance.
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
