import { DataSource } from 'typeorm';

export interface LoginMeta { ip?: string | null; userAgent?: string | null }

/** Sign-in history (success and failure). Never throws: logging must not break sign-in. */
export async function recordLoginEvent(
  ds: DataSource,
  e: { staffId?: string | null; email: string; success: boolean; reason?: string; isPlatformAdmin?: boolean; organizationId?: string | null; name?: string | null; role?: string | null },
  meta: LoginMeta = {},
): Promise<void> {
  try {
    await ds.query(
      `INSERT INTO login_events (staff_id, email, success, reason, is_platform_admin, organization_id, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.staffId ?? null, e.email.slice(0, 180), e.success, e.reason ?? null, !!e.isPlatformAdmin, e.organizationId ?? null, meta.ip?.slice(0, 64) ?? null, meta.userAgent?.slice(0, 255) ?? null],
    );
    if (e.isPlatformAdmin) {
      await ds.query(
        `INSERT INTO platform_audit_logs (actor_id, actor_name, actor_email, actor_role, action, category, entity_type, entity_id, entity_label, summary, reason, ip, user_agent)
         VALUES ($1,$2,$3,$4,$5,'SECURITY','platform_admin',$11,$6,$7,$8,$9,$10)`,
        [
          e.staffId ?? null, e.name ?? null, e.email, e.role ?? null, e.success ? 'ADMIN_LOGIN' : 'ADMIN_LOGIN_FAILED', e.email,
          e.success ? `Administrator ${e.name || e.email} signed in` : `Failed administrator sign-in for ${e.email}`, e.reason ?? null, meta.ip?.slice(0, 64) ?? null, meta.userAgent?.slice(0, 255) ?? null, e.staffId ?? null,
        ],
      );
    }
  } catch {
    /* ignore */
  }
}

/** `req.ip` is the proxy-verified client address (see `trust proxy` in main.ts). The raw X-Forwarded-For header is client-controlled and must never be used. */
export function clientMeta(req: any): LoginMeta {
  return { ip: String(req?.ip || '').slice(0, 64) || null, userAgent: String(req?.headers?.['user-agent'] || '') || null };
}
