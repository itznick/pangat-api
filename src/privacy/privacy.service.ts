import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { randomBytes } from 'crypto';
import { EmailDeliveryService, isEmailConfigured } from '../common/services/email-delivery.service.js';
import { renderEmail } from '../common/services/email-template.js';
import { AuditActor, PlatformAuditService } from '../platform/audit.service.js';
import { getSetting } from '../platform/settings.service.js';
import { PRIVACY_POLICY_VERSION, maskPhone, phoneKey } from '../platform/compliance.js';
import { runPrivacyRetention } from './retention.js';
import { CreatePrivacyRequestDto, UpdatePrivacyRequestDto } from './privacy.dto.js';

const KIND_LABEL: Record<string, string> = {
  ACCESS: 'Access to my data', CORRECTION: 'Correct my data', ERASURE: 'Erase my data', WITHDRAW_CONSENT: 'Withdraw my consent',
  GRIEVANCE: 'Complaint', NOMINATE: 'Nominate someone to act for me',
};

/** Reference people can quote: unambiguous characters only (no 0/O, 1/I). */
function newReference(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return 'PR-' + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

@Injectable()
export class PrivacyService {
  private readonly logger = new Logger(PrivacyService.name);
  constructor(
    private readonly ds: DataSource,
    private readonly audit: PlatformAuditService,
    private readonly email: EmailDeliveryService,
  ) {}

  private responseDays() {
    return Number(getSetting<number>('compliance.responseDays')) || 30;
  }

  // ── public intake ────────────────────────────────────────────────────────
  async create(dto: CreatePrivacyRequestDto, meta: { ip?: string | null; userAgent?: string | null }) {
    // Honeypot: pretend success so bots learn nothing, store nothing
    if (dto.website && dto.website.trim()) return { reference: newReference(), dueDays: this.responseDays() };

    const contact = dto.contact.trim();
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact);
    const isPhone = phoneKey(contact).length >= 10;
    if (!isEmail && !isPhone) throw new BadRequestException('Give an email address or a 10-digit phone number we can reach you on');

    const reference = newReference();
    const days = this.responseDays();
    await this.ds.query(
      `INSERT INTO privacy_requests (reference, kind, name, contact, restaurant_ref, message, due_at, consent_version)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' days')::interval, $8)`,
      [reference, dto.kind, dto.name.trim(), contact, dto.restaurantRef?.trim() || null, dto.message?.trim() || null, String(days), PRIVACY_POLICY_VERSION],
    );
    await this.audit.record({ name: 'Public privacy form', ip: meta.ip ?? null, userAgent: meta.userAgent ?? null }, {
      action: 'PRIVACY_REQUEST_RECEIVED', category: 'PRIVACY', entityType: 'privacy_request', entityId: reference, entityLabel: KIND_LABEL[dto.kind],
      summary: `${KIND_LABEL[dto.kind]} request ${reference} received`,
    });
    void this.notify(reference, dto, contact, isEmail, days);
    return { reference, dueDays: days };
  }

  /** Courtesy emails. A failure here never blocks the request: it is already stored and will show on the officer's dashboard. */
  private async notify(reference: string, dto: CreatePrivacyRequestDto, contact: string, isEmail: boolean, days: number) {
    if (!isEmailConfigured()) return;
    try {
      const officerEmail = getSetting<string | null>('compliance.grievanceOfficerEmail');
      if (officerEmail) {
        const m = renderEmail({
          preheader: `${KIND_LABEL[dto.kind]} · ${reference}`,
          heading: 'New privacy request',
          paragraphs: [
            `${dto.name.trim()} sent a request: ${KIND_LABEL[dto.kind]}.`,
            `Reference: ${reference}\nRespond by: ${days} days from now${dto.restaurantRef ? `\nRestaurant: ${dto.restaurantRef}` : ''}`,
            'Open Super Admin → Privacy requests to review it and reply. The person\'s contact details are in the request.',
          ],
        });
        await this.email.sendTransactionalEmail({ to: officerEmail, subject: `Privacy request ${reference}`, htmlContent: m.html, textContent: m.text });
      }
      if (isEmail) {
        const m = renderEmail({
          preheader: `We received your request ${reference}`,
          heading: 'We received your request',
          name: dto.name.trim(),
          paragraphs: [`Thank you. We have your request (${KIND_LABEL[dto.kind]}).`, `Your reference is ${reference}. We will reply within ${days} days.`],
          note: 'If you did not make this request, you can ignore this email.',
        });
        await this.email.sendTransactionalEmail({ to: contact, subject: `Your privacy request ${reference}`, htmlContent: m.html, textContent: m.text });
      }
    } catch (e) {
      this.logger.warn(`Privacy request notification failed: ${(e as Error).message}`);
    }
  }

  // ── officer workflow ─────────────────────────────────────────────────────
  async list(q: { status?: string; kind?: string; page?: number; limit?: number }) {
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const page = Math.max(1, Number(q.page) || 1);
    const p: unknown[] = [];
    const c: string[] = [];
    if (q.status) { p.push(q.status); c.push(`status = $${p.length}`); }
    if (q.kind) { p.push(q.kind); c.push(`kind = $${p.length}`); }
    const where = c.length ? `WHERE ${c.join(' AND ')}` : '';
    const [items, total, overdue] = await Promise.all([
      this.ds.query(`SELECT *, (status IN ('OPEN','IN_PROGRESS') AND due_at < now()) AS overdue FROM privacy_requests ${where} ORDER BY (status IN ('OPEN','IN_PROGRESS')) DESC, due_at ASC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, p),
      this.ds.query(`SELECT COUNT(*)::int AS n FROM privacy_requests ${where}`, p),
      this.ds.query(`SELECT COUNT(*)::int AS n FROM privacy_requests WHERE status IN ('OPEN','IN_PROGRESS') AND due_at < now()`),
    ]);
    return { items, total: total[0].n, overdue: overdue[0].n, page, limit };
  }

  async get(id: string) {
    const r = (await this.ds.query('SELECT * FROM privacy_requests WHERE id = $1', [id]))[0];
    if (!r) throw new NotFoundException('Request not found');
    return r;
  }

  async update(id: string, dto: UpdatePrivacyRequestDto, actor: AuditActor) {
    const r = await this.get(id);
    const status = dto.status ?? r.status;
    const closing = status === 'RESOLVED' || status === 'REJECTED';
    if (closing && !(dto.resolutionNote ?? r.resolution_note)?.trim()) throw new BadRequestException('Write what was done (or why it was declined) before closing the request');
    await this.ds.query(
      `UPDATE privacy_requests SET status = $2, resolution_note = COALESCE($3, resolution_note), handled_by = $4, updated_at = now(),
         resolved_at = CASE WHEN $5 THEN COALESCE(resolved_at, now()) ELSE NULL END WHERE id = $1`,
      [id, status, dto.resolutionNote?.trim() || null, actor.name ?? actor.email ?? null, closing],
    );
    await this.audit.record(actor, {
      action: 'PRIVACY_REQUEST_UPDATED', category: 'PRIVACY', entityType: 'privacy_request', entityId: r.reference, entityLabel: KIND_LABEL[r.kind],
      summary: `Set privacy request ${r.reference} to ${status}`, changes: { status: { from: r.status, to: status } }, reason: dto.resolutionNote?.trim() || null,
    });
    if (closing && dto.notifyRequester && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.contact) && isEmailConfigured()) {
      const m = renderEmail({
        preheader: `Update on your request ${r.reference}`,
        heading: status === 'RESOLVED' ? 'Your request is complete' : 'Update on your request',
        name: r.name,
        paragraphs: [`Request ${r.reference} (${KIND_LABEL[r.kind]}).`, (dto.resolutionNote ?? r.resolution_note) as string],
        note: 'If you are not satisfied, you can reply to this email or contact our grievance officer.',
      });
      await this.email.sendTransactionalEmail({ to: r.contact, subject: `Update on your privacy request ${r.reference}`, htmlContent: m.html, textContent: m.text }).catch(() => undefined);
    }
    return this.get(id);
  }

  /** ACCESS: everything we hold about one phone number (orders). Opening this is itself recorded. */
  async lookup(phone: string, actor: AuditActor) {
    const key = phoneKey(phone);
    if (key.length < 10) throw new BadRequestException('Enter a full 10-digit phone number');
    const orders = await this.ds.query(
      `SELECT o.id, o.created_at AS "createdAt", r.name AS restaurant, o.order_type AS "orderType", o.order_status AS status, o.total_amount AS total,
              o.customer_name AS "customerName", o.delivery_address AS "deliveryAddress", o.consent_version AS "consentVersion", o.consent_at AS "consentAt"
       FROM orders o JOIN restaurants r ON r.id = o.restaurant_id
       WHERE right(regexp_replace(o.customer_phone, '\\D', '', 'g'), 10) = $1 ORDER BY o.created_at DESC LIMIT 500`,
      [key],
    );
    const leads = await this.ds.query(
      `SELECT id, name, restaurant_name AS "restaurantName", city, status, created_at AS "createdAt", consent_version AS "consentVersion"
       FROM leads WHERE right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1`,
      [key],
    );
    await this.audit.record(actor, { action: 'PRIVACY_LOOKUP', category: 'PRIVACY', entityType: 'person', entityId: maskPhone(phone), entityLabel: maskPhone(phone), summary: `Looked up personal data for ${maskPhone(phone)} (${orders.length} orders, ${leads.length} demo requests)` });
    return { phone: maskPhone(phone), orders, leads };
  }

  /** ERASURE: remove contact details from every order and delete demo requests for one phone number. Bills (amounts, items, tax) stay. */
  async anonymise(phone: string, actor: AuditActor, requestRef?: string) {
    const key = phoneKey(phone);
    if (key.length < 10) throw new BadRequestException('Enter a full 10-digit phone number');
    const orders = (await this.ds.query(
      `UPDATE orders SET customer_name = NULL, customer_phone = NULL, delivery_address = NULL, delivery_instructions = NULL,
         feedback = CASE WHEN feedback IS NULL THEN NULL ELSE feedback - 'comment' END
       WHERE right(regexp_replace(customer_phone, '\\D', '', 'g'), 10) = $1 RETURNING id`,
      [key],
    )) as unknown[];
    const ordersCount = Array.isArray(orders[0]) ? (orders[0] as unknown[]).length : orders.length;
    const leadsRes = (await this.ds.query(`DELETE FROM leads WHERE right(regexp_replace(phone, '\\D', '', 'g'), 10) = $1 RETURNING id`, [key])) as unknown[];
    const leadsCount = Array.isArray(leadsRes[0]) ? (leadsRes[0] as unknown[]).length : leadsRes.length;
    await this.audit.record(actor, {
      action: 'PRIVACY_ERASURE_EXECUTED', category: 'PRIVACY', entityType: 'person', entityId: maskPhone(phone), entityLabel: maskPhone(phone),
      summary: `Erased personal details for ${maskPhone(phone)}: ${ordersCount} orders anonymised, ${leadsCount} demo requests deleted`,
      changes: { orders: ordersCount, leads: leadsCount }, reason: requestRef ? `Privacy request ${requestRef}` : null,
    });
    return { ordersAnonymised: ordersCount, leadsDeleted: leadsCount };
  }

  /** Scheduled sweep (see retention.ts). Exposed here so an officer can also trigger it. */
  retentionSweep() {
    return runPrivacyRetention(this.ds);
  }
}
