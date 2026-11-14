import { DataSource } from 'typeorm';

interface FeatureState { at: number; disabled: Set<string>; overrides: Map<string, string> }
let state: FeatureState | null = null;
const TTL = 15_000;

export const invalidateFeatureCache = () => { state = null; };

async function load(ds: DataSource): Promise<FeatureState> {
  if (state && Date.now() - state.at < TTL) return state;
  try {
    const [flags, overrides] = await Promise.all([
      ds.query('SELECT feature_key FROM feature_flags WHERE enabled = false'),
      ds.query('SELECT organization_id, feature_key, mode FROM org_feature_overrides'),
    ]);
    state = {
      at: Date.now(),
      disabled: new Set(flags.map((f: any) => f.feature_key)),
      overrides: new Map(overrides.map((o: any) => [`${o.organization_id}:${o.feature_key}`, o.mode])),
    };
  } catch {
    state = { at: Date.now(), disabled: new Set(), overrides: new Map() }; // tables not migrated yet: plan rules only
  }
  return state;
}

/**
 * Final say on whether an organization may use a feature:
 *  1. global kill switch off            -> blocked for everyone
 *  2. per-restaurant FORCE_OFF          -> blocked
 *  3. per-restaurant FORCE_ON           -> allowed even if the plan lacks it
 *  4. otherwise                         -> the plan decides
 */
export async function resolveFeatureAccess(ds: DataSource, orgId: string, feature: string, planAllows: boolean): Promise<{ allowed: boolean; reason: 'OK' | 'PLAN' | 'DISABLED' | 'OVERRIDE_OFF' | 'OVERRIDE_ON' }> {
  const s = await load(ds);
  if (s.disabled.has(feature)) return { allowed: false, reason: 'DISABLED' };
  const o = s.overrides.get(`${orgId}:${feature}`);
  if (o === 'FORCE_OFF') return { allowed: false, reason: 'OVERRIDE_OFF' };
  if (o === 'FORCE_ON') return { allowed: true, reason: 'OVERRIDE_ON' };
  return planAllows ? { allowed: true, reason: 'OK' } : { allowed: false, reason: 'PLAN' };
}
