import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

export interface AuditActor {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  role?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/** Build the actor block from an authenticated Express request. */
export function actorOf(req: any): AuditActor {
  const u = req?.user || {};
  return {
    id: u.id ?? null,
    name: u.name ?? null,
    email: u.email ?? null,
    role: u.platformRole ?? u.role ?? null,
    ip: String(req?.ip || '').slice(0, 64) || null, // proxy-verified (trust proxy); never the raw X-Forwarded-For header
    userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 255) || null,
  };
}

export interface AuditEntry {
  action: string;
  category: string;
  entityType?: string;
  entityId?: string;
  entityLabel?: string;
  organizationId?: string | null;
  summary: string;
  changes?: unknown;
  reason?: string | null;
}

export interface AuditQuery {
  q?: string;
  action?: string;
  category?: string;
  actorId?: string;
  organizationId?: string;
  entityType?: string;
  from?: string;
  to?: string;
  page?: number;
  limit?: number;
}

@Injectable()
export class PlatformAuditService {
  private readonly logger = new Logger(PlatformAuditService.name);
  constructor(private readonly ds: DataSource) {}

  /** Append an entry. The table itself rejects UPDATE / DELETE / TRUNCATE (database trigger). */
  async record(actor: AuditActor, e: AuditEntry): Promise<void> {
    try {
      await this.ds.query(
        `INSERT INTO platform_audit_logs (actor_id, actor_name, actor_email, actor_role, action, category, entity_type, entity_id, entity_label,
           organization_id, summary, changes, reason, ip, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)`,
        [
          actor.id ?? null, actor.name ?? null, actor.email ?? null, actor.role ?? null, e.action, e.category,
          e.entityType ?? null, e.entityId ?? null, e.entityLabel ?? null, e.organizationId ?? null, e.summary,
          e.changes === undefined ? null : JSON.stringify(e.changes), e.reason ?? null, actor.ip ?? null, actor.userAgent ?? null,
        ],
      );
    } catch (err) {
      this.logger.error(`AUDIT WRITE FAILED for ${e.action}: ${(err as Error).message}`);
    }
  }

  private where(q: AuditQuery) {
    const c: string[] = [];
    const p: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      p.push(v);
      c.push(sql.replace(/\?/g, `$${p.length}`));
    };
    if (q.q) add('(summary ILIKE ? OR entity_label ILIKE ? OR actor_name ILIKE ? OR actor_email ILIKE ? OR action ILIKE ?)', `%${q.q}%`);
    if (q.action) add('action = ?', q.action);
    if (q.category) add('category = ?', q.category);
    if (q.actorId) add('actor_id = ?', q.actorId);
    if (q.organizationId) add('organization_id = ?', q.organizationId);
    if (q.entityType) add('entity_type = ?', q.entityType);
    if (q.from) add('created_at >= ?', q.from);
    if (q.to) add('created_at <= ?', q.to);
    return { sql: c.length ? `WHERE ${c.join(' AND ')}` : '', p };
  }

  async list(q: AuditQuery) {
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const page = Math.max(1, Number(q.page) || 1);
    const w = this.where(q);
    const [items, count, actions, categories] = await Promise.all([
      this.ds.query(`SELECT * FROM platform_audit_logs ${w.sql} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, w.p),
      this.ds.query(`SELECT COUNT(*)::int AS n FROM platform_audit_logs ${w.sql}`, w.p),
      this.ds.query('SELECT DISTINCT action FROM platform_audit_logs ORDER BY action'),
      this.ds.query('SELECT DISTINCT category FROM platform_audit_logs ORDER BY category'),
    ]);
    return {
      items,
      total: count[0].n,
      page,
      limit,
      facets: { actions: actions.map((r: any) => r.action), categories: categories.map((r: any) => r.category) },
    };
  }

  /** Unpaged (capped) rows for CSV export, honouring the same filters. */
  async exportRows(q: AuditQuery) {
    const w = this.where(q);
    return this.ds.query(`SELECT * FROM platform_audit_logs ${w.sql} ORDER BY created_at DESC LIMIT 20000`, w.p);
  }

  forOrganization(organizationId: string, limit = 50) {
    return this.ds.query('SELECT * FROM platform_audit_logs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2', [organizationId, limit]);
  }
}
