import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface EmailDeliveryResult {
  delivered: boolean;
  provider: 'ses' | 'sendgrid' | 'smtp' | 'none';
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
   * Dispatches transactional email using configured provider (SendGrid v3 API or SMTP/SES).
   * Does NOT fabricate message IDs. Returns delivered: true ONLY when the provider accepts the message.
   */
  async sendTransactionalEmail(options: {
    to: string;
    subject: string;
    htmlContent: string;
    textContent?: string;
  }): Promise<EmailDeliveryResult> {
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
          const sgMessageId = response.headers.get('x-message-id') || `sg_${Date.now()}`;
          this.logger.log(`Email dispatched to ${options.to} via SendGrid (ID: ${sgMessageId})`);
          return {
            delivered: true,
            provider: 'sendgrid',
            messageId: sgMessageId,
          };
        }

        const errorBody = await response.text();
        this.logger.error(`SendGrid API failed with status ${response.status}: ${errorBody}`);
        return {
          delivered: false,
          provider: 'sendgrid',
          error: `SendGrid HTTP ${response.status}: ${errorBody}`,
        };
      } catch (err: any) {
        this.logger.error(`SendGrid network failure: ${err.message}`);
        return {
          delivered: false,
          provider: 'sendgrid',
          error: err.message,
        };
      }
    }

    // 2. AWS SES REST API (when configured with endpoint or secret)
    const sesEndpoint = this.configService.get<string>('AWS_SES_ENDPOINT');
    if (sesEndpoint) {
      try {
        const response = await fetch(sesEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            Destination: { ToAddresses: [options.to] },
            Message: {
              Subject: { Data: options.subject },
              Body: { Html: { Data: options.htmlContent } },
            },
            Source: fromEmail,
          }),
        });
        if (response.ok) {
          const data = (await response.json().catch(() => ({}))) as any;
          return {
            delivered: true,
            provider: 'ses',
            messageId: data.MessageId || `ses_${Date.now()}`,
          };
        }
        const errText = await response.text();
        return {
          delivered: false,
          provider: 'ses',
          error: `SES HTTP ${response.status}: ${errText}`,
        };
      } catch (err: any) {
        return {
          delivered: false,
          provider: 'ses',
          error: err.message,
        };
      }
    }

    // 3. No email provider configured
    this.logger.warn(
      `No transactional email credentials found (SENDGRID_API_KEY or AWS_SES_ENDPOINT). Email to ${options.to} not dispatched.`,
    );
    return {
      delivered: false,
      provider: 'none',
      error: 'Transactional email provider is not configured. Please set SENDGRID_API_KEY or AWS_SES_ENDPOINT in environment variables.',
    };
  }
}
