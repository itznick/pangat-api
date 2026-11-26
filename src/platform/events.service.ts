import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EmailDeliveryService, isEmailConfigured } from '../common/services/email-delivery.service.js';
import { getSetting } from './settings.service.js';
import { renderEmail } from '../common/services/email-template.js';

/** TypeORM returns [rows, count] for UPDATE ... RETURNING on Postgres; INSERT/SELECT return rows directly. */
const firstRow = (r: any) => (Array.isArray(r?.[0]) ? r[0][0] : r?.[0]);

export type EventSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Platform event feed: what operators should know about. Drives the Super Admin bell and optional email alerts. */
@Injectable()
export class PlatformEventsService {
  private readonly logger = new Logger(PlatformEventsService.name);
  constructor(private readonly ds: DataSource, private readonly email: EmailDeliveryService) {}

  /**
   * Email policy. Every event is stored (the Super Admin bell) regardless. An EMAIL is queued only for what an operator must act on:
   * critical events, new demo/lead requests, plan-change requests and important (high/urgent) support tickets. Emails are only sent when
   * the operator has switched email alerts on; if they are on but cannot be delivered (no recipients, no provider, provider error) that
   * is recorded and shown, never swallowed.
   */
  static wantsEmail(type: string, severity: EventSeverity): boolean {
    return severity === 'CRITICAL' || type === 'NEW_LEAD' || type === 'PLAN_CHANGE_REQUESTED' || (type === 'SUPPORT_TICKET' && severity === 'WARNING');
  }

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
      const rows = await this.ds.query(
        `INSERT INTO platform_events (type, severity, title, detail, organization_id, entity_type, entity_id, actor_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [type, severity, title.slice(0, 200), detail ?? null, ctx.organizationId ?? null, ctx.entityType ?? null, ctx.entityId ?? null, ctx.actorName ?? null],
      );
      const eventId: string | undefined = rows?.[0]?.id;
      if (eventId && PlatformEventsService.wantsEmail(type, severity) && getSetting<boolean>('notifications.emailAlerts') === true) {
        await this.queueEmails(eventId);
        void this.deliverEvent(eventId).catch((e) => this.logger.warn(`Alert delivery crashed: ${(e as Error).message}`)); // never delay the request that raised it
      }
    } catch (e) {
      this.logger.warn(`Could not record platform event ${type}: ${(e as Error).message}`);
    }
  }

  private recipients(): string[] {
    return [...new Set(String(getSetting<string>('notifications.alertEmails') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  }

  /** One delivery row per recipient (unique per event, so a repeat can never double-send). No recipients is itself a recorded failure. */
  private async queueEmails(eventId: string) {
    const to = this.recipients();
    if (!to.length) {
      await this.ds.query(
        `INSERT INTO platform_event_deliveries (event_id, recipient, status, attempts, last_error, last_attempt_at)
         VALUES ($1,'','FAILED',0,$2,now()) ON CONFLICT DO NOTHING`,
        [eventId, 'Email alerts are on but no alert recipients are set. Add them under Settings > Notifications.'],
      );
      return;
    }
    for (const addr of to) {
      await this.ds.query(`INSERT INTO platform_event_deliveries (event_id, recipient) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [eventId, addr]);
    }
  }

  /** Back-off between automatic attempts; after the last one the delivery stays FAILED until someone presses Retry. */
  static readonly BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000];
  static readonly MAX_ATTEMPTS = 5;

  private async deliverEvent(eventId: string) {
    const ids = await this.ds.query(`SELECT id FROM platform_event_deliveries WHERE event_id = $1 AND status = 'PENDING' AND recipient <> ''`, [eventId]);
    for (const r of ids) await this.deliverOne(r.id);
  }

  /** Claim-then-send: only the claimer sends, so two workers (or a retry racing the first attempt) cannot email twice. */
  async deliverOne(deliveryId: string): Promise<'SENT' | 'FAILED' | 'PENDING' | 'SKIPPED'> {
    const claimed = firstRow(
      await this.ds.query(
        `UPDATE platform_event_deliveries SET status = 'SENDING', attempts = attempts + 1, last_attempt_at = now()
         WHERE id = $1 AND status = 'PENDING' RETURNING id, event_id, recipient, attempts`,
        [deliveryId],
      ),
    );
    if (!claimed) return 'SKIPPED';
    const ev = firstRow(await this.ds.query('SELECT title, detail, type, severity FROM platform_events WHERE id = $1', [claimed.event_id]));
    let ok = false;
    let error: string | null = null;
    let provider: string | null = null;
    let messageId: string | null = null;
    try {
      const mail = renderEmail({ heading: ev.title, paragraphs: [ev.detail || 'No further detail was recorded.'], note: 'Platform alert from Pangat. Open Super Admin for the full picture.' });
      const res = await this.email.sendTransactionalEmail({ to: claimed.recipient, subject: `[Pangat alert] ${ev.title}`, htmlContent: mail.html, textContent: mail.text });
      ok = res.delivered === true;
      provider = res.provider ?? null;
      messageId = res.messageId ?? null;
      if (!ok) error = (res.error || 'The email provider did not accept the message').slice(0, 500);
    } catch (e) {
      error = ((e as Error).message || 'Email send crashed').slice(0, 500);
    }
    if (ok) {
      await this.ds.query(`UPDATE platform_event_deliveries SET status='SENT', sent_at=now(), last_error=NULL, provider=$2, message_id=$3 WHERE id=$1`, [claimed.id, provider, messageId]);
      return 'SENT';
    }
    const exhausted = claimed.attempts >= PlatformEventsService.MAX_ATTEMPTS;
    const wait = PlatformEventsService.BACKOFF_MS[Math.min(claimed.attempts - 1, PlatformEventsService.BACKOFF_MS.length - 1)];
    await this.ds.query(
      `UPDATE platform_event_deliveries SET status = $2, last_error = $3, provider = $4, next_attempt_at = now() + ($5 || ' milliseconds')::interval WHERE id = $1`,
      [claimed.id, exhausted ? 'FAILED' : 'PENDING', error, provider, String(wait)],
    );
    return exhausted ? 'FAILED' : 'PENDING';
  }

  /** Background job: retry what is due, and free anything a crashed process left half-sent. */
  async retryDue(): Promise<{ retried: number; sent: number }> {
    await this.ds.query(`UPDATE platform_event_deliveries SET status = 'PENDING' WHERE status = 'SENDING' AND last_attempt_at < now() - interval '5 minutes'`);
    const due = await this.ds.query(`SELECT id FROM platform_event_deliveries WHERE status = 'PENDING' AND recipient <> '' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT 25`);
    let sent = 0;
    for (const d of due) if ((await this.deliverOne(d.id)) === 'SENT') sent++;
    return { retried: due.length, sent };
  }

  /** Manual retry from Super Admin: resets the attempt budget and sends now. */
  async retryDelivery(id: string): Promise<{ status: string } | null> {
    const row = firstRow(
      await this.ds.query(
        `UPDATE platform_event_deliveries SET status = 'PENDING', attempts = 0, next_attempt_at = now()
         WHERE id = $1 AND status IN ('FAILED','PENDING') RETURNING id, recipient`,
        [id],
      ),
    );
    if (!row) return null;
    if (!row.recipient) {
      // a "no recipients" failure: re-evaluate the current settings; if recipients exist now, queue them for this event
      const ev = firstRow(await this.ds.query('SELECT event_id FROM platform_event_deliveries WHERE id = $1', [id]));
      await this.ds.query('DELETE FROM platform_event_deliveries WHERE id = $1', [id]);
      if (this.recipients().length) {
        await this.queueEmails(ev.event_id);
        await this.deliverEvent(ev.event_id);
        return { status: 'RETRIED' };
      }
      await this.queueEmails(ev.event_id);
      return { status: 'FAILED' };
    }
    return { status: await this.deliverOne(row.id) };
  }

  deliveries(status?: string, limit = 50) {
    return this.ds.query(
      `SELECT d.id, d.status, d.attempts, d.recipient, d.last_error, d.provider, d.sent_at, d.next_attempt_at, d.last_attempt_at, d.created_at,
              e.id AS event_id, e.type, e.severity, e.title
       FROM platform_event_deliveries d JOIN platform_events e ON e.id = d.event_id
       ${status ? 'WHERE d.status = $2' : ''} ORDER BY d.created_at DESC LIMIT $1`,
      status ? [Math.min(200, limit), status] : [Math.min(200, limit)],
    );
  }

  /** What Super Admin needs to trust (or distrust) the alert channel right now. */
  async health() {
    const [c] = await this.ds.query(
      `SELECT count(*) FILTER (WHERE status = 'FAILED')::int AS failed, count(*) FILTER (WHERE status IN ('PENDING','SENDING'))::int AS pending,
              count(*) FILTER (WHERE status = 'SENT' AND sent_at > now() - interval '7 days')::int AS sent_7d FROM platform_event_deliveries`,
    );
    const emailConfigured = isEmailConfigured();
    const alertsOn = getSetting<boolean>('notifications.emailAlerts') === true;
    const recipients = this.recipients().length;
    const problems: string[] = [];
    if (!alertsOn) problems.push('Email alerts are switched off: new leads, plan-change requests and critical events appear only in the Super Admin bell.');
    if (alertsOn && !recipients) problems.push('Email alerts are on but no recipients are set.');
    if (alertsOn && !emailConfigured) problems.push('Email alerts are on but no email provider is configured, so nothing can be sent.');
    if (c.failed) problems.push(`${c.failed} alert email${c.failed === 1 ? '' : 's'} could not be delivered.`);
    return { emailConfigured, emailAlertsEnabled: alertsOn, recipients, failed: c.failed, pending: c.pending, sentLast7Days: c.sent_7d, ok: problems.length === 0, problems };
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
