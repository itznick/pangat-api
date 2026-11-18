import { Injectable, Logger, NestMiddleware, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as os from 'os';
import { EventsGateway } from '../events/events.gateway.js';
import { getSetting } from './settings.service.js';
import { resolveEmailProvider } from '../common/services/email-delivery.service.js';

// ── request metrics (in memory, per process) ─────────────────────────────────
interface Sample { t: number; ms: number; status: number }

@Injectable()
export class MetricsService {
  private ring: Sample[] = [];
  private total = 0;
  private errors5xx = 0;
  private errors4xx = 0;
  readonly startedAt = Date.now();

  record(ms: number, status: number) {
    this.total++;
    if (status >= 500) this.errors5xx++;
    else if (status >= 400) this.errors4xx++;
    this.ring.push({ t: Date.now(), ms, status });
    if (this.ring.length > 5000) this.ring.splice(0, this.ring.length - 5000);
  }

  snapshot() {
    const now = Date.now();
    const recent = this.ring.filter((s) => now - s.t <= 15 * 60_000);
    const sorted = recent.map((s) => s.ms).sort((a, b) => a - b);
    const pct = (p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);
    const fails = recent.filter((s) => s.status >= 500).length;
    const perMinute: { minute: string; requests: number; errors: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const start = now - (i + 1) * 60_000;
      const end = now - i * 60_000;
      const slice = this.ring.filter((s) => s.t >= start && s.t < end);
      perMinute.push({ minute: new Date(end).toISOString(), requests: slice.length, errors: slice.filter((s) => s.status >= 500).length });
    }
    return {
      total: this.total,
      errors5xx: this.errors5xx,
      errors4xx: this.errors4xx,
      windowMinutes: 15,
      windowRequests: recent.length,
      windowFailures: fails,
      errorRatePct: recent.length ? Math.round((fails / recent.length) * 1000) / 10 : 0,
      p50Ms: pct(0.5),
      p95Ms: pct(0.95),
      p99Ms: pct(0.99),
      perMinute,
    };
  }
}

@Injectable()
export class RequestMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}
  use(req: any, res: any, next: () => void) {
    const start = process.hrtime.bigint();
    res.on('finish', () => this.metrics.record(Number(process.hrtime.bigint() - start) / 1e6, res.statusCode));
    next();
  }
}

// ── server error log (5xx) ────────────────────────────────────────────────────
type Sink = (e: { method: string; url: string; status: number; error: Error; userId?: string | null; orgId?: string | null }) => void;
let sink: Sink | null = null;
/** Called by the global exception filter for every 5xx. */
export const reportServerError: Sink = (e) => sink?.(e);

export function redact(text: string, max: number): string {
  return String(text || '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/Bearer\s+[\w.-]+/gi, 'Bearer [token]')
    .replace(/\b\d{10,}\b/g, '[number]')
    .replace(/\(([^)]{1,60})\)=\(([^)]*)\)/g, '($1)=([value])')
    .slice(0, max);
}
const cleanPath = (url: string) => url.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').slice(0, 300);

