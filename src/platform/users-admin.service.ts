import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { AuditActor, PlatformAuditService } from './audit.service.js';
import { MERCHANT_STAFF_SQL } from './restaurants-admin.service.js';
import { ALL_PERMISSIONS, PERMISSION_CATALOG, PLATFORM_ROLES, resolvePlatformPermissions } from './permissions.js';

const tempPassword = () => `${randomBytes(9).toString('base64url')}#7a`;

@Injectable()
export class UsersAdminService {
  constructor(private readonly ds: DataSource, private readonly audit: PlatformAuditService) {}

  // ── merchant users ───────────────────────────────────────────────────────
  async list(q: { q?: string; role?: string; status?: string; organizationId?: string; sort?: string; order?: string; page?: number; limit?: number }) {
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 25));
    const page = Math.max(1, Number(q.page) || 1);
    const p: unknown[] = [];
    const c: string[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); c.push(sql.replace(/\?/g, `$${p.length}`)); };
    if (q.q) add('(ms.name ILIKE ? OR ms.email ILIKE ? OR ms.phone ILIKE ? OR o.name ILIKE ?)', `%${q.q}%`);
    if (q.role) add('ms.role = ?', q.role);
    if (q.organizationId) add('ms.org_id = ?', q.organizationId);
    if (q.status === 'ACTIVE') c.push('ms.is_active = true AND (ms.locked_until IS NULL OR ms.locked_until < now())');
    if (q.status === 'INACTIVE') c.push('ms.is_active = false');
    if (q.status === 'LOCKED') c.push('ms.locked_until > now()');
    const where = c.length ? `WHERE ${c.join(' AND ')}` : '';
    const sortCol: Record<string, string> = { name: 'ms.name', role: 'ms.role', created: 'ms.created_at', login: 'ms.last_login_at', restaurant: 'o.name' };
    const order = `${sortCol[q.sort || 'created'] || 'ms.created_at'} ${q.order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, ms.id`;
    const from = `FROM ${MERCHANT_STAFF_SQL} ms LEFT JOIN organizations o ON o.id = ms.org_id LEFT JOIN restaurants r ON r.id = ms.restaurant_id ${where}`;
    const [items, total, summary] = await Promise.all([
      this.ds.query(
        `SELECT ms.id, ms.name, ms.email, ms.phone, ms.role, ms.is_active, ms.last_login_at, ms.failed_login_count, ms.locked_until, ms.created_at,
                ms.org_id AS organization_id, o.name AS organization_name, o.status AS account_status, r.name AS outlet_name
         ${from} ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
        p,
      ),
      this.ds.query(`SELECT COUNT(*)::int AS n ${from}`, p),
      this.ds.query(
        `SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_active)::int AS active, COUNT(*) FILTER (WHERE NOT is_active)::int AS inactive,
                COUNT(*) FILTER (WHERE locked_until > now())::int AS locked, COUNT(*) FILTER (WHERE last_login_at > now() - interval '30 days')::int AS signed_in_30d
         FROM ${MERCHANT_STAFF_SQL} ms`,
      ),
    ]);
    return { items, total: total[0].n, page, limit, summary: summary[0] };
  }

  async get(id: string) {
    const [u] = await this.ds.query(
      `SELECT ms.id, ms.name, ms.email, ms.phone, ms.role, ms.is_active, ms.last_login_at, ms.failed_login_count, ms.locked_until, ms.password_changed_at, ms.created_at,
              ms.org_id AS organization_id, o.name AS organization_name, o.status AS account_status, ms.restaurant_id, r.name AS outlet_name
       FROM ${MERCHANT_STAFF_SQL} ms LEFT JOIN organizations o ON o.id = ms.org_id LEFT JOIN restaurants r ON r.id = ms.restaurant_id WHERE ms.id = $1`,
      [id],
    );
    if (!u) throw new NotFoundException('User not found');
    const [logins, merchantActivity, restaurants] = await Promise.all([
      this.ds.query('SELECT created_at, success, reason, ip, user_agent FROM login_events WHERE staff_id = $1 ORDER BY created_at DESC LIMIT 25', [id]),
      this.ds.query('SELECT action, entity_type, reason, created_at FROM audit_logs WHERE staff_id = $1 ORDER BY created_at DESC LIMIT 20', [id]),
      u.organization_id ? this.ds.query('SELECT id, name, slug, is_active FROM restaurants WHERE organization_id = $1 ORDER BY created_at', [u.organization_id]) : [],
    ]);
    return { user: u, logins, activity: merchantActivity, restaurants };
  }

  private async target(id: string) {
    const u = (await this.ds.query(`SELECT id, name, email, role, is_active, is_platform_admin, organization_id FROM staff WHERE id = $1`, [id]))[0];
    if (!u) throw new NotFoundException('User not found');
    if (u.is_platform_admin || u.role === 'PLATFORM_SUPER_ADMIN') throw new ForbiddenException('Platform administrators are managed under Administrators');
    return u;
  }

  async setActive(id: string, isActive: boolean, reason: string | undefined, actor: AuditActor) {
    const u = await this.target(id);
    if (!isActive && !reason?.trim()) throw new BadRequestException('A reason is required to deactivate a user');
    await this.ds.query(
      `UPDATE staff SET is_active = $2, ${isActive ? '' : 'password_changed_at = now(),'} updated_at = now() WHERE id = $1`,
      [id, isActive],
    );
    await this.audit.record(actor, {
      action: isActive ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', category: 'USER', entityType: 'user', entityId: id, entityLabel: `${u.name} <${u.email}>`, organizationId: u.organization_id,
      summary: `${isActive ? 'Activated' : 'Deactivated'} ${u.name} (${u.role})`, changes: { isActive: { from: u.is_active, to: isActive } }, reason: reason?.trim() || null,
    });
    return { isActive };
  }

  async unlock(id: string, actor: AuditActor) {
    const u = await this.target(id);
    await this.ds.query('UPDATE staff SET failed_login_count = 0, locked_until = NULL WHERE id = $1', [id]);
    await this.audit.record(actor, { action: 'USER_UNLOCKED', category: 'USER', entityType: 'user', entityId: id, entityLabel: `${u.name} <${u.email}>`, organizationId: u.organization_id, summary: `Cleared the sign-in lock on ${u.name}` });
    return { unlocked: true };
  }

  async forceLogout(id: string, actor: AuditActor) {
    const u = await this.target(id);
    await this.ds.query('UPDATE staff SET password_changed_at = now() WHERE id = $1', [id]);
    await this.audit.record(actor, { action: 'USER_SESSIONS_REVOKED', category: 'SECURITY', entityType: 'user', entityId: id, entityLabel: `${u.name} <${u.email}>`, organizationId: u.organization_id, summary: `Signed ${u.name} out of every session` });
    return { revoked: true };
  }

  async resetPassword(id: string, actor: AuditActor) {
    const u = await this.target(id);
    const pw = tempPassword();
    await this.ds.query('UPDATE staff SET password_hash = $2, password_changed_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1', [id, await bcrypt.hash(pw, 10)]);
    await this.audit.record(actor, { action: 'USER_PASSWORD_RESET', category: 'SECURITY', entityType: 'user', entityId: id, entityLabel: `${u.name} <${u.email}>`, organizationId: u.organization_id, summary: `Reset the password for ${u.name}` });
    return { name: u.name, email: u.email, temporaryPassword: pw };
  }

  // ── platform administrators ──────────────────────────────────────────────
  access() {
    return { permissions: PERMISSION_CATALOG, roles: Object.entries(PLATFORM_ROLES).map(([key, r]) => ({ key, ...r })) };
  }

  async admins() {
    const rows = await this.ds.query(
      `SELECT id, name, email, phone, platform_role, platform_permissions, is_active, last_login_at, failed_login_count, locked_until, created_at
       FROM staff WHERE is_platform_admin = true OR role = 'PLATFORM_SUPER_ADMIN' ORDER BY created_at`,
    );
    return rows.map((r: any) => ({ ...r, platform_role: r.platform_role || 'OWNER', effective_permissions: resolvePlatformPermissions(r.platform_role, r.platform_permissions) }));
  }

  private validatePerms(perms?: string[] | null) {
    if (!perms) return null;
    const bad = perms.filter((p) => !ALL_PERMISSIONS.includes(p));
    if (bad.length) throw new BadRequestException(`Unknown permission(s): ${bad.join(', ')}`);
    return perms.length ? perms : null;
  }

  async createAdmin(dto: { name: string; email: string; role: string; permissions?: string[]; password?: string }, actor: AuditActor) {
    if (!PLATFORM_ROLES[dto.role]) throw new BadRequestException('Unknown platform role');
    const email = dto.email.trim().toLowerCase();
    if ((await this.ds.query('SELECT 1 FROM staff WHERE lower(email) = $1', [email]))[0]) throw new BadRequestException('A user with this email already exists');
    const pw = dto.password?.trim() || tempPassword();
    if (pw.length < 10) throw new BadRequestException('Password must be at least 10 characters');
    const perms = this.validatePerms(dto.permissions);
    const [row] = await this.ds.query(
      `INSERT INTO staff (name, email, password_hash, role, is_platform_admin, platform_role, platform_permissions, is_active) VALUES ($1,$2,$3,'PLATFORM_SUPER_ADMIN',true,$4,$5::jsonb,true) RETURNING id`,
      [dto.name.trim(), email, await bcrypt.hash(pw, 10), dto.role, perms ? JSON.stringify(perms) : null],
    );
    await this.audit.record(actor, {
      action: 'ADMIN_CREATED', category: 'USER', entityType: 'platform_admin', entityId: row.id, entityLabel: `${dto.name} <${email}>`,
      summary: `Created platform administrator ${dto.name} with role ${dto.role}`, changes: { role: dto.role, permissions: perms },
    });
    return { id: row.id, email, temporaryPassword: pw };
  }

  private async ownerCount(excludingId?: string) {
    const r = await this.ds.query(
      `SELECT COUNT(*)::int AS n FROM staff WHERE (is_platform_admin = true OR role = 'PLATFORM_SUPER_ADMIN') AND is_active = true AND COALESCE(platform_role,'OWNER') = 'OWNER'
         AND platform_permissions IS NULL ${excludingId ? 'AND id <> $1' : ''}`,
      excludingId ? [excludingId] : [],
    );
    return r[0].n as number;
  }

  async updateAdmin(id: string, dto: { name?: string; role?: string; permissions?: string[] | null; isActive?: boolean }, actor: AuditActor) {
    const a = (await this.ds.query(`SELECT * FROM staff WHERE id = $1 AND (is_platform_admin = true OR role = 'PLATFORM_SUPER_ADMIN')`, [id]))[0];
    if (!a) throw new NotFoundException('Administrator not found');
    const isSelf = actor.id === id;
    if (isSelf && (dto.role !== undefined || dto.permissions !== undefined || dto.isActive === false)) {
      throw new ForbiddenException('You cannot change your own role, permissions or status. Ask another owner.');
    }
    const before = { role: a.platform_role || 'OWNER', permissions: a.platform_permissions, isActive: a.is_active };
    const role = dto.role ?? before.role;
    if (!PLATFORM_ROLES[role]) throw new BadRequestException('Unknown platform role');
    const perms = dto.permissions === undefined ? a.platform_permissions : this.validatePerms(dto.permissions);
    const isActive = dto.isActive ?? a.is_active;
    // never leave the platform without an active, full-access owner
    const wasFullOwner = before.role === 'OWNER' && !before.permissions && a.is_active;
    const stillFullOwner = role === 'OWNER' && !perms && isActive;
    if (wasFullOwner && !stillFullOwner && (await this.ownerCount(id)) === 0) {
      throw new BadRequestException('This is the last full-access owner. Promote another administrator first.');
    }
    await this.ds.query(
      `UPDATE staff SET name = COALESCE($2, name), platform_role = $3, platform_permissions = $4::jsonb, is_active = $5, ${isActive ? '' : 'password_changed_at = now(),'} updated_at = now() WHERE id = $1`,
      [id, dto.name?.trim() || null, role, perms ? JSON.stringify(perms) : null, isActive],
    );
    // a role change must take effect on the next request: permissions are re-read from the database on every call
    await this.audit.record(actor, {
      action: 'ADMIN_UPDATED', category: 'USER', entityType: 'platform_admin', entityId: id, entityLabel: `${a.name} <${a.email}>`,
      summary: `Updated platform administrator ${a.name}`, changes: { role: { from: before.role, to: role }, permissions: { from: before.permissions, to: perms }, isActive: { from: before.isActive, to: isActive } },
    });
    return { id, role, isActive };
  }

  async resetAdminPassword(id: string, actor: AuditActor) {
    const a = (await this.ds.query(`SELECT id, name, email FROM staff WHERE id = $1 AND (is_platform_admin = true OR role = 'PLATFORM_SUPER_ADMIN')`, [id]))[0];
    if (!a) throw new NotFoundException('Administrator not found');
    if (a.id === actor.id) throw new ForbiddenException('Use Change password in your account menu to change your own password');
    const pw = tempPassword();
    await this.ds.query('UPDATE staff SET password_hash = $2, password_changed_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1', [id, await bcrypt.hash(pw, 10)]);
    await this.audit.record(actor, { action: 'ADMIN_PASSWORD_RESET', category: 'SECURITY', entityType: 'platform_admin', entityId: id, entityLabel: `${a.name} <${a.email}>`, summary: `Reset the password for administrator ${a.name}` });
    return { name: a.name, email: a.email, temporaryPassword: pw };
  }

  /** Sign-in history of platform administrators (successful and failed). */
  adminLogins(limit = 50) {
    return this.ds.query(
      `SELECT le.created_at, le.success, le.reason, le.ip, le.user_agent, le.email, st.name FROM login_events le LEFT JOIN staff st ON st.id = le.staff_id
       WHERE le.is_platform_admin = true ORDER BY le.created_at DESC LIMIT $1`,
      [Math.min(200, limit)],
    );
  }
}
