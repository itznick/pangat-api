import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, In } from 'typeorm';
import { Table } from './entities/table.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { Order } from '../orders/entities/order.entity.js';
import { TableStatus, OrderStatus } from '../common/enums/index.js';
import { getOrgAccess, getOrgPlan, subscriptionBlockedError } from '../subscriptions/subscription-access.js';
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

  async create(dto: CreateTableDto): Promise<Table> {
    const restaurant = await this.restaurantRepo.findOne({
      where: { id: dto.restaurantId },
    });
    if (!restaurant) {
      throw new NotFoundException(`Restaurant with ID '${dto.restaurantId}' not found`);
    }

    // Plan limit on floor tables per outlet
    if (restaurant.organizationId && this.dataSource) {
      const plan = await getOrgPlan(this.dataSource, restaurant.organizationId);
      const access = await getOrgAccess(this.dataSource, restaurant.organizationId);
      if (access.blocked) throw subscriptionBlockedError(access.reason || 'Subscription inactive');
      if (plan && plan.maxTablesPerOutlet !== -1) {
        const count = await this.tableRepo.count({ where: { restaurantId: restaurant.id } });
        if (count >= plan.maxTablesPerOutlet) {
          throw new ForbiddenException(
            `Plan limit reached (${plan.maxTablesPerOutlet} tables per outlet). Upgrade your plan to add more tables.`,
          );
        }
      }
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

    const table = this.tableRepo.create({
      restaurantId: dto.restaurantId,
      tableNumber: cleanNum,
      status: TableStatus.VACANT,
      qrCodeUrl: `/r/${restaurant.slug}/t/${cleanNum}`,
    });

    return this.tableRepo.save(table);
  }

  async remove(id: string, authorizedRestaurantId?: string): Promise<void> {
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

    await this.tableRepo.remove(table);
  }
}
