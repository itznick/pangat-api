import { getSetting } from '../../platform/settings.service.js';

/**
 * One branded layout for every email Pangat sends (sign-in codes, password resets, announcements, alerts).
 * Email-client safe: table layout, inline styles, no images or web fonts (so nothing is blocked or tracked),
 * a hidden preheader line for the inbox preview, a bulletproof button, and a dark-mode variant for clients that support it.
 * Every caller-supplied string is HTML-escaped here, so callers pass plain text.
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

/** Only http(s) links may become buttons; anything else (javascript:, data:) falls back to no button. */
function safeUrl(u: string): string | null {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.toString() : null;
  } catch {
    return null;
  }
}

const para = (s: string) => escapeEmailHtml(s).replace(/\r?\n/g, '<br>');

export function renderEmail(c: EmailContent): { html: string; text: string } {
  const platform = String(getSetting<string | null>('branding.platformName') || 'Pangat');
  const supportEmail = getSetting<string | null>('branding.supportEmail');
  const url = c.button ? safeUrl(c.button.url) : null;
  const greeting = c.name ? `Namaskar ${escapeEmailHtml(c.name)},` : 'Namaskar,';

  const codeBlock = c.code
    ? `<tr><td align="center" style="padding:8px 0 24px">
        <div class="pg-code" style="display:inline-block;background:#ecfdf5;border:1px dashed #6ee7b7;border-radius:12px;padding:16px 18px 16px 28px;font-family:'SFMono-Regular',Menlo,Consolas,'Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#065f46">${escapeEmailHtml(c.code)}</div>
      </td></tr>`
    : '';

  const buttonBlock = url
    ? `<tr><td align="center" style="padding:8px 0 24px">
        <a href="${escapeEmailHtml(url)}" style="background:#059669;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:14px 32px;border-radius:10px;display:inline-block;mso-padding-alt:0">${escapeEmailHtml(c.button!.label)}</a>
      </td></tr>
      <tr><td style="padding:0 0 20px;font-size:12px;line-height:18px;color:#6b7280;word-break:break-all">Button not working? Paste this link into your browser:<br><a href="${escapeEmailHtml(url)}" style="color:#047857">${escapeEmailHtml(url)}</a></td></tr>`
    : '';

  const noteBlock = c.note
    ? `<tr><td class="pg-muted" style="padding:4px 0 0;font-size:13px;line-height:20px;color:#6b7280">${para(c.note)}</td></tr>`
    : '';

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${escapeEmailHtml(c.heading)}</title>
<style>
  @media (prefers-color-scheme: dark) {
    .pg-body { background:#0b0f0d !important }
    .pg-card { background:#151a18 !important }
    .pg-text { color:#e5e7eb !important }
    .pg-muted { color:#9ca3af !important }
    .pg-code { background:#10261d !important; border-color:#047857 !important; color:#6ee7b7 !important }
  }
  @media (max-width:520px) { .pg-pad { padding:24px 20px !important } .pg-code { font-size:28px !important; letter-spacing:6px !important; padding:14px 18px !important } }
</style></head>
<body class="pg-body" style="margin:0;padding:0;background:#f4f1ea;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeEmailHtml(c.preheader || c.heading)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea" class="pg-body"><tr><td align="center" style="padding:32px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">
    <tr><td style="padding:0 4px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
      <span style="font-size:22px;font-weight:700;letter-spacing:-0.3px;color:#065f46">${escapeEmailHtml(platform)}</span>
      <span class="pg-muted" style="font-size:13px;color:#9a8f7a;padding-left:8px">पंगत</span>
    </td></tr>
    <tr><td class="pg-card" style="background:#ffffff;border-radius:16px;border-top:4px solid #059669;box-shadow:0 1px 3px rgba(0,0,0,.08)">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td class="pg-pad pg-text" style="padding:36px 40px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:24px;color:#1f2937">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:0 0 6px;font-size:22px;line-height:28px;font-weight:700;color:#111827" class="pg-text">${escapeEmailHtml(c.heading)}</td></tr>
          <tr><td style="padding:0 0 16px;color:#6b7280" class="pg-muted">${greeting}</td></tr>
          ${c.paragraphs.map((p) => `<tr><td class="pg-text" style="padding:0 0 16px">${para(p)}</td></tr>`).join('\n          ')}
          ${codeBlock}
          ${buttonBlock}
          ${noteBlock}
        </table>
      </td></tr></table>
    </td></tr>
    <tr><td class="pg-muted" align="center" style="padding:20px 8px 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#9a8f7a">
      Modern dining speed, rooted in timeless hospitality.<br>
      ${supportEmail ? `Need help? <a href="mailto:${escapeEmailHtml(supportEmail)}" style="color:#047857">${escapeEmailHtml(supportEmail)}</a><br>` : ''}
      You received this because of activity on your ${escapeEmailHtml(platform)} account.
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
