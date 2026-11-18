import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { getSetting } from '../../platform/settings.service.js';

export type EmailProvider = 'smtp' | 'brevo' | 'resend' | 'sendgrid';

export interface EmailDeliveryResult {
  delivered: boolean;
  provider: EmailProvider | 'none';
  messageId?: string;
  error?: string;
}

export interface EmailOptions {
  to: string;
  subject: string;
  htmlContent: string;
  textContent?: string;
}

export interface SmtpSettings {
  host: string;
  port: number;
  user: string | null;
  pass: string | null;
}

interface ProviderConfig {
  provider: EmailProvider;
  /** API key for HTTP providers; the host name for SMTP */
  apiKey: string;
  smtp?: SmtpSettings;
}

/** Order matters: when `email.provider` is "auto", the first provider that has an API key wins (free tiers first). */
const PROVIDERS: { id: Exclude<EmailProvider, 'smtp'>; setting: string; env: string }[] = [
  { id: 'brevo', setting: 'email.brevoApiKey', env: 'BREVO_API_KEY' },
  { id: 'resend', setting: 'email.resendApiKey', env: 'RESEND_API_KEY' },
  { id: 'sendgrid', setting: 'email.sendgridApiKey', env: 'SENDGRID_API_KEY' },
];

type EnvReader = (name: string) => string | undefined;
const fromProcessEnv: EnvReader = (n) => process.env[n];

/** SMTP works with any mailbox or relay (Brevo, Gmail app password, Zoho, your host). OTP_SMTP_* names from other projects are accepted too. */
function resolveSmtp(env: EnvReader): SmtpSettings | null {
  const host = getSetting<string | null>('email.smtpHost') || env('SMTP_HOST') || env('OTP_SMTP_HOST');
  if (!host) return null;
  const port = Number(getSetting<number | null>('email.smtpPort') || env('SMTP_PORT') || env('OTP_SMTP_PORT') || 587);
  return {
    host,
    port: Number.isInteger(port) && port > 0 ? port : 587,
    user: getSetting<string | null>('email.smtpUser') || env('SMTP_USER') || env('OTP_SMTP_USER') || null,
    pass: getSetting<string | null>('email.smtpPass') || env('SMTP_PASS') || env('OTP_SMTP_PASS') || null,
  };
}

/** Which provider will be used right now, or null when no email provider is configured. Safe to call from anywhere. */
export function resolveEmailProvider(env: EnvReader = fromProcessEnv): ProviderConfig | null {
  const wanted = String(getSetting<string | null>('email.provider') || env('EMAIL_PROVIDER') || 'auto').toLowerCase();
  if (wanted === 'auto' || wanted === 'smtp') {
    const smtp = resolveSmtp(env);
    if (smtp) return { provider: 'smtp', apiKey: smtp.host, smtp };
    if (wanted === 'smtp') return null;
  }
  const candidates = wanted === 'auto' ? PROVIDERS : PROVIDERS.filter((p) => p.id === wanted);
  for (const p of candidates) {
    const apiKey = getSetting<string | null>(p.setting) || env(p.env) || null;
    if (apiKey) return { provider: p.id, apiKey };
  }
  return null;
}

const LABEL: Record<EmailProvider, string> = { smtp: 'SMTP', brevo: 'Brevo', resend: 'Resend', sendgrid: 'SendGrid' };

export const isEmailConfigured = () => resolveEmailProvider() !== null;

