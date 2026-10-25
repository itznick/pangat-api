import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Table } from './entities/table.entity.js';
import { TableStatus } from '../common/enums/index.js';

@Injectable()
export class TablesService {
  constructor(
    @InjectRepository(Table)
    private readonly tableRepo: Repository<Table>,
  ) {}

  async findAll(restaurantId?: string): Promise<Table[]> {
    const where = restaurantId ? { restaurantId } : {};
    return this.tableRepo.find({
      where,
      order: { tableNumber: 'ASC' },
    });
  }

  async findOne(id: string): Promise<Table> {
    const table = await this.tableRepo.findOne({ where: { id } });
    if (!table) {
      throw new NotFoundException(`Table with ID '${id}' not found`);
    }
    return table;
  }

  async updateStatus(id: string, status: TableStatus): Promise<Table> {
    const table = await this.findOne(id);
    table.status = status;
    return this.tableRepo.save(table);
  }
}
