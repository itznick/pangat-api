import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { resolveOperations } from './operations.js';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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

  async audit(restaurantId: string, entityType: string, entityId: string, action: string, actor: any, metadata: Record<string, any> | null) {
    try {
      await this.auditService?.record({
        restaurantId,
        entityType,
        entityId,
        action,
        staffId: actor?.id,
        staffName: actor?.name,
        staffRole: actor?.role,
        metadata,
      });
    } catch {
      /* auditing must never break the business action */
    }
  }

  async auditLogs(restaurantId: string, q: { entityType?: string; action?: string; page: number; limit: number }) {
    if (!this.auditService) return { items: [], total: 0, page: 1, limit: q.limit };
    return this.auditService.list(restaurantId, q);
  }

  async updateSettings(slug: string, dto: UpdateSettingsDto, actor?: any): Promise<Restaurant> {
    const restaurant = await this.findBySlug(slug);
    const before = { gst: restaurant.gstPercentage, service: restaurant.serviceChargePercentage, upi: restaurant.upiVpa };

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
    const saved = await this.restaurantRepo.save(restaurant);
    await this.audit(restaurant.id, 'RESTAURANT', restaurant.id, 'SETTINGS_UPDATED', actor, {
      changed: Object.keys(dto),
      before,
      after: { gst: saved.gstPercentage, service: saved.serviceChargePercentage, upi: saved.upiVpa },
    });
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

  async createStaff(restaurantId: string, dto: CreateStaffDto) {
    const restaurant = await this.ownedOutlet(restaurantId);
    const email = dto.email.trim().toLowerCase();

    const existing = await this.staffRepo
      .createQueryBuilder('s')
      .where('LOWER(s.email) = :email', { email })
      .getOne();
    if (existing) {
      throw new BadRequestException('A user with this email address already exists');
    }

    // Entitlement Check: Verify staff quota per outlet has not been exceeded
    if (this.entitlementService && restaurant.organizationId) {
      const currentStaffCount = await this.staffRepo.count({
        where: { restaurantId, isActive: true },
      });
      const capacity = await this.entitlementService.canAddStaff(restaurant.organizationId, currentStaffCount);
      if (!capacity.allowed) {
        throw new ForbiddenException(
          `Plan staff limit reached (${capacity.maxStaff} staff members maximum per outlet). Upgrade your subscription plan to add more staff.`,
        );
      }
    }

    const staff = this.staffRepo.create({
      name: dto.name.trim(),
      email,
      passwordHash: await bcrypt.hash(dto.password, 10),
      role: dto.role,
      phone: dto.phone?.trim() || null,
      organizationId: restaurant.organizationId,
      restaurantId: restaurant.id,
    });
    return RestaurantsService.publicStaff(await this.staffRepo.save(staff));
  }

  private async staffOfOutlet(restaurantId: string, staffId: string): Promise<Staff> {
    const staff = await this.staffRepo.findOne({ where: { id: staffId, restaurantId } });
    if (!staff || staff.email.endsWith('@stations.pangat.app')) {
      throw new NotFoundException('Staff member not found at this outlet');
    }
    return staff;
  }

  async updateStaff(restaurantId: string, staffId: string, dto: import('./dto/create-staff.dto.js').UpdateStaffDto, actorId: string) {
    const staff = await this.staffOfOutlet(restaurantId, staffId);
    if (staff.id === actorId && dto.isActive === false) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    if (dto.name !== undefined) staff.name = dto.name.trim();
    if (dto.phone !== undefined) staff.phone = dto.phone.trim() || null;
    if (dto.role !== undefined) staff.role = dto.role;
    if (dto.isActive !== undefined) {
      if (dto.isActive && staff.isActive === false) {
        const restaurant = await this.ownedOutlet(restaurantId);
        if (this.entitlementService && restaurant.organizationId) {
          const count = await this.staffRepo.count({ where: { restaurantId, isActive: true } });
          const cap = await this.entitlementService.canAddStaff(restaurant.organizationId, count);
          if (!cap.allowed) throw new ForbiddenException(`Plan staff limit reached (${cap.maxStaff}). Upgrade to reactivate this member.`);
        }
      }
      staff.isActive = dto.isActive;
    }
    return RestaurantsService.publicStaff(await this.staffRepo.save(staff));
  }

  /** Owner-initiated password reset: returns a one-time temporary password (shown once, never stored in clear). */
  async resetStaffPassword(restaurantId: string, staffId: string) {
    const staff = await this.staffOfOutlet(restaurantId, staffId);
    const temp = `Pg-${randomBytes(6).toString('base64url')}`;
    staff.passwordHash = await bcrypt.hash(temp, 10);
    staff.passwordChangedAt = new Date();
    staff.failedLoginCount = 0;
    staff.lockedUntil = null;
    await this.staffRepo.save(staff);
    return { staffId: staff.id, email: staff.email, temporaryPassword: temp };
  }

  /** Create or rotate the outlet's kitchen-station PIN (stored hashed on a dedicated CHEF station account). */
  async setKitchenPin(restaurantId: string, pin: string) {
    const restaurant = await this.ownedOutlet(restaurantId);
    const stationEmail = `kitchen.${restaurant.slug}@stations.pangat.app`;
    let station = await this.staffRepo.findOne({ where: { restaurantId: restaurant.id, email: stationEmail } });
    if (!station) {
      station = this.staffRepo.create({
        name: 'Kitchen Station',
        email: stationEmail,
        passwordHash: await bcrypt.hash(randomBytes(24).toString('hex'), 10),
        role: StaffRole.CHEF,
        organizationId: restaurant.organizationId,
        restaurantId: restaurant.id,
      });
    }
    station.pinHash = await bcrypt.hash(pin, 10);
    station.pinCode = null;
    station.isActive = true;
    await this.staffRepo.save(station);
    return { configured: true };
  }

  async kitchenPinStatus(restaurantId: string) {
    const restaurant = await this.ownedOutlet(restaurantId);
    const stations = await this.staffRepo.find({ where: { restaurantId: restaurant.id, role: StaffRole.CHEF } });
    return { configured: stations.some((s) => s.isActive !== false && (s.pinHash || s.pinCode)) };
  }
}