@Injectable()
export class ErrorLogService implements OnModuleInit {
  private readonly logger = new Logger(ErrorLogService.name);
  constructor(private readonly ds: DataSource) {}
  onModuleInit() {
    sink = (e) => {
      void this.ds
        .query(
          `INSERT INTO error_logs (method, path, status, error_name, message, stack, user_id, organization_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [e.method?.slice(0, 10), cleanPath(e.url || ''), e.status, (e.error?.name || 'Error').slice(0, 100), redact(e.error?.message, 400), redact(e.error?.stack || '', 1500), e.userId ?? null, e.orgId ?? null],
        )
        .catch((err) => this.logger.debug(`error log write failed: ${err.message}`));
    };
  }
}

// ── monitoring read model ────────────────────────────────────────────────────
@Injectable()
export class MonitoringService {
  constructor(
    private readonly ds: DataSource,
    private readonly metrics: MetricsService,
    private readonly gateway: EventsGateway,
  ) {}

  private async dbProbe() {
    const samples: number[] = [];
    let ok = true;
    for (let i = 0; i < 3; i++) {
      const t = Date.now();
      try {
        await this.ds.query('SELECT 1');
        samples.push(Date.now() - t);
      } catch {
        ok = false;
      }
    }
    return { ok, latencyMs: samples.length ? Math.round(samples.reduce((a, b) => a + b, 0) / samples.length) : null };
  }

  async health() {
    const probe = await this.dbProbe();
    const pool: any = (this.ds.driver as any)?.master;
    const mem = process.memoryUsage();
    const [dbStats, tables, errorsByHour, topErrors, hook, hooks7, mail, jobs, snaps, migrations] = await Promise.all([
      this.ds
        .query(
          `SELECT pg_database_size(current_database())::float AS size_bytes,
                  (SELECT COUNT(*)::int FROM pg_stat_activity WHERE datname = current_database()) AS connections,
                  (SELECT COUNT(*)::int FROM pg_stat_activity WHERE datname = current_database() AND state = 'active' AND now() - query_start > interval '5 seconds') AS slow_active,
                  (SELECT ROUND(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2)::float FROM pg_stat_database WHERE datname = current_database()) AS cache_hit_pct,
                  (SELECT xact_rollback::float FROM pg_stat_database WHERE datname = current_database()) AS rollbacks,
                  (SELECT deadlocks::int FROM pg_stat_database WHERE datname = current_database()) AS deadlocks,
                  current_setting('server_version') AS version`,
        )
        .then((r) => r[0])
        .catch(() => null),
      this.ds
        .query(`SELECT relname AS name, n_live_tup::int AS rows, pg_total_relation_size(relid)::float AS bytes FROM pg_stat_user_tables ORDER BY pg_total_relation_size(relid) DESC LIMIT 8`)
        .catch(() => []),
      this.ds.query(
        `SELECT to_char(date_trunc('hour', created_at), 'YYYY-MM-DD"T"HH24:00:00"Z"') AS hour, COUNT(*)::int AS errors FROM error_logs WHERE created_at > now() - interval '24 hours' GROUP BY 1 ORDER BY 1`,
      ),
      this.ds.query(`SELECT method, path, COUNT(*)::int AS n, MAX(created_at) AS last_seen FROM error_logs WHERE created_at > now() - interval '24 hours' GROUP BY 1,2 ORDER BY 3 DESC LIMIT 5`),
      this.ds.query(
        `SELECT MAX(received_at) AS last_received, MAX(received_at) FILTER (WHERE status = 'PROCESSED') AS last_processed,
                COUNT(*) FILTER (WHERE received_at > now() - interval '24 hours')::int AS received_24h,
                COUNT(*) FILTER (WHERE status IN ('REJECTED','FAILED') AND received_at > now() - interval '24 hours')::int AS failed_24h FROM webhook_events`,
      ),
      this.ds.query(`SELECT status, COUNT(*)::int AS n FROM webhook_events WHERE received_at > now() - interval '7 days' GROUP BY 1`),
      this.ds.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'DELIVERED')::int AS delivered, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed, COUNT(*) FILTER (WHERE status = 'SKIPPED')::int AS skipped,
                MAX(created_at) FILTER (WHERE status = 'DELIVERED') AS last_delivered FROM notification_deliveries WHERE channel = 'EMAIL' AND created_at > now() - interval '7 days'`,
      ),
      this.ds.query(`SELECT j.*, (SELECT COUNT(*)::int FROM job_runs r WHERE r.job_name = j.job_name AND r.status = 'FAILED' AND r.started_at > now() - interval '7 days') AS failures_7d
                     FROM (SELECT DISTINCT ON (job_name) * FROM job_runs ORDER BY job_name, started_at DESC) j ORDER BY j.job_name`),
      this.ds.query(`SELECT taken_at, db_ok, db_latency_ms, heap_mb, rss_mb, api_requests, api_errors, p95_ms, ws_clients FROM health_snapshots WHERE taken_at > now() - interval '24 hours' ORDER BY taken_at`),
      this.ds.query('SELECT name, applied_at FROM schema_migrations ORDER BY name').catch(() => []),
    ]);

    const razorpayConfigured = Boolean(getSetting('gateway.razorpayWebhookSecret') || process.env.RAZORPAY_WEBHOOK_SECRET);
    const emailProvider = resolveEmailProvider();
    const emailConfigured = emailProvider !== null;
    const api = this.metrics.snapshot();
    const problems: string[] = [];
    if (!probe.ok) problems.push('Database unreachable');
    if (api.errorRatePct >= 5) problems.push(`API error rate ${api.errorRatePct}%`);
    if (hook[0].failed_24h > 0) problems.push(`${hook[0].failed_24h} webhook failure(s) in 24h`);
    if (jobs.some((j: any) => j.status === 'FAILED')) problems.push('A background job failed on its last run');
    const status = !probe.ok ? 'DOWN' : problems.length ? 'DEGRADED' : 'HEALTHY';

