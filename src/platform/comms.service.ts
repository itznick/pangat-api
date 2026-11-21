import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EmailDeliveryService, isEmailConfigured } from '../common/services/email-delivery.service.js';
import { renderEmail } from '../common/services/email-template.js';
import { AuditActor, PlatformAuditService } from './audit.service.js';
import { escapeHtml } from './events.service.js';

/** TypeORM returns [rows, count] for UPDATE ... RETURNING on Postgres; INSERT returns rows directly. */
const firstRow = (r: any) => (Array.isArray(r?.[0]) ? r[0][0] : r?.[0]);

export const TEMPLATE_VARIABLES = ['ownerName', 'restaurantName', 'loginUrl', 'planName', 'endDate', 'daysLeft', 'subject', 'message'];

export function renderTemplate(text: string, vars: Record<string, string | number | null | undefined>, html = false): string {
  return String(text || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
    const v = vars[k];
    const s = v === undefined || v === null ? '' : String(v);
    return html ? escapeHtml(s) : s;
  });
}

export interface SendDto {
  subject: string;
  body: string;
  channels: ('IN_APP' | 'EMAIL')[];
  audience: 'ALL_OWNERS' | 'ORGANIZATIONS' | 'USERS';
  targetIds?: string[];
  templateKey?: string | null;
}

@Injectable()
export class CommsService {
  private readonly logger = new Logger(CommsService.name);
  constructor(
    private readonly ds: DataSource,
    private readonly email: EmailDeliveryService,
    private readonly audit: PlatformAuditService,
  ) {}

  emailConfigured(): boolean {
    return isEmailConfigured();
  }

  private loginUrl(): string {
    const base = (process.env.FRONTEND_URL || '').split(',')[0].trim().replace(/\/+$/, '');
    return base ? `${base}/login` : '/login';
  }

  private async recipients(audience: SendDto['audience'], ids: string[]) {
    if (audience === 'USERS') {
      if (!ids.length) throw new BadRequestException('Choose at least one user');
      return this.ds.query(
        `SELECT st.id, st.name, st.email, COALESCE(st.organization_id, r.organization_id) AS organization_id, o.name AS restaurant_name
         FROM staff st LEFT JOIN restaurants r ON r.id = st.restaurant_id LEFT JOIN organizations o ON o.id = COALESCE(st.organization_id, r.organization_id)
         WHERE st.id = ANY($1::uuid[]) AND st.is_active = true AND st.is_platform_admin = false LIMIT 2000`,
        [ids],
      );
    }
    if (audience === 'ORGANIZATIONS') {
      if (!ids.length) throw new BadRequestException('Choose at least one restaurant');
      return this.ds.query(
        `SELECT st.id, st.name, st.email, o.id AS organization_id, o.name AS restaurant_name FROM staff st
         JOIN organizations o ON o.id = COALESCE(st.organization_id, (SELECT organization_id FROM restaurants WHERE id = st.restaurant_id))
         WHERE o.id = ANY($1::uuid[]) AND st.is_active = true AND st.role IN ('SUPER_OWNER','STORE_MANAGER') AND st.is_platform_admin = false
           AND st.email NOT LIKE 'kitchen.%@stations.pangat.app' LIMIT 2000`,
        [ids],
      );
    }
    return this.ds.query(
      `SELECT st.id, st.name, st.email, o.id AS organization_id, o.name AS restaurant_name FROM staff st JOIN organizations o ON o.id = st.organization_id
       WHERE st.role = 'SUPER_OWNER' AND st.is_active = true AND o.status = 'ACTIVE' LIMIT 2000`,
    );
  }

