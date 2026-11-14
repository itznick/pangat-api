import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AuditActor, PlatformAuditService } from './audit.service.js';
import { PlatformEventsService } from './events.service.js';

export const TICKET_CATEGORIES = ['SUPPORT', 'BUG', 'COMPLAINT', 'BILLING', 'FEATURE_REQUEST'];
export const TICKET_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];
export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING', 'RESOLVED', 'CLOSED'];

@Injectable()
export class SupportService {
  constructor(private readonly ds: DataSource, private readonly audit: PlatformAuditService, private readonly events: PlatformEventsService) {}

  // ── restaurant side ──────────────────────────────────────────────────────
  async createFromMerchant(user: { id: string; name: string; email: string; organizationId?: string | null; restaurantId?: string | null }, dto: { category: string; subject: string; description: string; priority?: string }) {
    if (!TICKET_CATEGORIES.includes(dto.category)) throw new BadRequestException('Unknown category');
    const priority = TICKET_PRIORITIES.includes(dto.priority || '') ? dto.priority : 'MEDIUM';
    let orgId = user.organizationId ?? null;
    if (!orgId && user.restaurantId) orgId = (await this.ds.query('SELECT organization_id FROM restaurants WHERE id = $1', [user.restaurantId]))[0]?.organization_id ?? null;
    const [t] = await this.ds.query(
      `INSERT INTO support_tickets (organization_id, restaurant_id, reporter_staff_id, reporter_name, reporter_email, category, subject, description, priority, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'RESTAURANT') RETURNING id, number`,
      [orgId, user.restaurantId ?? null, user.id, user.name, user.email, dto.category, dto.subject.trim(), dto.description.trim(), priority],
    );
    await this.ds.query(`INSERT INTO support_ticket_events (ticket_id, type, author_id, author_name, author_kind, body) VALUES ($1,'CREATED',$2,$3,'MERCHANT',$4)`, [t.id, user.id, user.name, dto.description.trim()]);
    await this.events.emit('SUPPORT_TICKET', priority === 'URGENT' ? 'CRITICAL' : 'INFO', `New ${dto.category.toLowerCase().replace('_', ' ')}: ${dto.subject.slice(0, 80)}`, `SUP-${t.number} from ${user.name}`, { organizationId: orgId, entityType: 'ticket', entityId: t.id });
    return { id: t.id, number: t.number };
  }

  mine(user: { id: string; organizationId?: string | null }) {
    return this.ds.query(
      `SELECT id, number, category, subject, priority, status, resolution, created_at, updated_at, resolved_at FROM support_tickets
       WHERE reporter_staff_id = $1 ${user.organizationId ? 'OR organization_id = $2' : ''} ORDER BY created_at DESC LIMIT 100`,
      user.organizationId ? [user.id, user.organizationId] : [user.id],
    );
  }

  /** The restaurant sees its own ticket thread, never internal notes. */
  async mineDetail(user: { id: string; organizationId?: string | null }, id: string) {
    const t = (await this.ds.query('SELECT * FROM support_tickets WHERE id = $1', [id]))[0];
    if (!t || !(t.reporter_staff_id === user.id || (user.organizationId && t.organization_id === user.organizationId))) throw new NotFoundException('Ticket not found');
    const events = await this.ds.query(`SELECT type, author_name, author_kind, body, created_at FROM support_ticket_events WHERE ticket_id = $1 AND internal = false AND type IN ('CREATED','REPLY','STATUS','RESOLVED') ORDER BY created_at`, [id]);
    return { ticket: { id: t.id, number: t.number, category: t.category, subject: t.subject, description: t.description, priority: t.priority, status: t.status, resolution: t.resolution, created_at: t.created_at }, events };
  }

