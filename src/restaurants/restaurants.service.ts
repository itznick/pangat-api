import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { resolveOperations } from './operations.js';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { StaffRole } from '../common/enums/index.js';
import { Restaurant } from './entities/restaurant.entity.js';
import { Staff } from '../auth/entities/staff.entity.js';
import { Order } from '../orders/entities/order.entity.js';
import { UpdateSettingsDto } from './dto/update-settings.dto.js';
import { CreateStaffDto } from './dto/create-staff.dto.js';
import { AuditService } from '../audit/audit.service.js';
import { EntitlementService } from '../subscriptions/entitlement.service.js';
import { isSystemAccountEmail, loadCapacityContext, reserveStaffSeat } from '../subscriptions/capacity.js';
import { BCRYPT_COST } from '../common/security/passwords.js';
import { assertPasswordAllowed } from '../common/security/password-policy.js';
import { EmailDeliveryService } from '../common/services/email-delivery.service.js';
import { renderEmail } from '../common/services/email-template.js';

@Injectable()
export class RestaurantsService {
  constructor(
    @InjectRepository(Restaurant)
    private readonly restaurantRepo: Repository<Restaurant>,
    @InjectRepository(Staff)
    private readonly staffRepo: Repository<Staff>,
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @Optional()
    private readonly entitlementService?: EntitlementService,
    @Optional()
    private readonly auditService?: AuditService,
    @Optional() private readonly emailService?: EmailDeliveryService,
  ) {}

  async findBySlug(identifier: string): Promise<Restaurant> {
    const clean = identifier.trim();
    const cleanLower = clean.toLowerCase();
    
    // Check if identifier is a UUID
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean);

    const restaurant = isUuid
      ? await this.restaurantRepo.findOne({
          where: [{ id: clean }, { slug: cleanLower }],
          relations: { tables: true },
        })
      : await this.restaurantRepo.findOne({
          where: [{ slug: cleanLower }, { slug: clean }],
          relations: { tables: true },
        });

    if (!restaurant) {
      throw new NotFoundException(`Restaurant '${identifier}' not found`);
    }

