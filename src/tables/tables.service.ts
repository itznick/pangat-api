import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Table } from './entities/table.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { TableStatus } from '../common/enums/index.js';
import { CreateTableDto } from './dto/create-table.dto.js';

@Injectable()
export class TablesService {
  constructor(
    @InjectRepository(Table)
    private readonly tableRepo: Repository<Table>,
    @InjectRepository(Restaurant)
    private readonly restaurantRepo: Repository<Restaurant>,
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
    await this.tableRepo.remove(table);
  }
}
