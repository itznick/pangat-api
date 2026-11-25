import { AuditService } from '../audit/audit.service.js';
import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { Table } from './entities/table.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { Order } from '../orders/entities/order.entity.js';
import { TableStatus, OrderStatus } from '../common/enums/index.js';
import { authoriseLimitOverride } from '../subscriptions/subscription-access.js';
import { loadCapacityContext, reserveTableCapacity } from '../subscriptions/capacity.js';
import { CreateTableDto } from './dto/create-table.dto.js';

@Injectable()
export class TablesService {
  constructor(
    @InjectRepository(Table)
    private readonly tableRepo: Repository<Table>,
    @InjectRepository(Restaurant)
    private readonly restaurantRepo: Repository<Restaurant>,
    @Optional()
    private readonly dataSource?: DataSource,
    @Optional()
    private readonly auditService?: AuditService,
  ) {}

  async findAll(restaurantId?: string, restaurantSlug?: string): Promise<Table[]> {
    if (restaurantId) {
      return this.tableRepo.find({
        where: { restaurantId },
        order: { tableNumber: 'ASC' },
      });
    }

    if (restaurantSlug) {
      const rest = await this.restaurantRepo.findOne({
        where: { slug: restaurantSlug },
      });
      if (rest) {
        return this.tableRepo.find({
          where: { restaurantId: rest.id },
          order: { tableNumber: 'ASC' },
        });
      }
      return [];
    }

    return [];
  }

  async findOne(id: string): Promise<Table> {
    const table = await this.tableRepo.findOne({ where: { id } });
    if (!table) {
      throw new NotFoundException(`Table with ID '${id}' not found`);
    }
    return table;
  }

  async updateStatus(id: string, status: TableStatus, authorizedRestaurantId?: string): Promise<Table> {
    const table = await this.findOne(id);
    if (authorizedRestaurantId && table.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Table does not belong to authorized restaurant');
    }
    table.status = status;
    return this.tableRepo.save(table);
  }

  async create(dto: CreateTableDto, actor?: any): Promise<Table> {
    const restaurant = await this.restaurantRepo.findOne({
      where: { id: dto.restaurantId },
    });
    if (!restaurant) {
      throw new NotFoundException(`Restaurant with ID '${dto.restaurantId}' not found`);
    }

    const cleanNum = dto.tableNumber.trim().toUpperCase();
    const existing = await this.tableRepo.findOne({
      where: {
        restaurantId: dto.restaurantId,
        tableNumber: cleanNum,
      },
    });
    if (existing) {
      throw new BadRequestException(`Table '${cleanNum}' already exists for this outlet`);
    }

    // Only a platform administrator can exceed the plan, and only with a recorded reason (refused loudly for anyone else)
    const override = authoriseLimitOverride(actor, dto.limitOverrideReason);

    const table = this.tableRepo.create({
      restaurantId: dto.restaurantId,
      tableNumber: cleanNum,
      status: TableStatus.VACANT,
      qrCodeUrl: `/r/${restaurant.slug}/t/${cleanNum}`,
    });

    // Subscription facts are read before the transaction (see loadCapacityContext): the transaction then needs only its own connection
    const ctx = this.dataSource ? await loadCapacityContext(this.dataSource, restaurant.organizationId) : null;
    return this.tableRepo.manager.transaction(async (em) => {
      // The plan limit is checked under the outlet's row lock, in the same transaction as the insert: two simultaneous
      // requests cannot both pass the count, and an outlet that is already over its limit cannot add another table
      await reserveTableCapacity(em, restaurant.id, ctx, 1, override, 'table');
      const persisted = await em.getRepository(Table).save(table);
      await this.auditService?.record({
        restaurantId: restaurant.id, organizationId: restaurant.organizationId, entityType: 'TABLE', entityId: persisted.id, action: 'TABLE_ADDED',
        staffId: actor?.id, staffName: actor?.name, staffRole: actor?.role, staffEmail: actor?.email, metadata: { tableNumber: persisted.tableNumber },
      }, em);
      return persisted;
    });
  }

  async remove(id: string, authorizedRestaurantId?: string, actor?: any): Promise<void> {
    const table = await this.findOne(id);
    if (authorizedRestaurantId && table.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Table does not belong to authorized restaurant');
    }

    // Guard: Prevent deleting tables currently active or occupied
    if (
      table.status === TableStatus.PREPPING ||
      table.status === TableStatus.OCCUPIED ||
      table.status === TableStatus.SERVED
    ) {
      throw new BadRequestException(
        `Cannot remove table '${table.tableNumber}' while its status is ${table.status}. Clear or complete dining sessions first.`,
      );
    }

    if (this.dataSource) {
      const activeOrderCount = await this.dataSource.getRepository(Order).count({
        where: {
          restaurantId: table.restaurantId,
          tableNumber: table.tableNumber,
          orderStatus: In([OrderStatus.RECEIVED, OrderStatus.PREPARING, OrderStatus.READY]),
        },
      });
      if (activeOrderCount > 0) {
        throw new BadRequestException(
          `Cannot remove table '${table.tableNumber}' while it has ${activeOrderCount} active dining order(s) in progress`,
        );
      }
    }

    await this.tableRepo.manager.transaction(async (em) => {
      await this.auditService?.record({
        restaurantId: table.restaurantId, entityType: 'TABLE', entityId: table.id, action: 'TABLE_REMOVED',
        staffId: actor?.id, staffName: actor?.name, staffRole: actor?.role, staffEmail: actor?.email, metadata: { tableNumber: table.tableNumber },
      }, em);
      await em.getRepository(Table).remove(table);
    });
  }
}