    return restaurant;
  }

  async getFeedback(slug: string) {
    const restaurant = await this.findBySlug(slug);

    // Fetch orders with recorded feedback
    const ordersWithFeedback = await this.orderRepo
      .createQueryBuilder('order')
      .where('order.restaurantId = :restId', { restId: restaurant.id })
      .andWhere("order.feedback IS NOT NULL")
      .orderBy('order.createdAt', 'DESC')
      .take(50)
      .getMany();

    const actualReviews = ordersWithFeedback
      .filter((o) => o.feedback && o.feedback.rating)
      .map((o) => ({
        id: `fb-${o.id}`,
        orderId: o.id,
        tableNumber: o.tableNumber || '01',
        rating: Number(o.feedback?.rating) || 5,
        tags: o.feedback?.tags || [],
        comment: o.feedback?.comment || undefined,
        createdAt: o.feedback?.submittedAt || o.createdAt,
      }));

    const ratingBreakdown: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    const tagCounts: Record<string, number> = {};

    let totalRatingSum = 0;
    for (const r of actualReviews) {
      const star = Math.min(5, Math.max(1, Math.round(r.rating)));
      ratingBreakdown[star] = (ratingBreakdown[star] || 0) + 1;
      totalRatingSum += r.rating;

      if (Array.isArray(r.tags)) {
        for (const t of r.tags) {
          tagCounts[t] = (tagCounts[t] || 0) + 1;
        }
      }
    }

    const totalCount = actualReviews.length;
    const averageRating = totalCount > 0 ? Number((totalRatingSum / totalCount).toFixed(1)) : 0;

    return {
      restaurantSlug: restaurant.slug,
      restaurantName: restaurant.name,
      averageRating,
      totalCount,
      ratingBreakdown,
      tagCounts,
      recentReviews: actualReviews.slice(0, 50),
    };
  }

  async submitFeedback(
    slug: string,
    dto: { orderId?: string; tableNumber?: string; rating: number; tags?: string[]; comment?: string },
  ) {
    const restaurant = await this.findBySlug(slug);
    const rawRating = Number(dto.rating);
    const safeRating = Number.isFinite(rawRating) ? Math.min(5, Math.max(1, Math.round(rawRating))) : 5;

    if (dto.orderId) {
      const order = await this.orderRepo.findOne({
        where: { id: dto.orderId, restaurantId: restaurant.id },
      });
      if (order) {
        order.feedback = {
          rating: safeRating,
          tags: Array.isArray(dto.tags) ? dto.tags : [],
          comment: dto.comment?.trim() || undefined,
          submittedAt: new Date().toISOString(),
        };
        await this.orderRepo.save(order);
        return { success: true, orderId: order.id, feedback: order.feedback };
      }
    }

    return {
      success: true,
      feedback: {
        rating: safeRating,
        tags: Array.isArray(dto.tags) ? dto.tags : [],
        comment: dto.comment?.trim() || undefined,
        submittedAt: new Date().toISOString(),
      },
    };
  }

  /** Appends an audit entry. Throws on failure (callers pass their transaction's manager so the change and its record are saved together). */
  async audit(restaurantId: string, entityType: string, entityId: string, action: string, actor: any, metadata: Record<string, any> | null, em?: EntityManager, organizationId?: string | null) {
    if (!this.auditService) return;
    await this.auditService.record({
      restaurantId,
      organizationId: organizationId ?? null,
      entityType,
      entityId,
      action,
      staffId: actor?.id,
      staffName: actor?.name,
      staffRole: actor?.role,
      staffEmail: actor?.email,
      metadata,
    }, em);
  }

  /** Every time Pangat staff opened this outlet's console data (names and roles only; never their email). */
  async platformAccessLog(restaurantId: string) {
    const outlet = await this.restaurantRepo.findOne({ where: { id: restaurantId } });
    if (!outlet) throw new NotFoundException('Outlet not found');
    return this.restaurantRepo.manager.query(
      `SELECT actor_name AS "actorName", actor_role AS "actorRole", action, entity_label AS area, summary, created_at AS "createdAt"
       FROM platform_audit_logs
       WHERE category = 'PRIVACY' AND action IN ('MERCHANT_DATA_VIEWED','MERCHANT_DATA_CHANGED') AND entity_id = ANY($1::text[])
       ORDER BY created_at DESC LIMIT 100`,
      [[outlet.id, outlet.slug]],
    );
  }

  /** Recent sign-in attempts (successful and failed) for this outlet's organization. */
  async signInActivity(restaurantId: string) {
    const outlet = await this.restaurantRepo.findOne({ where: { id: restaurantId } });
    if (!outlet?.organizationId) return [];
    return this.restaurantRepo.manager.query(
      `SELECT email, success, reason, ip, user_agent AS "userAgent", created_at AS "createdAt"
       FROM login_events WHERE organization_id = $1 AND is_platform_admin = false ORDER BY created_at DESC LIMIT 100`,
      [outlet.organizationId],
    );
  }

  async auditLogs(restaurantId: string, q: { entityType?: string; action?: string; page: number; limit: number }) {
    if (!this.auditService) return { items: [], total: 0, page: 1, limit: q.limit };
    const outlet = await this.restaurantRepo.findOne({ where: { id: restaurantId } });
    return this.auditService.list(restaurantId, q, outlet?.organizationId);
  }

  /**
   * Settings that decide where customer money goes or what tax is charged. Only the Owner may change them: a manager who
   * could edit the UPI ID could quietly send every customer payment to a personal account.
   */
  static readonly OWNER_ONLY_SETTINGS = ['upiVpa', 'gstin', 'fssaiLicense', 'hsnSac', 'gstPercentage', 'serviceChargePercentage'] as const;

  private static maskSetting(key: string, v: unknown): string {
    const s = v === null || v === undefined || v === '' ? '(empty)' : String(v);
    if (key === 'upiVpa' || key === 'gstin') return s.length <= 4 ? '***' : `${s.slice(0, 2)}***${s.includes('@') ? s.slice(s.indexOf('@')) : s.slice(-2)}`;
    return s;
  }

  private async notifyOwnerOfSensitiveChange(restaurant: Restaurant, changes: { key: string; from: unknown; to: unknown }[], actor?: any) {
    if (!this.emailService || changes.length === 0) return;
    try {
      const owner = await this.staffRepo.findOne({
        where: { organizationId: restaurant.organizationId ?? undefined, role: StaffRole.SUPER_OWNER, isActive: true } as any,
        order: { createdAt: 'ASC' } as any,
      });
      if (!owner?.email) return;
      const label: Record<string, string> = { upiVpa: 'UPI ID', gstin: 'GSTIN', fssaiLicense: 'FSSAI licence', hsnSac: 'HSN/SAC code', gstPercentage: 'GST %', serviceChargePercentage: 'Service charge %' };
      const mail = renderEmail({
        preheader: `A payment or tax setting was changed for ${restaurant.name}`,
        heading: 'A payment or tax setting was changed',
        name: owner.name,
        paragraphs: [
          `${actor?.name || 'A team member'} (${String(actor?.role || 'staff').replace(/_/g, ' ').toLowerCase()}) changed these settings for ${restaurant.name}:`,
          ...changes.map((c) => `${label[c.key] || c.key}: ${RestaurantsService.maskSetting(c.key, c.from)} → ${RestaurantsService.maskSetting(c.key, c.to)}`),
        ],
        note: 'If you did not expect this, change your password and review your team under Settings → Team. The change is recorded in your activity log.',
      });
      await this.emailService.sendTransactionalEmail({ to: owner.email, subject: `Payment or tax setting changed: ${restaurant.name}`, htmlContent: mail.html, textContent: mail.text });
    } catch {
      /* the change is already saved and audited; a failed courtesy email must not undo it */
    }
  }

  async updateSettings(slug: string, dto: UpdateSettingsDto, actor?: any): Promise<Restaurant> {
    const restaurant = await this.findBySlug(slug);
    // findBySlug loads the outlet's tables, and Restaurant.tables is a cascading relation: saving the outlet with a stale list would
    // make TypeORM delete (or re-insert) any table created after the list was read. A settings change must never touch tables, so the
    // list is set aside for the response and the save only sees the outlet's own columns.
    const tablesAsRead = restaurant.tables;
    (restaurant as { tables?: unknown }).tables = undefined;
    const before = { gst: restaurant.gstPercentage, service: restaurant.serviceChargePercentage, upi: restaurant.upiVpa };
    const beforeOps = restaurant.operations;

    const sensitive: { key: string; from: unknown; to: unknown }[] = [];
    for (const key of RestaurantsService.OWNER_ONLY_SETTINGS) {
      const next = (dto as Record<string, unknown>)[key];
      if (next === undefined) continue;
      const cur = (restaurant as unknown as Record<string, unknown>)[key];
      const same = typeof cur === 'number' || typeof next === 'number' ? Number(cur ?? 0) === Number(next ?? 0) : String(cur ?? '') === String(next ?? '');
      if (!same) sensitive.push({ key, from: cur, to: next });
    }
    if (sensitive.length && actor?.role === StaffRole.STORE_MANAGER && !actor?.isPlatformAdmin) {
      throw new ForbiddenException('Only the owner can change the UPI ID, GST details or service charge. Ask your owner to update it.');
    }

    const { operations, ...rest } = dto;
    Object.assign(restaurant, rest);
    if (operations) {
      // Merge section by section so a partial update never wipes the rest of the rules
      const current = resolveOperations(restaurant.operations);
      restaurant.operations = {
        ...current,
        ...operations,
        hours: { ...current.hours, ...(operations.hours ?? {}) },
        orderTypes: { ...current.orderTypes, ...(operations.orderTypes ?? {}) },
        payments: { ...current.payments, ...(operations.payments ?? {}) },
      } as typeof current;
    }
    const saved = await this.restaurantRepo.manager.transaction(async (em) => {
      const persisted = await em.getRepository(Restaurant).save(restaurant);
      await this.audit(restaurant.id, 'RESTAURANT', restaurant.id, 'SETTINGS_UPDATED', actor, {
        changed: Object.keys(dto),
        before,
        after: { gst: persisted.gstPercentage, service: persisted.serviceChargePercentage, upi: persisted.upiVpa },
        // the steward-settle switch is a separation-of-duties control: always show its before/after
        stewardCanSettle: operations && 'stewardCanSettle' in operations ? { from: resolveOperations(beforeOps).stewardCanSettle, to: resolveOperations(persisted.operations).stewardCanSettle } : undefined,
      }, em);
      return persisted;
    });
    void this.notifyOwnerOfSensitiveChange(saved, sensitive, actor);
    saved.tables = tablesAsRead; // same response shape as before
    return saved;
  }

  /** What a diner (or any anonymous caller) may see about an outlet. */
  toPublic(r: Restaurant) {
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      branchArea: r.branchArea,
      phone: r.phone,
      isActive: r.isActive,
      upiVpa: r.upiVpa,
      gstin: r.gstin,
      fssaiLicense: r.fssaiLicense,
      hsnSac: r.hsnSac,
      gstPercentage: r.gstPercentage,
      serviceChargePercentage: r.serviceChargePercentage ?? 0,
      isVegOnly: r.isVegOnly,
      operations: r.operations,
      tables: (r.tables || []).map((t) => ({ id: t.id, tableNumber: t.tableNumber, status: t.status })),
    };
  }

  /** True when the authenticated user may see the full (settings) view of this outlet. */
  async canSeeFull(user: any, r: Restaurant): Promise<boolean> {
    if (!user) return false;
    if (user.isPlatformAdmin || user.role === 'PLATFORM_SUPER_ADMIN') return true;
    if (user.restaurantId && user.restaurantId === r.id) return true;
    return Boolean(user.role === 'SUPER_OWNER' && user.organizationId && user.organizationId === r.organizationId);
  }

  private async ownedOutlet(restaurantId: string): Promise<Restaurant> {
    const restaurant = await this.restaurantRepo.findOne({ where: { id: restaurantId } });
    if (!restaurant) throw new NotFoundException(`Restaurant with ID '${restaurantId}' not found`);
    return restaurant;
  }

  private static publicStaff(s: Staff) {
    return {
      id: s.id,
      name: s.name,
      email: s.email,
      phone: s.phone,
      role: s.role,
      restaurantId: s.restaurantId,
      isActive: s.isActive !== false,
      hasKitchenPin: Boolean(s.pinHash || s.pinCode),
      lastLoginAt: s.lastLoginAt,
      createdAt: s.createdAt,
    };
  }

  async listStaff(restaurantId: string) {
    const restaurant = await this.ownedOutlet(restaurantId);
    const rows = await this.staffRepo.find({
      where: { restaurantId: restaurant.id },
      order: { createdAt: 'ASC' },
    });
    return rows.filter((s) => !s.email.endsWith('@stations.pangat.app')).map(RestaurantsService.publicStaff);
  }

  async createStaff(restaurantId: string, dto: CreateStaffDto, actor?: any) {
    const restaurant = await this.ownedOutlet(restaurantId);
    const email = dto.email.trim().toLowerCase();
    assertPasswordAllowed(dto.password, { email, name: dto.name });

    // @stations.pangat.app is reserved for system accounts (they use no seat and are hidden): a person must never be able to use it
    if (isSystemAccountEmail(email)) {
      throw new BadRequestException('That email domain is reserved for system accounts. Use the person\'s own email address.');
    }
    const existing = await this.staffRepo
      .createQueryBuilder('s')
      .where('LOWER(s.email) = :email', { email })
      .getOne();
    if (existing) {
      throw new BadRequestException('A user with this email address already exists');
    }

    // Staff routes are owner-only, so there is no platform-administrator path and therefore no limit override for seats
    const override = null;
    const staff = this.staffRepo.create({
      name: dto.name.trim(),
      email,
      passwordHash: await bcrypt.hash(dto.password, BCRYPT_COST),
      mustChangePassword: true, // the owner typed it, so the member must replace it with their own
      role: dto.role,
      phone: dto.phone?.trim() || null,
      organizationId: restaurant.organizationId,
      restaurantId: restaurant.id,
    });
    const capacity = await loadCapacityContext(this.staffRepo.manager.connection, restaurant.organizationId); // before the transaction: see loadCapacityContext
    const saved = await this.staffRepo.manager.transaction(async (em) => {
      // A seat is checked under the outlet's row lock in the same transaction as the insert, so concurrent requests
      // cannot both take the last seat. System accounts (kitchen station) never count; see subscriptions/capacity.ts.
      if (restaurant.organizationId) await reserveStaffSeat(em, restaurant.id, capacity, 1, override, 'staff');
      const persisted = await em.getRepository(Staff).save(staff);
      await this.audit(restaurant.id, 'STAFF', persisted.id, 'STAFF_CREATED', actor, { role: persisted.role, email: persisted.email, name: persisted.name }, em, restaurant.organizationId);
      return persisted;
    });
    return RestaurantsService.publicStaff(saved);
  }

  private async staffOfOutlet(restaurantId: string, staffId: string): Promise<Staff> {
    const staff = await this.staffRepo.findOne({ where: { id: staffId, restaurantId } });
    if (!staff || staff.email.endsWith('@stations.pangat.app')) {
      throw new NotFoundException('Staff member not found at this outlet');
    }
    return staff;
  }

  async updateStaff(restaurantId: string, staffId: string, dto: import('./dto/create-staff.dto.js').UpdateStaffDto, actor: any) {
    const staff = await this.staffOfOutlet(restaurantId, staffId);
    const before = { name: staff.name, phone: staff.phone, role: staff.role, isActive: staff.isActive };
    let reactivating = false;
    if (staff.id === actor?.id && dto.isActive === false) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    if (dto.name !== undefined) staff.name = dto.name.trim();
    if (dto.phone !== undefined) staff.phone = dto.phone.trim() || null;
    if (dto.role !== undefined) staff.role = dto.role;
    if (dto.isActive !== undefined) {
      // re-activation takes a seat again (checked below, under the outlet lock, in the same transaction as the save)
      reactivating = dto.isActive && staff.isActive === false && !isSystemAccountEmail(staff.email);
      staff.isActive = dto.isActive;
    }
    const roleChanged = before.role !== staff.role;
    const deactivated = before.isActive !== false && staff.isActive === false;
    const outletForSeat = reactivating ? await this.ownedOutlet(restaurantId) : null;
    const capacity = outletForSeat ? await loadCapacityContext(this.staffRepo.manager.connection, outletForSeat.organizationId) : null;
    const saved = await this.staffRepo.manager.transaction(async (em) => {
      if (reactivating && outletForSeat?.organizationId) await reserveStaffSeat(em, restaurantId, capacity, 1, null, 'staff-reactivation');
      const persisted = await em.getRepository(Staff).save(staff);
      const after = { name: persisted.name, phone: persisted.phone, role: persisted.role, isActive: persisted.isActive };
      await this.audit(restaurantId, 'STAFF', staffId, roleChanged ? 'STAFF_ROLE_CHANGED' : deactivated ? 'STAFF_DEACTIVATED' : 'STAFF_UPDATED', actor, { target: persisted.email, before, after }, em, persisted.organizationId);
      // A deactivated person must be signed out at once (the token check already enforces it; this also invalidates old tokens)
      return persisted;
    });
    return RestaurantsService.publicStaff(saved);
  }

  /** Owner-initiated password reset: returns a one-time temporary password (shown once, never stored in clear). */
  async resetStaffPassword(restaurantId: string, staffId: string, actor?: any) {
    const staff = await this.staffOfOutlet(restaurantId, staffId);
    const temp = `Pg-${randomBytes(6).toString('base64url')}`;
    staff.passwordHash = await bcrypt.hash(temp, BCRYPT_COST);
    staff.mustChangePassword = true;
    staff.passwordChangedAt = new Date();
    staff.failedLoginCount = 0;
    staff.lockedUntil = null;
    await this.staffRepo.manager.transaction(async (em) => {
      await em.getRepository(Staff).save(staff);
      await this.audit(restaurantId, 'STAFF', staffId, 'STAFF_PASSWORD_RESET', actor, { target: staff.email }, em, staff.organizationId);
    });
    return { staffId: staff.id, email: staff.email, temporaryPassword: temp };
  }

  /** True when `pin` already opens another kitchen account at this outlet (a PIN must identify exactly one person). */
  private async pinInUse(restaurantId: string, pin: string, exceptStaffId?: string): Promise<boolean> {
    const chefs = await this.staffRepo.find({ where: { restaurantId, role: StaffRole.CHEF } });
    for (const c of chefs) {
      if (c.id === exceptStaffId || c.isActive === false) continue;
      if (c.pinHash && (await bcrypt.compare(pin, c.pinHash))) return true;
      if (c.pinCode && c.pinCode === pin) return true;
    }
    return false;
  }

  /**
   * A personal kitchen PIN: the person signs in to the kitchen screen with it and every action is recorded under THEIR name
   * (the shared station PIN records everything as "Kitchen Station", so nobody can be held to account).
   */
  async setStaffPin(restaurantId: string, staffId: string, pin: string, actor?: any) {
    const staff = await this.staffOfOutlet(restaurantId, staffId);
    if (staff.role !== StaffRole.CHEF) throw new BadRequestException('Only kitchen (chef) accounts sign in with a PIN');
    if (!/^\d{4,6}$/.test(pin)) throw new BadRequestException('Kitchen PIN must be 4 to 6 digits');
    if (await this.pinInUse(restaurantId, pin, staff.id)) throw new BadRequestException('That PIN is already used by someone else at this outlet. Choose another.');
    staff.pinHash = await bcrypt.hash(pin, BCRYPT_COST);
    staff.pinCode = null;
    await this.staffRepo.manager.transaction(async (em) => {
      await em.getRepository(Staff).save(staff);
      await this.audit(restaurantId, 'STAFF', staff.id, 'STAFF_PIN_SET', actor, { target: staff.email }, em, staff.organizationId);
    });
    return { staffId: staff.id, hasPin: true };
  }

  /** Create or rotate the outlet's kitchen-station PIN (stored hashed on a dedicated CHEF station account). */
  async setKitchenPin(restaurantId: string, pin: string, actor?: any) {
    const restaurant = await this.ownedOutlet(restaurantId);
    const stationEmail = `kitchen.${restaurant.slug}@stations.pangat.app`;
    let station = await this.staffRepo.findOne({ where: { restaurantId: restaurant.id, email: stationEmail } });
    if (!station) {
      station = this.staffRepo.create({
        name: 'Kitchen Station',
        email: stationEmail,
        passwordHash: await bcrypt.hash(randomBytes(24).toString('hex'), BCRYPT_COST),
        role: StaffRole.CHEF,
        organizationId: restaurant.organizationId,
        restaurantId: restaurant.id,
      });
    }
    if (await this.pinInUse(restaurant.id, pin, station.id)) throw new BadRequestException('That PIN is already used by someone at this outlet. Choose another.');
    station.pinHash = await bcrypt.hash(pin, BCRYPT_COST);
    station.pinCode = null;
    station.isActive = true;
    const hadPin = Boolean(station.id);
    await this.staffRepo.manager.transaction(async (em) => {
      await em.getRepository(Staff).save(station);
      await this.audit(restaurant.id, 'RESTAURANT', restaurant.id, 'KITCHEN_PIN_CHANGED', actor, { firstTimeSetup: !hadPin }, em, restaurant.organizationId);
    });
    return { configured: true };
  }

  async kitchenPinStatus(restaurantId: string) {
    const restaurant = await this.ownedOutlet(restaurantId);
    const stations = await this.staffRepo.find({ where: { restaurantId: restaurant.id, role: StaffRole.CHEF } });
    return { configured: stations.some((s) => s.isActive !== false && (s.pinHash || s.pinCode)) };
  }
}