    return {
      status,
      problems,
      checkedAt: new Date().toISOString(),
      database: {
        ...probe,
        version: dbStats?.version ?? null,
        sizeMb: dbStats ? Math.round(dbStats.size_bytes / 1048576) : null,
        connections: dbStats?.connections ?? null,
        slowActiveQueries: dbStats?.slow_active ?? null,
        cacheHitPct: dbStats?.cache_hit_pct ?? null,
        deadlocks: dbStats?.deadlocks ?? null,
        pool: pool ? { total: pool.totalCount ?? null, idle: pool.idleCount ?? null, waiting: pool.waitingCount ?? null } : null,
        largestTables: tables.map((t: any) => ({ name: t.name, rows: t.rows, sizeMb: Math.round((t.bytes / 1048576) * 10) / 10 })),
      },
      api: { ...api, errorsByHour, topFailingRoutes: topErrors },
      process: {
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        rssMb: Math.round(mem.rss / 1048576),
        heapUsedMb: Math.round(mem.heapUsed / 1048576),
        heapTotalMb: Math.round(mem.heapTotal / 1048576),
        cpuCount: os.cpus().length,
        loadAvg: os.loadavg().map((n) => Math.round(n * 100) / 100),
        systemMemoryTotalMb: Math.round(os.totalmem() / 1048576),
        systemMemoryFreeMb: Math.round(os.freemem() / 1048576),
      },
      realtime: { connectedClients: this.gateway.getConnectedSocketsCount(), activeOutletRooms: this.gateway.getActiveOutletSlugs().length },
      integrations: [
        {
          key: 'razorpay', name: 'Razorpay payments', configured: razorpayConfigured,
          status: !razorpayConfigured ? 'NOT_CONFIGURED' : hook[0].failed_24h > 0 ? 'DEGRADED' : 'OK',
          detail: razorpayConfigured ? 'Webhook secret present; payments are only recorded from signed gateway events.' : 'Webhook secret is missing: incoming payment events are rejected.',
          lastEventAt: hook[0].last_received, lastProcessedAt: hook[0].last_processed, received24h: hook[0].received_24h, failed24h: hook[0].failed_24h,
          webhookPath: '/api/v1/subscriptions/webhook/razorpay',
          last7Days: Object.fromEntries(hooks7.map((h: any) => [h.status, h.n])),
        },
        {
          key: 'email', name: `Transactional email (${emailProvider?.provider ?? 'not configured'})`, configured: emailConfigured,
          status: !emailConfigured ? 'NOT_CONFIGURED' : mail[0].failed > mail[0].delivered && mail[0].failed > 0 ? 'DEGRADED' : 'OK',
          detail: emailConfigured ? `Sending through ${emailProvider!.provider}.` : 'No API key: email notifications are recorded as skipped. In-app notifications still work.',
          lastEventAt: mail[0].last_delivered, delivered7d: mail[0].delivered, failed7d: mail[0].failed, skipped7d: mail[0].skipped,
        },
        { key: 'realtime', name: 'Realtime (Socket.IO)', configured: true, status: 'OK', detail: `${this.gateway.getConnectedSocketsCount()} client(s) connected across ${this.gateway.getActiveOutletSlugs().length} outlet room(s).` },
        { key: 'database', name: 'PostgreSQL', configured: true, status: probe.ok ? 'OK' : 'DOWN', detail: probe.ok ? `Query latency ${probe.latencyMs} ms.` : 'Cannot run queries.' },
      ],
      jobs,
      history: snaps,
      backups: {
        managedBy: 'Database provider',
        note:
          'Pangat does not run its own backups and cannot verify provider snapshots from here. Rely on your database provider’s point-in-time recovery (for example Neon branching / PITR) and confirm its retention in the provider console. Per-restaurant data exports are available under Data exports.',
        sizeMb: dbStats ? Math.round(dbStats.size_bytes / 1048576) : null,
        migrations,
      },
    };
  }

  async errors(q: { q?: string; status?: string; from?: string; page?: number; limit?: number }) {
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const page = Math.max(1, Number(q.page) || 1);
    const p: unknown[] = [];
    const c: string[] = [];
    if (q.q) { p.push(`%${q.q}%`); c.push(`(path ILIKE $${p.length} OR message ILIKE $${p.length} OR error_name ILIKE $${p.length})`); }
    if (q.status) { p.push(Number(q.status)); c.push(`status = $${p.length}`); }
    if (q.from) { p.push(q.from); c.push(`created_at >= $${p.length}`); }
    const where = c.length ? `WHERE ${c.join(' AND ')}` : '';
    const [items, total] = await Promise.all([
      this.ds.query(`SELECT id, method, path, status, error_name, message, stack, created_at FROM error_logs ${where} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`, p),
      this.ds.query(`SELECT COUNT(*)::int AS n FROM error_logs ${where}`, p),
    ]);
    return { items, total: total[0].n, page, limit };
  }

  async webhooks(q: { status?: string; type?: string; page?: number; limit?: number }) {
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const page = Math.max(1, Number(q.page) || 1);
    const p: unknown[] = [];
    const c: string[] = [];
    if (q.status) { p.push(q.status); c.push(`w.status = $${p.length}`); }
    if (q.type) { p.push(`%${q.type}%`); c.push(`w.event_type ILIKE $${p.length}`); }
    const where = c.length ? `WHERE ${c.join(' AND ')}` : '';
    const [items, total, byStatus] = await Promise.all([
      this.ds.query(
        `SELECT w.id, w.provider, w.event_id, w.event_type, w.status, w.http_status, w.error, w.signature_valid, w.payment_id, w.summary, w.processing_ms, w.received_at, o.name AS organization_name
         FROM webhook_events w LEFT JOIN organizations o ON o.id = w.organization_id ${where} ORDER BY w.received_at DESC LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        p,
      ),
      this.ds.query(`SELECT COUNT(*)::int AS n FROM webhook_events w ${where}`, p),
      this.ds.query(`SELECT status, COUNT(*)::int AS n FROM webhook_events WHERE received_at > now() - interval '7 days' GROUP BY 1`),
    ]);
    return { items, total: total[0].n, page, limit, last7Days: Object.fromEntries(byStatus.map((r: any) => [r.status, r.n])) };
  }

  jobRuns(name?: string, limit = 30) {
    return this.ds.query(
      `SELECT id, job_name, status, started_at, finished_at, duration_ms, result, error FROM job_runs ${name ? 'WHERE job_name = $2' : ''} ORDER BY started_at DESC LIMIT $1`,
      name ? [Math.min(100, limit), name] : [Math.min(100, limit)],
    );
  }

  /** Branch / outlet monitoring: online state, live orders and recent trouble per outlet. */
  async outlets(q: { q?: string; status?: string; online?: string; page?: number; limit?: number }) {
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const page = Math.max(1, Number(q.page) || 1);
    const p: unknown[] = [];
    const c: string[] = [];
    if (q.q) { p.push(`%${q.q}%`); c.push(`(r.name ILIKE $${p.length} OR r.slug ILIKE $${p.length} OR o.name ILIKE $${p.length} OR r.branch_area ILIKE $${p.length})`); }
    if (q.status === 'ACTIVE') c.push('r.is_active = true');
    if (q.status === 'INACTIVE') c.push('r.is_active = false');
    const where = c.length ? `WHERE ${c.join(' AND ')}` : '';
    const rows = await this.ds.query(
      `SELECT r.id, r.name, r.slug, r.branch_area, r.is_active, r.created_at, r.organization_id, o.name AS organization_name, o.status AS account_status,
              (SELECT COUNT(*)::int FROM tables t WHERE t.restaurant_id = r.id) AS tables,
              (SELECT COUNT(*)::int FROM orders od WHERE od.restaurant_id = r.id AND od.order_status NOT IN ('COMPLETED','CANCELLED')) AS open_orders,
              (SELECT COUNT(*)::int FROM orders od WHERE od.restaurant_id = r.id AND od.created_at > now() - interval '24 hours') AS orders_24h,
              (SELECT MAX(od.created_at) FROM orders od WHERE od.restaurant_id = r.id) AS last_order_at,
              (r.operations -> 'paused')::text AS paused
       FROM restaurants r LEFT JOIN organizations o ON o.id = r.organization_id ${where} ORDER BY r.created_at DESC`,
      p,
    );
    let items = rows.map((r: any) => ({ ...r, isOnline: this.gateway.isOutletOnline(r.slug) }));
    if (q.online === 'true') items = items.filter((i: any) => i.isOnline);
    if (q.online === 'false') items = items.filter((i: any) => !i.isOnline);
    return {
      items: items.slice((page - 1) * limit, page * limit),
      total: items.length,
      page,
      limit,
      summary: { total: rows.length, online: rows.filter((r: any) => this.gateway.isOutletOnline(r.slug)).length, inactive: rows.filter((r: any) => !r.is_active).length },
    };
  }
}
