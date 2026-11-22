import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { EmailDeliveryService, isEmailConfigured } from './email-delivery.service.js';
import { renderEmail } from './email-template.js';

export type PasswordLinkKind = 'RESET' | 'WELCOME';

/**
 * Sends a single-use "choose your password" link to the person's OWN email address.
 * Used by platform support and assisted onboarding so that no staff member ever sees, types or relays someone else's password,
 * and so a reset never locks the person out until they actually use the link.
 */
@Injectable()
export class PasswordLinkService {
  private readonly logger = new Logger(PasswordLinkService.name);

  constructor(
    private readonly ds: DataSource,
    private readonly email: EmailDeliveryService,
    private readonly config: ConfigService,
  ) {}

  canSend(): boolean {
    return isEmailConfigured();
  }

  private baseUrl(): string {
    const first = String(this.config.get<string>('FRONTEND_URL') || process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '');
    return first || '';
  }

  /** Throws 503 when mail cannot go out (the caller must not pretend a link was sent). Returns true when the provider accepted it. */
  async send(person: { id: string; name: string; email: string }, kind: PasswordLinkKind, ttlMinutes = kind === 'WELCOME' ? 72 * 60 : 60): Promise<void> {
    if (!this.canSend()) {
      throw new HttpException(
        'Email is not configured, so a reset link cannot be sent. Set up an email provider in Settings → Email first.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    await this.ds.query(`UPDATE staff SET reset_token_hash = $2, reset_token_expires_at = now() + ($3 || ' minutes')::interval WHERE id = $1`, [person.id, hash, String(ttlMinutes)]);

    const url = `${this.baseUrl() || 'https://layerform.in'}/login?resetToken=${raw}`;
    const hours = Math.round(ttlMinutes / 60);
    const mail =
      kind === 'WELCOME'
        ? renderEmail({
            preheader: 'Choose your password to open your Pangat account.',
            heading: 'Welcome to Pangat',
            name: person.name,
            paragraphs: ['Your Pangat account is ready. Choose a password to sign in for the first time.'],
            button: { label: 'Choose my password', url },
            note: `This link works once and expires in ${hours} hours. If you were not expecting this, ignore this email.`,
          })
        : renderEmail({
            preheader: 'Use this single-use link to choose a new password.',
            heading: 'Choose a new password',
            name: person.name,
            paragraphs: ['The Pangat team started a password reset for your account. Choose a new password with the button below. Your current password keeps working until you do.'],
            button: { label: 'Reset password', url },
            note: `This link works once and expires in ${ttlMinutes >= 120 ? `${hours} hours` : `${ttlMinutes} minutes`}. If you did not ask for this, tell your Pangat contact and ignore this email.`,
          });
    const res = await this.email.sendTransactionalEmail({
      to: person.email,
      subject: kind === 'WELCOME' ? 'Welcome to Pangat: choose your password' : 'Choose a new Pangat password',
      htmlContent: mail.html,
      textContent: mail.text,
    });
    if (!res.delivered) {
      // The link we just stored is useless without the mail: remove it instead of leaving a live token nobody has
      await this.ds.query('UPDATE staff SET reset_token_hash = NULL, reset_token_expires_at = NULL WHERE id = $1', [person.id]);
      this.logger.warn(`Password link email not delivered (${res.provider})`);
      throw new HttpException('We could not email the link. Check the email settings and try again.', HttpStatus.SERVICE_UNAVAILABLE);
    }
  }
}
