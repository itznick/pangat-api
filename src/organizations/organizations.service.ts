import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Organization } from './entities/organization.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { Table } from '../tables/entities/table.entity.js';
import { TableStatus, StaffRole } from '../common/enums/index.js';
import { CreateOutletDto } from './dto/create-outlet.dto.js';
import { EntitlementService } from '../subscriptions/entitlement.service.js';
import { decideFeature, featureError } from '../subscriptions/subscription-access.js';
import { assertInitialTablesFit, loadCapacityContext, reserveOutletCapacity, resolveInitialTables } from '../subscriptions/capacity.js';
import { AuditService } from '../audit/audit.service.js';

@Injectable()
export class OrganizationsService {
  constructor(
    @InjectRepository(Organization)
    private readonly orgRepo: Repository<Organization>,
    @InjectRepository(Restaurant)
    private readonly restaurantRepo: Repository<Restaurant>,
    private readonly dataSource: DataSource,
    @Optional()
    private readonly entitlementService?: EntitlementService,
    @Optional()
    private readonly auditService?: AuditService,
  ) {}

  async listOutlets(user: any, requestedOrgId?: string): Promise<Restaurant[]> {
    if (user.role === 'PLATFORM_SUPER_ADMIN' || user.role === StaffRole.PLATFORM_SUPER_ADMIN) {
      if (requestedOrgId) {
        return this.restaurantRepo.find({
          where: { organizationId: requestedOrgId },
          order: { createdAt: 'ASC' },
        });
      }
      return this.restaurantRepo.find({
        order: { createdAt: 'ASC' },
      });
    }

    let orgId = user.organizationId;

    if (!orgId && user.restaurantId) {
      const rest = await this.restaurantRepo.findOne({
        where: { id: user.restaurantId },
      });
      if (rest?.organizationId) {
        orgId = rest.organizationId;
      }
    }

    if (!orgId) {
      return [];
    }

    return this.restaurantRepo.find({
      where: { organizationId: orgId },
      order: { createdAt: 'ASC' },
    });
  }

  async createOutlet(user: any, dto: CreateOutletDto): Promise<Restaurant> {
    let orgId = user.organizationId;

    if (!orgId && user.restaurantId) {
      const rest = await this.restaurantRepo.findOne({
        where: { id: user.restaurantId },
      });
      orgId = rest?.organizationId;
    }

    if (!orgId) {
      // Reject missing or unassociated organization instead of co-mingling into the first DB organization
      throw new BadRequestException(
        'Valid organization context is required to create a new restaurant outlet. Please contact platform administration.',
      );
    }

    // Check slug collision
    const existing = await this.restaurantRepo.findOne({
      where: { slug: dto.slug },
    });
    if (existing) {
      throw new BadRequestException(
        `An outlet with the slug '${dto.slug}' already exists`,
      );
    }

    // Subscription facts are read BEFORE the transaction takes its connection and lock (see loadCapacityContext)
    const ctx = (await loadCapacityContext(this.dataSource, orgId))!;
    const multiOutlet = await decideFeature(this.dataSource, orgId, 'MULTI_OUTLET');

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Plan checks run under the organisation's row lock, in the same transaction as the insert (no count-then-insert race):
      //  1. the MULTI_OUTLET feature is needed for a second or later outlet (the numeric limit alone never grants it)
      //  2. the numeric outlet limit
      //  3. the starting tables must fit the plan's per-outlet table limit (an explicit request over the limit is refused, not trimmed)
      await reserveOutletCapacity(queryRunner.manager, orgId, ctx, null, async (existing) => {
        if (existing >= 1 && !multiOutlet.allowed) throw featureError('MULTI_OUTLET', multiOutlet.reason);
      });
      const initial = resolveInitialTables(ctx.plan, { indoor: dto.tableCount }, { indoor: 10, outdoor: 0 });
      assertInitialTablesFit(initial, null);

      const outlet = queryRunner.manager.create(Restaurant, {
        organizationId: orgId,
        name: dto.name,
        slug: dto.slug,
        branchArea: dto.branchArea || null,
        phone: dto.phone || null,
        email: dto.email || null,
        upiVpa: dto.upiVpa,
        gstin: dto.gstin || null,
        gstPercentage: dto.gstPercentage ?? 5,
        isActive: true,
        isVegOnly: false,
        kdsNewOrderAlert: true,
        orderReadyChime: true,
        outOfStockNotification: true,
      });

      const savedOutlet = await queryRunner.manager.save(Restaurant, outlet);

      // Provision initial tables
      const tableCount = initial.total;
      const tables: Table[] = [];
      for (let i = 1; i <= tableCount; i++) {
        const tableNum = `T${String(i).padStart(2, '0')}`;
        tables.push(
          queryRunner.manager.create(Table, {
            restaurantId: savedOutlet.id,
            tableNumber: tableNum,
            status: TableStatus.VACANT,
            qrCodeUrl: `/r/${savedOutlet.slug}/t/${tableNum}`,
          }),
        );
      }
      await queryRunner.manager.save(Table, tables);

      await this.auditService?.record({
        restaurantId: savedOutlet.id, organizationId: orgId, entityType: 'RESTAURANT', entityId: savedOutlet.id, action: 'OUTLET_CREATED',
        staffId: user?.id, staffName: user?.name, staffRole: user?.role, staffEmail: user?.email,
        metadata: { name: savedOutlet.name, slug: savedOutlet.slug, tables: tableCount },
      }, queryRunner.manager);

      await queryRunner.commitTransaction();
      return savedOutlet;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }
}