  /** Create the message, fan it out per recipient and channel, record the outcome of each delivery. */
  async send(dto: SendDto, actor: AuditActor | null) {
    if (!dto.channels?.length) throw new BadRequestException('Choose at least one channel');
    const to = await this.recipients(dto.audience, dto.targetIds || []);
    if (!to.length) throw new BadRequestException('No active recipients match this audience');
    const emailOk = this.emailConfigured();
    const [n] = await this.ds.query(
      `INSERT INTO platform_notifications (subject, body, channels, audience, target_ids, template_key, status, total, created_by, created_by_name)
       VALUES ($1,$2,$3,$4,$5::uuid[],$6,'SENDING',$7,$8,$9) RETURNING id`,
      [dto.subject, dto.body, dto.channels, dto.audience, dto.targetIds || [], dto.templateKey ?? null, to.length * dto.channels.length, actor?.id ?? null, actor?.name ?? 'System'],
    );
    let delivered = 0, failed = 0, skipped = 0;

    for (const r of to) {
      const vars = { ownerName: r.name, restaurantName: r.restaurant_name, loginUrl: this.loginUrl(), subject: dto.subject };
      for (const ch of dto.channels) {
        let status = 'DELIVERED';
        let error: string | null = null;
        let messageId: string | null = null;
        if (ch === 'EMAIL') {
          if (!emailOk) { status = 'SKIPPED'; error = 'Email provider is not configured'; }
          else {
            const mail = renderEmail({
              heading: renderTemplate(dto.subject, vars),
              name: r.name,
              paragraphs: renderTemplate(dto.body, vars).split(/\n{2,}/).map((x) => x.trim()).filter(Boolean),
              button: { label: 'Open Pangat', url: this.loginUrl() },
            });
            const res = await this.email.sendTransactionalEmail({
              to: r.email,
              subject: renderTemplate(dto.subject, vars),
              htmlContent: mail.html,
              textContent: mail.text,
            });
            if (res.delivered) messageId = res.messageId ?? null;
            else { status = 'FAILED'; error = (res.error || 'Provider rejected the message').slice(0, 300); }
          }
        }
        if (status === 'DELIVERED') delivered++; else if (status === 'FAILED') failed++; else skipped++;
        await this.ds.query(
          `INSERT INTO notification_deliveries (notification_id, channel, staff_id, organization_id, recipient_email, status, error, provider_message_id, rendered_subject, rendered_body)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [n.id, ch, r.id, r.organization_id, ch === 'EMAIL' ? r.email : null, status, error, messageId, renderTemplate(dto.subject, vars), renderTemplate(dto.body, vars)],
        );
      }
    }
    const final = failed === 0 && skipped === 0 ? 'COMPLETED' : delivered === 0 ? 'FAILED' : 'PARTIAL';
    await this.ds.query('UPDATE platform_notifications SET delivered=$2, failed=$3, skipped=$4, status=$5, completed_at=now() WHERE id=$1', [n.id, delivered, failed, skipped, final]);
    if (actor) {
      await this.audit.record(actor, {
        action: 'NOTIFICATION_SENT', category: 'COMMUNICATION', entityType: 'notification', entityId: n.id, entityLabel: dto.subject,
        summary: `Sent "${dto.subject}" to ${to.length} recipient(s) via ${dto.channels.join(' + ')} (${delivered} delivered, ${failed} failed, ${skipped} skipped)`,
      });
    }
    return { id: n.id, recipients: to.length, delivered, failed, skipped, status: final };
  }

  /** Used by background jobs: render a stored template and send it to a restaurant's owner. */
  async sendTemplateToOrganization(orgId: string, templateKey: string, vars: Record<string, string | number>, channels: ('IN_APP' | 'EMAIL')[] = ['IN_APP', 'EMAIL']) {
    const tpl = (await this.ds.query('SELECT * FROM notification_templates WHERE key = $1 AND is_active = true', [templateKey]))[0];
    if (!tpl) return null;
    const owner = (await this.ds.query(`SELECT id, name FROM staff WHERE organization_id = $1 AND role = 'SUPER_OWNER' AND is_active = true ORDER BY created_at LIMIT 1`, [orgId]))[0];
    if (!owner) return null;
    const org = (await this.ds.query('SELECT name FROM organizations WHERE id = $1', [orgId]))[0];
    const merged = { ...vars, ownerName: owner.name, restaurantName: org?.name ?? '', loginUrl: this.loginUrl() };
    return this.send(
      { subject: renderTemplate(tpl.subject, merged), body: renderTemplate(tpl.body, merged), channels, audience: 'USERS', targetIds: [owner.id], templateKey },
      null,
    );
  }

  // ── history ──────────────────────────────────────────────────────────────
  async history(q: { page?: number; limit?: number }) {
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const page = Math.max(1, Number(q.page) || 1);
    const [items, total] = await Promise.all([
      this.ds.query(`SELECT * FROM platform_notifications ORDER BY created_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`),
      this.ds.query('SELECT COUNT(*)::int AS n FROM platform_notifications'),
    ]);
    return { items, total: total[0].n, page, limit, emailConfigured: this.emailConfigured() };
  }

  async deliveries(notificationId: string) {
    const n = (await this.ds.query('SELECT * FROM platform_notifications WHERE id = $1', [notificationId]))[0];
    if (!n) throw new NotFoundException('Notification not found');
    const rows = await this.ds.query(
      `SELECT d.id, d.channel, d.status, d.error, d.provider_message_id, d.recipient_email, d.created_at, d.read_at, st.name AS recipient_name, o.name AS organization_name
       FROM notification_deliveries d LEFT JOIN staff st ON st.id = d.staff_id LEFT JOIN organizations o ON o.id = d.organization_id WHERE d.notification_id = $1 ORDER BY d.created_at LIMIT 500`,
      [notificationId],
    );
    return { notification: n, deliveries: rows };
  }

  // ── templates ────────────────────────────────────────────────────────────
  templates() {
    return this.ds.query('SELECT * FROM notification_templates ORDER BY name');
  }

  async saveTemplate(id: string | null, dto: { key?: string; name: string; channel: string; subject: string; body: string; isActive?: boolean }, actor: AuditActor) {
    if (!['EMAIL', 'IN_APP'].includes(dto.channel)) throw new BadRequestException('Channel must be EMAIL or IN_APP');
    if (id) {
      const row = firstRow(await this.ds.query(
        `UPDATE notification_templates SET name=$2, channel=$3, subject=$4, body=$5, is_active=COALESCE($6,is_active), updated_by=$7, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, dto.name, dto.channel, dto.subject, dto.body, dto.isActive ?? null, actor.name ?? actor.email],
      ));
      if (!row) throw new NotFoundException('Template not found');
      await this.audit.record(actor, { action: 'TEMPLATE_UPDATED', category: 'COMMUNICATION', entityType: 'template', entityId: id, entityLabel: row.name, summary: `Updated notification template ${row.key}` });
      return row;
    }
    const key = String(dto.key || '').trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    if (!key) throw new BadRequestException('A template key is required');
    if ((await this.ds.query('SELECT 1 FROM notification_templates WHERE key = $1', [key]))[0]) throw new BadRequestException(`A template with key ${key} already exists`);
    const [row] = await this.ds.query(
      `INSERT INTO notification_templates (key, name, channel, subject, body, is_active, updated_by) VALUES ($1,$2,$3,$4,$5,COALESCE($6,true),$7) RETURNING *`,
      [key, dto.name, dto.channel, dto.subject, dto.body, dto.isActive ?? null, actor.name ?? actor.email],
    );
    await this.audit.record(actor, { action: 'TEMPLATE_CREATED', category: 'COMMUNICATION', entityType: 'template', entityId: row.id, entityLabel: row.name, summary: `Created notification template ${key}` });
    return row;
  }

  // ── announcements ────────────────────────────────────────────────────────
  announcements() {
    return this.ds.query(
      `SELECT a.*, (a.is_active AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())) AS is_live FROM announcements a ORDER BY a.created_at DESC LIMIT 200`,
    );
  }

  async saveAnnouncement(
    id: string | null,
    dto: { title: string; body: string; kind: string; severity: string; audience: string; organizationIds?: string[]; startsAt?: string; endsAt?: string | null; isActive?: boolean; dismissible?: boolean },
    actor: AuditActor,
  ) {
    if (dto.endsAt && dto.startsAt && new Date(dto.endsAt) <= new Date(dto.startsAt)) throw new BadRequestException('End time must be after the start time');
    if (dto.audience === 'ORGANIZATIONS' && !(dto.organizationIds || []).length) throw new BadRequestException('Choose at least one restaurant');
    const args = [dto.title, dto.body, dto.kind, dto.severity, dto.audience, dto.audience === 'ORGANIZATIONS' ? dto.organizationIds : [], dto.startsAt || null, dto.endsAt || null, dto.isActive ?? true, actor.name ?? actor.email, dto.dismissible ?? true];
    let row;
    if (id) {
      row = firstRow(await this.ds.query(
        `UPDATE announcements SET title=$2, body=$3, kind=$4, severity=$5, audience=$6, organization_ids=$7::uuid[], starts_at=COALESCE($8::timestamptz, starts_at), ends_at=$9, is_active=$10, dismissible=$11, updated_at=now() WHERE id=$1 RETURNING *`,
        [id, ...args.slice(0, 7), args[7], args[8], args[10]],
      ));
      if (!row) throw new NotFoundException('Announcement not found');
    } else {
      [row] = await this.ds.query(
        `INSERT INTO announcements (title, body, kind, severity, audience, organization_ids, starts_at, ends_at, is_active, created_by, dismissible) VALUES ($1,$2,$3,$4,$5,$6::uuid[],COALESCE($7::timestamptz, now()),$8,$9,$10,$11) RETURNING *`,
        args,
      );
    }
    await this.audit.record(actor, { action: id ? 'ANNOUNCEMENT_UPDATED' : 'ANNOUNCEMENT_CREATED', category: 'COMMUNICATION', entityType: 'announcement', entityId: row.id, entityLabel: row.title, summary: `${id ? 'Updated' : 'Published'} ${String(row.kind).toLowerCase()} "${row.title}"` });
    return row;
  }

  /** Banners a restaurant user should see right now. */
  activeFor(orgId: string | null) {
    return this.ds.query(
      `SELECT id, title, body, kind, severity, starts_at, ends_at, dismissible FROM announcements
       WHERE is_active = true AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now()) AND (audience = 'ALL' OR ($1::uuid IS NOT NULL AND $1::uuid = ANY(organization_ids)))
       ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END, starts_at DESC LIMIT 5`,
      [orgId],
    );
  }

  // ── in-app inbox for restaurant users ────────────────────────────────────
  async inbox(staffId: string, limit = 30) {
    const [items, unread] = await Promise.all([
      this.ds.query(
        `SELECT d.id, COALESCE(d.rendered_subject, n.subject) AS subject, COALESCE(d.rendered_body, n.body) AS body, d.created_at, d.read_at FROM notification_deliveries d JOIN platform_notifications n ON n.id = d.notification_id
         WHERE d.staff_id = $1 AND d.channel = 'IN_APP' AND d.status = 'DELIVERED' ORDER BY d.created_at DESC LIMIT $2`,
        [staffId, Math.min(100, limit)],
      ),
      this.ds.query(`SELECT COUNT(*)::int AS n FROM notification_deliveries WHERE staff_id = $1 AND channel = 'IN_APP' AND status = 'DELIVERED' AND read_at IS NULL`, [staffId]),
    ]);
    return { items, unread: unread[0].n };
  }

  async markRead(staffId: string, id: string | null) {
    await this.ds.query(
      `UPDATE notification_deliveries SET read_at = now() WHERE staff_id = $1 AND channel = 'IN_APP' AND read_at IS NULL ${id ? 'AND id = $2' : ''}`,
      id ? [staffId, id] : [staffId],
    );
  }
}
