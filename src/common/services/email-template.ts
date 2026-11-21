import { getSetting } from '../../platform/settings.service.js';

/**
 * One minimal, branded layout for every email Pangat sends (sign-in codes, password resets, announcements, alerts).
 * Email-client safe: table layout, inline styles, system fonts, a hidden preheader for the inbox preview, a bulletproof
 * button, a dark-mode variant and a plain-text twin. Every caller-supplied string is HTML-escaped here, so callers pass plain text.
 *
 * Logo: the app icon is served by the web app at /email/pangat-logo.png. It is used when FRONTEND_URL is an https address
 * (or when Super Admin > Settings > Branding > Logo URL is set); otherwise the header falls back to the wordmark alone.
 */

export interface EmailContent {
  /** Short inbox preview line shown after the subject */
  preheader?: string;
  heading: string;
  /** "Namaskar {name}," greeting; omit for a generic one */
  name?: string | null;
  /** Plain-text paragraphs; a single newline inside one becomes a line break */
  paragraphs: string[];
  /** One-time code, shown large and spaced out */
  code?: string;
  button?: { label: string; url: string };
  /** Small print under the main content (expiry, "if this was not you...") */
  note?: string;
}

export const escapeEmailHtml = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

/** Only http(s) links may become buttons or images; anything else (javascript:, data:) is dropped. */
function safeUrl(u: string): string | null {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.toString() : null;
  } catch {
    return null;
  }
}

/** Public https URL of the logo image, or null when there is no address an email client could fetch it from. */
export function emailLogoUrl(): string | null {
  const configured = getSetting<string | null>('branding.logoUrl');
  if (configured) {
    const u = safeUrl(configured);
    if (u) return u;
  }
  const base = (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '');
  return base.startsWith('https://') ? `${base}/email/pangat-logo.png` : null;
}

const para = (s: string) => escapeEmailHtml(s).replace(/\r?\n/g, '<br>');

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function renderEmail(c: EmailContent): { html: string; text: string } {
  const platform = String(getSetting<string | null>('branding.platformName') || 'Pangat');
  const supportEmail = getSetting<string | null>('branding.supportEmail');
  const url = c.button ? safeUrl(c.button.url) : null;
  const logo = emailLogoUrl();
  const greeting = c.name ? `Namaskar ${escapeEmailHtml(c.name)},` : 'Namaskar,';

  const logoCell = logo
    ? `<img src="${escapeEmailHtml(logo)}" width="40" height="40" alt="" style="display:block;border:0;outline:none;border-radius:10px">`
    : '';

  const codeBlock = c.code
    ? `<tr><td style="padding:4px 0 24px">
        <div class="pg-code" style="background:#f3f4f6;border-radius:10px;padding:18px 12px 18px 20px;text-align:center;font-family:'SFMono-Regular',ui-monospace,Menlo,Consolas,'Courier New',monospace;font-size:32px;line-height:36px;font-weight:700;letter-spacing:8px;color:#111827">${escapeEmailHtml(c.code)}</div>
      </td></tr>`
    : '';

  const buttonBlock = url
    ? `<tr><td style="padding:4px 0 20px">
        <a href="${escapeEmailHtml(url)}" style="background:#059669;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;line-height:20px;padding:12px 28px;border-radius:8px;display:inline-block">${escapeEmailHtml(c.button!.label)}</a>
      </td></tr>
      <tr><td class="pg-muted" style="padding:0 0 20px;font-size:12px;line-height:18px;color:#6b7280;word-break:break-all">Or paste this link into your browser:<br><a href="${escapeEmailHtml(url)}" style="color:#047857">${escapeEmailHtml(url)}</a></td></tr>`
    : '';

  const noteBlock = c.note
    ? `<tr><td class="pg-rule" style="border-top:1px solid #eceef1;padding:20px 0 0"></td></tr>
      <tr><td class="pg-muted" style="font-size:13px;line-height:20px;color:#6b7280">${para(c.note)}</td></tr>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${escapeEmailHtml(c.heading)}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .pg-body { background:#0b0d10 !important }
    .pg-card { background:#14171c !important; border-color:#262b33 !important }
    .pg-text { color:#e5e7eb !important }
    .pg-muted { color:#9ca3af !important }
    .pg-rule { border-color:#262b33 !important }
    .pg-code { background:#1c2128 !important; color:#f9fafb !important }
  }
  @media (max-width:520px) { .pg-pad { padding:28px 22px !important } .pg-code { font-size:26px !important; letter-spacing:6px !important } }
</style></head>
<body class="pg-body" style="margin:0;padding:0;background:#f5f6f8;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeEmailHtml(c.preheader || c.heading)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" class="pg-body" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f6f8"><tr><td align="center" style="padding:40px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">
    <tr><td align="center" style="padding:0 0 24px">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        ${logoCell ? `<td style="padding-right:10px;vertical-align:middle">${logoCell}</td>` : ''}
        <td class="pg-text" style="vertical-align:middle;font-family:${FONT};font-size:20px;font-weight:700;letter-spacing:-0.2px;color:#111827">${escapeEmailHtml(platform)}</td>
      </tr></table>
    </td></tr>
    <tr><td class="pg-card" style="background:#ffffff;border:1px solid #e5e7eb;border-radius:14px">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="pg-pad pg-text" style="padding:36px 40px;font-family:${FONT};font-size:15px;line-height:24px;color:#374151">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td class="pg-text" style="padding:0 0 12px;font-size:20px;line-height:28px;font-weight:600;color:#111827">${escapeEmailHtml(c.heading)}</td></tr>
          <tr><td class="pg-text" style="padding:0 0 12px">${greeting}</td></tr>
          ${c.paragraphs.map((p) => `<tr><td class="pg-text" style="padding:0 0 14px">${para(p)}</td></tr>`).join('\n          ')}
          ${codeBlock}
          ${buttonBlock}
          ${noteBlock}
        </table>
      </td></tr></table>
    </td></tr>
    <tr><td class="pg-muted" align="center" style="padding:24px 8px 0;font-family:${FONT};font-size:12px;line-height:19px;color:#9ca3af">
      ${escapeEmailHtml(platform)} &middot; पंगत<br>
      Modern dining speed, rooted in timeless hospitality.<br>
      ${supportEmail ? `Need help? <a href="mailto:${escapeEmailHtml(supportEmail)}" style="color:#6b7280">${escapeEmailHtml(supportEmail)}</a>` : ''}
    </td></tr>
  </table>
</td></tr></table>
</body></html>`;

  const text = [
    c.name ? `Namaskar ${c.name},` : 'Namaskar,',
    '',
    c.heading,
    '',
    ...c.paragraphs.flatMap((p) => [p, '']),
    ...(c.code ? [`Code: ${c.code}`, ''] : []),
    ...(url ? [`${c.button!.label}: ${url}`, ''] : []),
    ...(c.note ? [c.note, ''] : []),
    `— ${platform}`,
  ].join('\n');

  return { html, text };
}
