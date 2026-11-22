import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { SETTINGS, SETTING_BY_KEY, SETTING_GROUPS, SettingDef } from './settings.registry.js';
import { resolveSettingsKey } from '../common/security/secrets.js';
import { PRIVACY_POLICY_VERSION } from './compliance.js';

type Cache = Map<string, unknown>;
let cache: Cache = new Map();
let loaded = false;

/** Synchronous read of the cached setting (falls back to the registry default). Safe to call from hot paths. */
export function getSetting<T = unknown>(key: string): T {
  if (cache.has(key)) return cache.get(key) as T;
  return (SETTING_BY_KEY.get(key)?.default ?? null) as T;
}
export const settingsLoaded = () => loaded;

function cryptoKey(): Buffer {
  const base = resolveSettingsKey();
  return crypto.scryptSync(base, 'pangat-platform-settings', 32);
}
export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cryptoKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
export function decryptSecret(blob: string): string | null {
  try {
    const raw = Buffer.from(blob, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', cryptoKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return null; // key rotated or data tampered with
  }
}

function coerce(def: SettingDef, raw: unknown): string | number | boolean | null {
  if (raw === null || raw === undefined || raw === '') return null;
  switch (def.type) {
    case 'boolean':
      if (typeof raw === 'boolean') return raw;
      if (raw === 'true') return true;
      if (raw === 'false') return false;
      throw new BadRequestException(`${def.label} must be true or false`);
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new BadRequestException(`${def.label} must be a number`);
      if (def.min !== undefined && n < def.min) throw new BadRequestException(`${def.label} must be at least ${def.min}`);
      if (def.max !== undefined && n > def.max) throw new BadRequestException(`${def.label} must be at most ${def.max}`);
      return n;
    }
    case 'email': {
      const s = String(raw).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new BadRequestException(`${def.label} must be a valid email address`);
      return s;
    }
    case 'datetime': {
      const d = new Date(String(raw));
      if (Number.isNaN(d.getTime())) throw new BadRequestException(`${def.label} must be a valid date and time`);
      return d.toISOString();
    }
    default: {
      const s = String(raw).trim();
      if (s.length > (def.type === 'text' ? 2000 : 300)) throw new BadRequestException(`${def.label} is too long`);
      return s;
    }
  }
}

