import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface EmailDeliveryResult {
  delivered: boolean;
  provider: 'sendgrid' | 'none';
  messageId?: string;
  error?: string;
}

export interface EmailOptions {
  to: string;
  subject: string;
  htmlContent: string;
  textContent?: string;
}

@Injectable()
export class EmailDeliveryService {
  private readonly logger = new Logger(EmailDeliveryService.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Dispatches transactional email using SendGrid v3 API.
   *
   * Note on AWS SES: Raw HTTP calls to unauthenticated endpoints have been removed.
   * SES integration will be implemented via @aws-sdk/client-ses once AWS credentials
   * and region are provisioned in the deployment environment.
   *
   * Returns delivered: true ONLY when the provider genuinely accepts the message.
   * Never fabricates synthetic message IDs.
   * Never logs recipient email addresses, tokens, or provider secrets.
   */
  async sendTransactionalEmail(options: EmailOptions): Promise<EmailDeliveryResult> {
    const sendgridApiKey = this.configService.get<string>('SENDGRID_API_KEY');
    const fromEmail = this.configService.get<string>('EMAIL_FROM') || 'no-reply@pangat.in';

    // 1. SendGrid Real HTTP Transport via native fetch
    if (sendgridApiKey) {
      try {
        const payload = {
          personalizations: [
            {
              to: [{ email: options.to }],
              subject: options.subject,
            },
          ],
          from: { email: fromEmail, name: 'Pangat Hospitality' },
          content: [
            {
              type: 'text/html',
              value: options.htmlContent,
            },
            ...(options.textContent
              ? [{ type: 'text/plain', value: options.textContent }]
              : []),
          ],
        };

        const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${sendgridApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        });

        if (response.status === 200 || response.status === 202) {
          const rawMessageId = response.headers.get('x-message-id');
          const messageId = rawMessageId && rawMessageId.trim().length > 0 ? rawMessageId.trim() : undefined;

          // Never log recipient email or tokens
          this.logger.log(`Email dispatched successfully via SendGrid (Provider ID: ${messageId || 'none'})`);

          return {
            delivered: true,
            provider: 'sendgrid',
            ...(messageId ? { messageId } : {}),
          };
        }

        // Handle rejected request safely without logging payload, tokens, or recipient info
        this.logger.error(`SendGrid API request rejected with HTTP ${response.status}`);
        return {
          delivered: false,
          provider: 'sendgrid',
          error: `SendGrid HTTP ${response.status}: Request rejected by provider`,
        };
      } catch (err: any) {
        // Safe logging without leaking sensitive values
        this.logger.error(`SendGrid transport failure: ${err?.message || 'Unknown network error'}`);
        return {
          delivered: false,
          provider: 'sendgrid',
          error: err?.message || 'Network error during email dispatch',
        };
      }
    }

    // 2. No email provider configured
    this.logger.warn(
      'No transactional email credentials found (SENDGRID_API_KEY is unset). Email dispatch skipped.',
    );
    return {
      delivered: false,
      provider: 'none',
      error: 'Transactional email provider is not configured. Please set SENDGRID_API_KEY in environment variables.',
    };
  }
}
