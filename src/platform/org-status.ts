import { DataSource } from 'typeorm';
import { HttpException, HttpStatus } from '@nestjs/common';

const TTL_MS = 10_000;
const cache = new Map<string, { at: number; status: string; reason: string | null }>();

/** Account lifecycle (ACTIVE / SUSPENDED / DEACTIVATED) of an organization, cached briefly. */
export async function getOrgLifecycle(ds: DataSource, organizationId: string): Promise<{ status: string; reason: string | null }> {
  const hit = cache.get(organizationId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit;
  const rows = await ds.query('SELECT status, status_reason FROM organizations WHERE id = $1', [organizationId]);
  const v = { at: Date.now(), status: rows[0]?.status ?? 'ACTIVE', reason: rows[0]?.status_reason ?? null };
  cache.set(organizationId, v);
  return v;
}
export const invalidateOrgLifecycle = (organizationId: string) => cache.delete(organizationId);

export function accountBlockedError(status: string) {
  const suspended = status === 'SUSPENDED';
  return new HttpException(
    {
      message: suspended
        ? 'This restaurant account is suspended. Please contact Pangat support.'
        : 'This restaurant account has been deactivated. Please contact Pangat support.',
      code: suspended ? 'ACCOUNT_SUSPENDED' : 'ACCOUNT_DEACTIVATED',
    },
    HttpStatus.FORBIDDEN,
  );
}

export function maintenanceError(message: string) {
  return new HttpException({ message, code: 'MAINTENANCE_MODE' }, HttpStatus.SERVICE_UNAVAILABLE);
}