@Injectable()
export class PlatformSettingsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlatformSettingsService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly ds: DataSource) {}

  onModuleInit() {
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), 15_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async refresh() {
    try {
      const rows: any[] = await this.ds.query('SELECT key, value, encrypted, is_secret FROM platform_settings');
      const next: Cache = new Map();
      for (const r of rows) {
        if (!SETTING_BY_KEY.has(r.key)) continue;
        if (r.is_secret) {
          const v = r.encrypted ? decryptSecret(r.encrypted) : null;
          if (v !== null) next.set(r.key, v);
        } else if (r.value !== null && r.value !== undefined) next.set(r.key, r.value);
      }
      cache = next;
      loaded = true;
    } catch (e) {
      // table may not exist until migration 010 has run; defaults apply meanwhile
      this.logger.debug(`Settings not loaded yet: ${(e as Error).message}`);
    }
  }

  /** Settings for the admin UI. Secret values are never returned, only whether one is set and its last 4 characters. */
  async list() {
    await this.refresh();
    const rows: any[] = await this.ds.query('SELECT key, updated_by, updated_at FROM platform_settings');
    const meta = new Map(rows.map((r) => [r.key, r]));
    return {
      groups: SETTING_GROUPS,
      settings: SETTINGS.map((d) => {
        const stored = cache.has(d.key);
        const v = cache.get(d.key);
        const base = { ...d, isSet: stored, updatedBy: meta.get(d.key)?.updated_by ?? null, updatedAt: meta.get(d.key)?.updated_at ?? null };
        if (d.secret) return { ...base, value: null, hint: stored && typeof v === 'string' ? `••••${v.slice(-4)}` : null };
        return { ...base, value: stored ? v : d.default };
      }),
    };
  }

  /**
   * Validate and store a batch of changes. `null` / empty clears a setting back to its default.
   * Returns the before/after diff (secrets masked) for the audit log.
   */
  async update(changes: Record<string, unknown>, actorName: string) {
    const entries = Object.entries(changes || {});
    if (entries.length === 0) throw new BadRequestException('No changes supplied');
    const prepared: { def: SettingDef; value: string | number | boolean | null }[] = [];
    for (const [key, raw] of entries) {
      const def = SETTING_BY_KEY.get(key);
      if (!def) throw new BadRequestException(`Unknown setting '${key}'`);
      prepared.push({ def, value: coerce(def, raw) });
    }
    const start = prepared.find((p) => p.def.key === 'operations.maintenanceStart')?.value;
    const end = prepared.find((p) => p.def.key === 'operations.maintenanceEnd')?.value;
    if (start && end && new Date(String(end)) <= new Date(String(start))) {
      throw new BadRequestException('Maintenance window end must be after its start');
    }

    const diff: Record<string, { from: unknown; to: unknown }> = {};
    for (const { def, value } of prepared) {
      const before = cache.has(def.key) ? cache.get(def.key) : null;
      const mask = (v: unknown) => (def.secret ? (v === null || v === undefined ? null : '••••(set)') : v);
      if (value === null) {
        await this.ds.query('DELETE FROM platform_settings WHERE key = $1', [def.key]);
        diff[def.key] = { from: mask(before), to: null };
      } else if (def.secret) {
        await this.ds.query(
          `INSERT INTO platform_settings (key, value, encrypted, is_secret, updated_by, updated_at) VALUES ($1, NULL, $2, true, $3, now())
           ON CONFLICT (key) DO UPDATE SET encrypted = EXCLUDED.encrypted, value = NULL, is_secret = true, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [def.key, encryptSecret(String(value)), actorName],
        );
        diff[def.key] = { from: mask(before), to: '••••(updated)' };
      } else {
        await this.ds.query(
          `INSERT INTO platform_settings (key, value, is_secret, updated_by, updated_at) VALUES ($1, $2::jsonb, false, $3, now())
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [def.key, JSON.stringify(value), actorName],
        );
        diff[def.key] = { from: before, to: value };
      }
    }
    await this.refresh();
    return diff;
  }

  /** Configuration safe to show to anyone (login screen, merchant console). */
  publicConfig() {
    const start = getSetting<string | null>('operations.maintenanceStart');
    const end = getSetting<string | null>('operations.maintenanceEnd');
    return {
      branding: {
        platformName: getSetting('branding.platformName'),
        supportEmail: getSetting('branding.supportEmail'),
        supportPhone: getSetting('branding.supportPhone'),
        logoUrl: getSetting('branding.logoUrl'),
      },
      selfSignupEnabled: getSetting<boolean>('general.selfSignupEnabled') !== false,
      compliance: {
        policyVersion: PRIVACY_POLICY_VERSION,
        legalName: getSetting<string>('compliance.legalName') || 'Pangat',
        registeredAddress: getSetting<string | null>('compliance.registeredAddress') ?? null,
        grievanceOfficer: {
          name: getSetting<string>('compliance.grievanceOfficerName') || 'Nikhil Bhamare',
          email: getSetting<string | null>('compliance.grievanceOfficerEmail') ?? null,
          phone: getSetting<string | null>('compliance.grievanceOfficerPhone') ?? null,
        },
        responseDays: getSetting<number>('compliance.responseDays') || 30,
        dinerDataRetentionMonths: getSetting<number>('compliance.dinerDataRetentionMonths') ?? 12,
        jurisdictionCity: getSetting<string | null>('compliance.jurisdictionCity') ?? null,
      },
      maintenance: { active: isMaintenanceActive(), message: getSetting('operations.maintenanceMessage'), start: start ?? null, end: end ?? null },
    };
  }
}

export function isMaintenanceActive(now = new Date()): boolean {
  if (getSetting<boolean>('operations.maintenanceEnabled') === true) return true;
  const s = getSetting<string | null>('operations.maintenanceStart');
  const e = getSetting<string | null>('operations.maintenanceEnd');
  return Boolean(s && e && now >= new Date(s) && now < new Date(e));
}