  async replyFromMerchant(user: { id: string; name: string; organizationId?: string | null }, id: string, body: string) {
    const t = (await this.ds.query('SELECT * FROM support_tickets WHERE id = $1', [id]))[0];
    if (!t || !(t.reporter_staff_id === user.id || (user.organizationId && t.organization_id === user.organizationId))) throw new NotFoundException('Ticket not found');
    if (t.status === 'CLOSED') throw new BadRequestException('This ticket is closed. Please open a new one.');
    await this.ds.query(`INSERT INTO support_ticket_events (ticket_id, type, author_id, author_name, author_kind, body) VALUES ($1,'REPLY',$2,$3,'MERCHANT',$4)`, [id, user.id, user.name, body.trim()]);
    await this.ds.query(`UPDATE support_tickets SET updated_at = now(), status = CASE WHEN status IN ('RESOLVED','WAITING') THEN 'OPEN' ELSE status END WHERE id = $1`, [id]);
    return { ok: true };
  }

  // ── platform side ────────────────────────────────────────────────────────
  async list(q: { q?: string; status?: string; priority?: string; category?: string; assignee?: string; organizationId?: string; open?: string; sort?: string; order?: string; page?: number; limit?: number }) {
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const page = Math.max(1, Number(q.page) || 1);
    const p: unknown[] = [];
    const c: string[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); c.push(sql.replace(/\?/g, `$${p.length}`)); };
    if (q.q) add(`(t.subject ILIKE ? OR t.description ILIKE ? OR o.name ILIKE ? OR t.reporter_name ILIKE ? OR ('SUP-' || t.number) ILIKE ?)`, `%${q.q}%`);
    if (q.status) add('t.status = ?', q.status);
    if (q.open === 'true') c.push(`t.status NOT IN ('RESOLVED','CLOSED')`);
    if (q.priority) add('t.priority = ?', q.priority);
    if (q.category) add('t.category = ?', q.category);
    if (q.organizationId) add('t.organization_id = ?', q.organizationId);
    if (q.assignee === 'unassigned') c.push('t.assignee_id IS NULL');
    else if (q.assignee) add('t.assignee_id = ?', q.assignee);
    const where = c.length ? `WHERE ${c.join(' AND ')}` : '';
    const prio = `CASE t.priority WHEN 'URGENT' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END`;
    const order = q.sort === 'priority' ? `${prio} ${q.order === 'desc' ? 'DESC' : 'ASC'}, t.created_at DESC` : `t.${q.sort === 'updated' ? 'updated_at' : 'created_at'} ${q.order === 'asc' ? 'ASC' : 'DESC'}`;
    const from = `FROM support_tickets t LEFT JOIN organizations o ON o.id = t.organization_id ${where}`;
    const [items, total, summary] = await Promise.all([
      this.ds.query(`SELECT t.id, t.number, t.category, t.subject, t.priority, t.status, t.assignee_id, t.assignee_name, t.reporter_name, t.source, t.organization_id, o.name AS organization_name, t.created_at, t.updated_at, t.resolved_at ${from} ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`, p),
      this.ds.query(`SELECT COUNT(*)::int AS n ${from}`, p),
      this.ds.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'OPEN')::int AS open, COUNT(*) FILTER (WHERE status = 'IN_PROGRESS')::int AS in_progress, COUNT(*) FILTER (WHERE status = 'WAITING')::int AS waiting,
                COUNT(*) FILTER (WHERE status IN ('RESOLVED','CLOSED'))::int AS resolved, COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','CLOSED') AND priority IN ('HIGH','URGENT'))::int AS high_priority,
                COUNT(*) FILTER (WHERE status NOT IN ('RESOLVED','CLOSED') AND assignee_id IS NULL)::int AS unassigned,
                COUNT(*) FILTER (WHERE category = 'BUG' AND status NOT IN ('RESOLVED','CLOSED'))::int AS open_bugs,
                COUNT(*) FILTER (WHERE category = 'COMPLAINT' AND status NOT IN ('RESOLVED','CLOSED'))::int AS open_complaints,
                ROUND(AVG(EXTRACT(EPOCH FROM (resolved_at - created_at)) / 3600) FILTER (WHERE resolved_at IS NOT NULL)::numeric, 1)::float AS avg_resolution_hours FROM support_tickets`,
      ),
    ]);
    return { items, total: total[0].n, page, limit, summary: summary[0] };
  }

  async get(id: string) {
    const t = (await this.ds.query(`SELECT t.*, o.name AS organization_name FROM support_tickets t LEFT JOIN organizations o ON o.id = t.organization_id WHERE t.id = $1`, [id]))[0];
    if (!t) throw new NotFoundException('Ticket not found');
    const events = await this.ds.query('SELECT id, type, author_name, author_kind, body, internal, meta, created_at FROM support_ticket_events WHERE ticket_id = $1 ORDER BY created_at', [id]);
    return { ticket: t, events };
  }

  /** Create a ticket on behalf of a restaurant (e.g. a complaint received by phone). */
  async createByAdmin(dto: { organizationId?: string; category: string; subject: string; description: string; priority?: string; reporterName?: string }, actor: AuditActor) {
    if (!TICKET_CATEGORIES.includes(dto.category)) throw new BadRequestException('Unknown category');
    if (dto.organizationId && !(await this.ds.query('SELECT 1 FROM organizations WHERE id = $1', [dto.organizationId]))[0]) throw new NotFoundException('Restaurant not found');
    const [t] = await this.ds.query(
      `INSERT INTO support_tickets (organization_id, reporter_name, category, subject, description, priority, source) VALUES ($1,$2,$3,$4,$5,$6,'ADMIN') RETURNING id, number`,
      [dto.organizationId ?? null, dto.reporterName?.trim() || null, dto.category, dto.subject.trim(), dto.description.trim(), TICKET_PRIORITIES.includes(dto.priority || '') ? dto.priority : 'MEDIUM'],
    );
    await this.ds.query(`INSERT INTO support_ticket_events (ticket_id, type, author_id, author_name, author_kind, body) VALUES ($1,'CREATED',$2,$3,'ADMIN',$4)`, [t.id, actor.id, actor.name, dto.description.trim()]);
    await this.audit.record(actor, { action: 'TICKET_CREATED', category: 'SUPPORT', entityType: 'ticket', entityId: t.id, entityLabel: `SUP-${t.number}`, organizationId: dto.organizationId ?? null, summary: `Logged ${dto.category.toLowerCase()} SUP-${t.number}: ${dto.subject}` });
    return t;
  }

  async update(id: string, dto: { status?: string; priority?: string; assigneeId?: string | null; resolution?: string }, actor: AuditActor) {
    const t = (await this.ds.query('SELECT * FROM support_tickets WHERE id = $1', [id]))[0];
    if (!t) throw new NotFoundException('Ticket not found');
    const sets: string[] = ['updated_at = now()'];
    const p: unknown[] = [id];
    const changes: Record<string, unknown> = {};
    const events: { type: string; body: string; meta?: unknown }[] = [];
    const push = (col: string, v: unknown) => { p.push(v); sets.push(`${col} = $${p.length}`); };

    if (dto.status && dto.status !== t.status) {
      if (!TICKET_STATUSES.includes(dto.status)) throw new BadRequestException('Unknown status');
      if (['RESOLVED', 'CLOSED'].includes(dto.status) && !(dto.resolution?.trim() || t.resolution)) throw new BadRequestException('Add a resolution summary before resolving a ticket');
      push('status', dto.status);
      if (dto.status === 'RESOLVED' || dto.status === 'CLOSED') { if (!t.resolved_at) sets.push('resolved_at = now()'); }
      else sets.push('resolved_at = NULL');
      changes.status = { from: t.status, to: dto.status };
      events.push({ type: dto.status === 'RESOLVED' ? 'RESOLVED' : 'STATUS', body: `Status changed from ${t.status} to ${dto.status}` });
      if (!t.first_response_at && dto.status !== 'OPEN') sets.push('first_response_at = now()');
    }
    if (dto.resolution !== undefined && dto.resolution.trim()) { push('resolution', dto.resolution.trim()); events.push({ type: 'RESOLVED', body: dto.resolution.trim() }); }
    if (dto.priority && dto.priority !== t.priority) {
      if (!TICKET_PRIORITIES.includes(dto.priority)) throw new BadRequestException('Unknown priority');
      push('priority', dto.priority);
      changes.priority = { from: t.priority, to: dto.priority };
      events.push({ type: 'PRIORITY', body: `Priority changed from ${t.priority} to ${dto.priority}` });
    }
    if (dto.assigneeId !== undefined && dto.assigneeId !== t.assignee_id) {
      let name: string | null = null;
      if (dto.assigneeId) {
        const a = (await this.ds.query(`SELECT name FROM staff WHERE id = $1 AND (is_platform_admin = true OR role = 'PLATFORM_SUPER_ADMIN') AND is_active = true`, [dto.assigneeId]))[0];
        if (!a) throw new BadRequestException('Assignee must be an active platform administrator');
        name = a.name;
      }
      push('assignee_id', dto.assigneeId);
      push('assignee_name', name);
      changes.assignee = { from: t.assignee_name, to: name };
      events.push({ type: 'ASSIGN', body: name ? `Assigned to ${name}` : 'Unassigned' });
    }
    if (events.length === 0) return { id, unchanged: true };
    await this.ds.query(`UPDATE support_tickets SET ${sets.join(', ')} WHERE id = $1`, p);
    for (const e of events) {
      await this.ds.query(`INSERT INTO support_ticket_events (ticket_id, type, author_id, author_name, author_kind, body, internal) VALUES ($1,$2,$3,$4,'ADMIN',$5,$6)`, [id, e.type, actor.id, actor.name, e.body, !['RESOLVED', 'STATUS'].includes(e.type)]);
    }
    await this.audit.record(actor, { action: 'TICKET_UPDATED', category: 'SUPPORT', entityType: 'ticket', entityId: id, entityLabel: `SUP-${t.number}`, organizationId: t.organization_id, summary: `Updated SUP-${t.number}`, changes });
    return { id, changes };
  }

  /** Internal notes stay inside the platform team; replies are visible to the restaurant. */
  async addEvent(id: string, kind: 'NOTE' | 'REPLY', body: string, actor: AuditActor) {
    const t = (await this.ds.query('SELECT id, number, organization_id, first_response_at FROM support_tickets WHERE id = $1', [id]))[0];
    if (!t) throw new NotFoundException('Ticket not found');
    await this.ds.query(`INSERT INTO support_ticket_events (ticket_id, type, author_id, author_name, author_kind, body, internal) VALUES ($1,$2,$3,$4,'ADMIN',$5,$6)`, [id, kind, actor.id, actor.name, body.trim(), kind === 'NOTE']);
    await this.ds.query(`UPDATE support_tickets SET updated_at = now(), first_response_at = COALESCE(first_response_at, CASE WHEN $2 = 'REPLY' THEN now() END) WHERE id = $1`, [id, kind]);
    await this.audit.record(actor, { action: kind === 'NOTE' ? 'TICKET_NOTE_ADDED' : 'TICKET_REPLIED', category: 'SUPPORT', entityType: 'ticket', entityId: id, entityLabel: `SUP-${t.number}`, organizationId: t.organization_id, summary: `${kind === 'NOTE' ? 'Added an internal note to' : 'Replied on'} SUP-${t.number}` });
    return { ok: true };
  }

  assertMerchant(user: any) {
    if (!user || user.isPlatformAdmin) throw new ForbiddenException('Support requests are raised from a restaurant account');
  }
}
