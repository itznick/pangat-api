import { runPrivacyRetention } from '../privacy/retention.js';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EventsGateway } from '../events/events.gateway.js';
import { derivedStatus, ensureTrial, invalidateOrgAccess } from '../subscriptions/subscription-access.js';
import { CommsService } from './comms.service.js';
import { PlatformEventsService } from './events.service.js';
import { MetricsService } from './monitoring.service.js';
import { LATEST_SUB_SQL } from './subscriptions-admin.service.js';
import { getSetting } from './settings.service.js';

interface JobDef { name: string; label: string; everyMs: number; firstDelayMs: number; run: () => Promise<Record<string, unknown>> }

/**
 * Lightweight in-process scheduler. Every run is recorded in job_runs (visible under Monitoring). A database claim keeps two
 * API instances from running the same job at the same time. Set JOBS_DISABLED=true to turn all jobs off.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private timers: NodeJS.Timeout[] = [];
  private readonly jobs: JobDef[];

  constructor(
    private readonly ds: DataSource,
    private readonly events: PlatformEventsService,
    private readonly comms: CommsService,
    private readonly metrics: MetricsService,
    private readonly gateway: EventsGateway,
  ) {
    this.jobs = [
      { name: 'health-snapshot', label: 'Health sampling', everyMs: 5 * 60_000, firstDelayMs: 20_000, run: () => this.healthSnapshot() },
      { name: 'subscription-sweep', label: 'Subscription expiry & trial reminders', everyMs: 60 * 60_000, firstDelayMs: 45_000, run: () => this.subscriptionSweep() },
      { name: 'privacy-retention', label: 'Remove old personal details (privacy)', everyMs: 24 * 60 * 60_000, firstDelayMs: 180_000, run: () => runPrivacyRetention(this.ds) },
      { name: 'data-retention', label: 'Log retention cleanup', everyMs: 24 * 60 * 60_000, firstDelayMs: 120_000, run: () => this.retention() },
    ];
  }

  list() {
    return this.jobs.map((j) => ({ name: j.name, label: j.label, everyMinutes: j.everyMs / 60_000 }));
  }

  onModuleInit() {
    if (process.env.JOBS_DISABLED === 'true') {
      this.logger.warn('JOBS_DISABLED=true: background jobs are off');
      return;
    }
    for (const j of this.jobs) {
      const first = setTimeout(() => {
        void this.execute(j.name, false);
        const t = setInterval(() => void this.execute(j.name, false), j.everyMs);
        t.unref();
        this.timers.push(t);
      }, j.firstDelayMs);
      first.unref();
      this.timers.push(first);
    }
  }
  onModuleDestroy() {
    this.timers.forEach((t) => clearTimeout(t));
  }

  /** Run one job now (scheduler or manual). Returns the recorded run, or null if another instance holds it. */
  async execute(name: string, manual: boolean) {
    const job = this.jobs.find((j) => j.name === name);
    if (!job) return null;
    const minGap = manual ? 0 : Math.floor(job.everyMs * 0.8);
    let runId: string | undefined;
    try {
      const rows = await this.ds.query(
        `INSERT INTO job_runs (job_name, status) SELECT $1::varchar, 'RUNNING'
         WHERE NOT EXISTS (SELECT 1 FROM job_runs WHERE job_name = $1 AND status = 'RUNNING' AND started_at > now() - interval '10 minutes')
           AND NOT EXISTS (SELECT 1 FROM job_runs WHERE job_name = $1 AND status <> 'RUNNING' AND started_at > now() - ($2 || ' milliseconds')::interval)
         RETURNING id`,
        [name, String(minGap)],
      );
      runId = rows[0]?.id;
    } catch (e) {
      this.logger.debug(`Job claim failed (${name}): ${(e as Error).message}`);
      return null;
    }
    if (!runId) return null;
    const t0 = Date.now();
    try {
      const result = await job.run();
      await this.ds.query(`UPDATE job_runs SET status='SUCCESS', finished_at=now(), duration_ms=$2, result=$3::jsonb WHERE id=$1`, [runId, Date.now() - t0, JSON.stringify(result)]);
      return { id: runId, status: 'SUCCESS', result };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      await this.ds.query(`UPDATE job_runs SET status='FAILED', finished_at=now(), duration_ms=$2, error=$3 WHERE id=$1`, [runId, Date.now() - t0, msg]).catch(() => undefined);
      this.logger.error(`Job ${name} failed: ${msg}`);
      await this.events.emit('JOB_FAILED', 'WARNING', `Background job failed: ${job.label}`, msg);
      return { id: runId, status: 'FAILED', error: msg };
    }
  }

  private async healthSnapshot() {
    const t = Date.now();
    let ok = true;
    try { await this.ds.query('SELECT 1'); } catch { ok = false; }
    const lat = Date.now() - t;
    const m = process.memoryUsage();
    const s = this.metrics.snapshot();
    await this.ds.query(
      `INSERT INTO health_snapshots (db_ok, db_latency_ms, heap_mb, rss_mb, api_requests, api_errors, p95_ms, ws_clients) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [ok, lat, Math.round(m.heapUsed / 1048576), Math.round(m.rss / 1048576), s.windowRequests, s.windowFailures, Math.round(s.p95Ms), this.gateway.getConnectedSocketsCount()],
    );
    return { dbOk: ok, latencyMs: lat };
  }

  /** Persist lapsed subscriptions, notify the restaurant, and send trial reminders (each at most once). */
  private async subscriptionSweep() {
    // The status decision is subscription-access.ts `derivedStatus`: the same function the request guards use, so the sweep
    // only PERSISTS what the guards already enforce (it never changes who has access).
    const latest = `SELECT id, organization_id, status, current_period_end, grace_period_ends_at, cancel_at_period_end, source FROM (${LATEST_SUB_SQL}) s`;
    const lapsed: any[] = await this.ds.query(
      `${latest} WHERE status IN ('ACTIVE','TRIAL','PAST_DUE','GRACE_PERIOD') AND (current_period_end < now() OR (status IN ('PAST_DUE','GRACE_PERIOD') AND grace_period_ends_at IS NOT NULL AND grace_period_ends_at <= now()))`,
    );
    let toGrace = 0, expired = 0;
    for (const s of lapsed) {
      const next = derivedStatus({
        status: s.status, currentPeriodEnd: s.current_period_end, gracePeriodEndsAt: s.grace_period_ends_at, cancelAtPeriodEnd: s.cancel_at_period_end,
      });
      if (next === 'GRACE_PERIOD') {
        if (s.status !== 'GRACE_PERIOD') {
          const graceEnd = s.grace_period_ends_at ? new Date(s.grace_period_ends_at) : new Date(new Date(s.current_period_end).getTime() + Math.max(0, Number(getSetting<number>('subscription.gracePeriodDays') ?? 7)) * 86_400_000);
          await this.ds.query(`UPDATE organization_subscriptions SET status = 'GRACE_PERIOD', grace_period_ends_at = $2, updated_at = now() WHERE id = $1`, [s.id, graceEnd]);
          toGrace++;
        }
      } else if (next === 'EXPIRED') {
        await this.ds.query(`UPDATE organization_subscriptions SET status = 'EXPIRED', updated_at = now() WHERE id = $1`, [s.id]);
        await this.ds.query(`INSERT INTO subscription_audit_logs (organization_id, action, actor, reason) VALUES ($1,'SUBSCRIPTION_EXPIRED','SYSTEM','Period and grace window ended without renewal')`, [s.organization_id]);
        const org = (await this.ds.query('SELECT name FROM organizations WHERE id = $1', [s.organization_id]))[0];
        await this.events.emit('SUBSCRIPTION_EXPIRED', 'WARNING', `${org?.name ?? 'A restaurant'} subscription expired`, undefined, { organizationId: s.organization_id });
        await this.comms.sendTemplateToOrganization(s.organization_id, 'SUBSCRIPTION_EXPIRED', {}).catch(() => null);
        expired++;
      }
      invalidateOrgAccess(s.organization_id);
    }

    // restaurants that signed up before trials were created eagerly
    const missing: any[] = await this.ds.query(`SELECT o.id FROM organizations o WHERE NOT EXISTS (SELECT 1 FROM organization_subscriptions s WHERE s.organization_id = o.id)`);
    let trialsCreated = 0;
    for (const m of missing) if (await ensureTrial(this.ds, m.id)) trialsCreated++;

    const days = Math.max(0, Number(getSetting<number>('subscription.trialReminderDays') ?? 3));
    let reminders = 0;
    if (days > 0) {
      const trials: any[] = await this.ds.query(
        `${latest} WHERE status = 'TRIAL' AND current_period_end > now() AND current_period_end < now() + ($1 || ' days')::interval
           AND NOT EXISTS (SELECT 1 FROM subscription_audit_logs a WHERE a.idempotency_key = 'trial-reminder:' || s.id::text)`,
        [String(days)],
      );
      for (const s of trials) {
        const left = Math.max(1, Math.ceil((new Date(s.current_period_end).getTime() - Date.now()) / 86_400_000));
        await this.comms.sendTemplateToOrganization(s.organization_id, 'TRIAL_ENDING', { daysLeft: left, endDate: new Date(s.current_period_end).toLocaleDateString('en-IN', { dateStyle: 'medium' }) }).catch(() => null);
        await this.ds.query(`INSERT INTO subscription_audit_logs (organization_id, action, actor, reason, idempotency_key) VALUES ($1,'TRIAL_REMINDER_SENT','SYSTEM',$2,$3)`, [s.organization_id, `Trial ends in ${left} day(s)`, `trial-reminder:${s.id}`]);
        reminders++;
      }
    }
    return { trialsCreated, checked: lapsed.length, movedToGrace: toGrace, expired, trialReminders: reminders };
  }

  /** Operational logs only. The audit log is never pruned. */
  private async retention() {
    const del = async (sql: string) => (await this.ds.query(sql))[1] as number;
    return {
      healthSnapshots: await del(`DELETE FROM health_snapshots WHERE taken_at < now() - interval '14 days'`),
      errorLogs: await del(`DELETE FROM error_logs WHERE created_at < now() - interval '90 days'`),
      webhookEvents: await del(`DELETE FROM webhook_events WHERE received_at < now() - interval '180 days'`),
      // sign-in history is security evidence: keep a full year (CERT-In asks for 180 days of logs; DPDP security safeguards point to a year)
      loginEvents: await del(`DELETE FROM login_events WHERE created_at < now() - interval '365 days'`),
      jobRuns: await del(`DELETE FROM job_runs WHERE started_at < now() - interval '60 days'`),
    };
  }
}