@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Dispatches transactional email through the configured provider (SMTP, or the Brevo / Resend / SendGrid HTTPS APIs).
   * Brevo and Resend both have a free tier, which is enough for password resets and OTPs at pilot scale.
   *
   * Returns delivered: true ONLY when the provider genuinely accepts the message. Never fabricates message IDs.
   * Never logs recipient addresses, codes, tokens or provider secrets.
   */
  async sendTransactionalEmail(options: EmailOptions): Promise<EmailDeliveryResult> {
    const cfg = resolveEmailProvider((n) => this.configService.get<string>(n) ?? process.env[n]);
    const fromEmail = getSetting<string | null>('email.fromEmail') || this.configService.get<string>('EMAIL_FROM') || this.configService.get<string>('OTP_FROM_EMAIL') || process.env.EMAIL_FROM || process.env.OTP_FROM_EMAIL || 'no-reply@pangat.in';
    const fromName = getSetting<string | null>('email.fromName') || 'Pangat Hospitality';

    if (!cfg) {
      this.logger.warn('No transactional email provider configured (set SMTP_HOST, BREVO_API_KEY, RESEND_API_KEY or SENDGRID_API_KEY). Email dispatch skipped.');
      return {
        delivered: false,
        provider: 'none',
        error: 'Transactional email provider is not configured. Add an API key under Settings > Email or set SMTP_HOST (+ SMTP_USER / SMTP_PASS) or an API key such as BREVO_API_KEY.',
      };
    }

    try {
      const res = await this.dispatch(cfg, { fromEmail, fromName }, options);
      if (res.ok) {
        this.logger.log(`Email dispatched via ${cfg.provider} (Provider ID: ${res.messageId || 'none'})`);
        return { delivered: true, provider: cfg.provider, ...(res.messageId ? { messageId: res.messageId } : {}) };
      }
      this.logger.error(`${cfg.provider} rejected the request with HTTP ${res.status}`);
      return { delivered: false, provider: cfg.provider, error: `${LABEL[cfg.provider]} HTTP ${res.status}: Request rejected by provider` };
    } catch (err: any) {
      this.logger.error(`${cfg.provider} transport failure: ${err?.message || 'Unknown network error'}`);
      return { delivered: false, provider: cfg.provider, error: err?.message || 'Network error during email dispatch' };
    }
  }

  private async dispatch(
    cfg: ProviderConfig,
    from: { fromEmail: string; fromName: string },
    o: EmailOptions,
  ): Promise<{ ok: boolean; status: number; messageId?: string }> {
    const json = { 'Content-Type': 'application/json' };

    if (cfg.provider === 'smtp') {
      const c = cfg.smtp!;
      const transport = nodemailer.createTransport({
        host: c.host,
        port: c.port,
        secure: c.port === 465, // 587/25 upgrade with STARTTLS
        requireTLS: c.port === 587, // never send credentials in clear on the standard submission port
        ...(c.user ? { auth: { user: c.user, pass: c.pass ?? '' } } : {}),
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
      });
      try {
        const info = await transport.sendMail({
          from: { name: from.fromName, address: from.fromEmail },
          to: o.to,
          subject: o.subject,
          html: o.htmlContent,
          ...(o.textContent ? { text: o.textContent } : {}),
        });
        const accepted = Array.isArray(info.accepted) && info.accepted.length > 0;
        return { ok: accepted, status: accepted ? 250 : 550, messageId: info.messageId };
      } finally {
        transport.close();
      }
    }

    if (cfg.provider === 'brevo') {
      const r = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { ...json, 'api-key': cfg.apiKey, accept: 'application/json' },
        body: JSON.stringify({
          sender: { email: from.fromEmail, name: from.fromName },
          to: [{ email: o.to }],
          subject: o.subject,
          htmlContent: o.htmlContent,
          ...(o.textContent ? { textContent: o.textContent } : {}),
        }),
      });
      const body: any = r.ok ? await r.json().catch(() => ({})) : {};
      return { ok: r.ok, status: r.status, messageId: body?.messageId };
    }

    if (cfg.provider === 'resend') {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { ...json, Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          from: `${from.fromName} <${from.fromEmail}>`,
          to: [o.to],
          subject: o.subject,
          html: o.htmlContent,
          ...(o.textContent ? { text: o.textContent } : {}),
        }),
      });
      const body: any = r.ok ? await r.json().catch(() => ({})) : {};
      return { ok: r.ok, status: r.status, messageId: body?.id };
    }

    const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { ...json, Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: o.to }], subject: o.subject }],
        from: { email: from.fromEmail, name: from.fromName },
        content: [
          { type: 'text/html', value: o.htmlContent },
          ...(o.textContent ? [{ type: 'text/plain', value: o.textContent }] : []),
        ],
      }),
    });
    const raw = r.headers.get('x-message-id');
    return { ok: r.status === 200 || r.status === 202, status: r.status, messageId: raw?.trim() || undefined };
  }
}
