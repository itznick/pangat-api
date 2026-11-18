import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { EmailDeliveryService, isEmailConfigured } from './email-delivery.service.js';
import { escapeHtml } from '../../platform/events.service.js';
import { resolveSettingsKey } from '../security/secrets.js';

export type OtpPurpose = 'LOGIN' | 'SIGNUP';

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60_000;
export const OTP_MAX_PER_HOUR = 5;

const PURPOSE_COPY: Record<OtpPurpose, { subject: string; lead: string }> = {
  LOGIN: { subject: 'Your Pangat sign-in code', lead: 'Use this code to finish signing in to Pangat.' },
  SIGNUP: { subject: 'Verify your email for Pangat', lead: 'Use this code to verify your email and create your Pangat account.' },
};

/** HMAC (not a bare hash): a 6-digit code has only 1M values, so an unsalted hash in a leaked table would be trivially reversible. */
export function hashOtp(purpose: string, identifier: string, code: string): string {
  return crypto.createHmac('sha256', resolveSettingsKey()).update(`${purpose}:${identifier}:${code}`).digest('hex');
}

export function generateOtp(): string {
  return String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
}

const tooMany = (message: string) => new HttpException({ message, code: 'OTP_RATE_LIMITED' }, HttpStatus.TOO_MANY_REQUESTS);

@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly email: EmailDeliveryService,
  ) {}

  /** True when a code can actually be delivered. Callers use this to decide whether OTP can be enforced. */
  canDeliver(): boolean {
    return isEmailConfigured();
  }

  /**
   * Create a fresh code and email it. Older unused codes for the same purpose + address are invalidated.
   * Throws 429 on resend-too-soon or too many codes in an hour; returns false if the provider refused the mail.
   */
  async issue(purpose: OtpPurpose, rawEmail: string, name?: string | null): Promise<boolean> {
    const identifier = rawEmail.trim().toLowerCase();
    const [recent] = await this.ds.query(
      `SELECT COUNT(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS per_hour,
              MAX(created_at) AS last_at
       FROM otp_codes WHERE purpose = $1 AND identifier = $2`,
      [purpose, identifier],
    );
    if (recent.last_at && Date.now() - new Date(recent.last_at).getTime() < OTP_RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((OTP_RESEND_COOLDOWN_MS - (Date.now() - new Date(recent.last_at).getTime())) / 1000);
      throw tooMany(`Please wait ${wait}s before requesting another code.`);
    }
    if (recent.per_hour >= OTP_MAX_PER_HOUR) throw tooMany('Too many codes requested. Try again in an hour.');

    const code = generateOtp();
    await this.ds.query(`UPDATE otp_codes SET consumed_at = now() WHERE purpose = $1 AND identifier = $2 AND consumed_at IS NULL`, [purpose, identifier]);
    await this.ds.query(`INSERT INTO otp_codes (purpose, identifier, code_hash, expires_at) VALUES ($1,$2,$3,$4)`, [
      purpose,
      identifier,
      hashOtp(purpose, identifier, code),
      new Date(Date.now() + OTP_TTL_MS),
    ]);

    const copy = PURPOSE_COPY[purpose];
    const mins = OTP_TTL_MS / 60_000;
    const res = await this.email.sendTransactionalEmail({
      to: identifier,
      subject: copy.subject,
      htmlContent: `<div style="font-family:system-ui,sans-serif;padding:20px;color:#1e293b">
        <h2>Namaskar${name ? ` ${escapeHtml(name)}` : ''},</h2>
        <p>${copy.lead}</p>
        <p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">${code}</p>
        <p style="font-size:12px;color:#64748b">This code expires in ${mins} minutes. If you did not ask for it, you can ignore this email; nobody can use it without your password.</p>
      </div>`,
      textContent: `${copy.lead}\n\nCode: ${code}\n\nExpires in ${mins} minutes. If you did not ask for it, ignore this email.`,
    });
    if (!res.delivered) this.logger.warn(`OTP email not delivered (${res.provider})`);
    return res.delivered;
  }

  /** Check a submitted code. Each wrong guess is counted; after OTP_MAX_ATTEMPTS the code is dead. A correct code is single-use. */
  async verify(purpose: OtpPurpose, rawEmail: string, code: string): Promise<boolean> {
    const identifier = rawEmail.trim().toLowerCase();
    const clean = String(code || '').replace(/\s+/g, '');
    if (!new RegExp(`^\\d{${OTP_LENGTH}}$`).test(clean)) return false;

    const [row] = await this.ds.query(
      `SELECT id, code_hash, attempts FROM otp_codes
       WHERE purpose = $1 AND identifier = $2 AND consumed_at IS NULL AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [purpose, identifier],
    );
    if (!row || row.attempts >= OTP_MAX_ATTEMPTS) return false;

    const given = Buffer.from(hashOtp(purpose, identifier, clean));
    const stored = Buffer.from(row.code_hash);
    const ok = given.length === stored.length && crypto.timingSafeEqual(given, stored);
    if (!ok) {
      await this.ds.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);
      return false;
    }
    // Atomic single use: a concurrent second submission of the same code loses this race
    const done = await this.ds.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id', [row.id]);
    return (Array.isArray(done?.[0]) ? done[0] : done).length > 0;
  }
}
