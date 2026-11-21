import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EmailDeliveryService } from '../common/services/email-delivery.service.js';
import { getSetting } from './settings.service.js';
import { renderEmail } from '../common/services/email-template.js';

export type EventSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Platform event feed: what operators should know about. Drives the Super Admin bell and optional email alerts. */
@Injectable()
export class PlatformEventsService {
  private readonly logger = new Logger(PlatformEventsService.name);
  constructor(private readonly ds: DataSource, private readonly email: EmailDeliveryService) {}

  async emit(
    type: string,
    severity: EventSeverity,
    title: string,
    detail?: string | null,
    ctx: { organizationId?: string | null; entityType?: string; entityId?: string; actorName?: string } = {},
  ) {
    try {
      const flag = getSetting<boolean | null>(`notifications.event.${type}`);
      if (flag === false) return; // operator turned this event type off
      await this.ds.query(
        `INSERT INTO platform_events (type, severity, title, detail, organization_id, entity_type, entity_id, actor_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [type, severity, title.slice(0, 200), detail ?? null, ctx.organizationId ?? null, ctx.entityType ?? null, ctx.entityId ?? null, ctx.actorName ?? null],
      );
      if (severity === 'CRITICAL' && getSetting<boolean>('notifications.emailAlerts') === true) {
        const to = String(getSetting<string>('notifications.alertEmails') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const alertMail = renderEmail({ heading: title, paragraphs: [detail || 'No further detail was recorded.'], note: 'Critical platform alert. Open Super Admin → Monitoring for the full picture.' });
        for (const addr of to) {
          await this.email.sendTransactionalEmail({
            to: addr,
            subject: `[Pangat alert] ${title}`,
            htmlContent: alertMail.html,
            textContent: alertMail.text,
          });
        }
      }
    } catch (e) {
      this.logger.warn(`Could not record platform event ${type}: ${(e as Error).message}`);
    }
  }

  list(limit = 30, onlyUnacknowledged = false) {
    return this.ds.query(
      `SELECT e.*, o.name AS organization_name FROM platform_events e LEFT JOIN organizations o ON o.id = e.organization_id
       ${onlyUnacknowledged ? 'WHERE e.acknowledged_at IS NULL' : ''} ORDER BY e.created_at DESC LIMIT $1`,
      [Math.min(100, limit)],
    );
  }

  async acknowledge(id: string | null, by: string) {
    if (id) await this.ds.query('UPDATE platform_events SET acknowledged_at = now(), acknowledged_by = $2 WHERE id = $1 AND acknowledged_at IS NULL', [id, by]);
    else await this.ds.query('UPDATE platform_events SET acknowledged_at = now(), acknowledged_by = $1 WHERE acknowledged_at IS NULL', [by]);
  }
}
