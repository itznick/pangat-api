import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Table } from './entities/table.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { TablesService } from './tables.service.js';
import { TablesController } from './tables.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([Table, Restaurant])],
  controllers: [TablesController],
  providers: [TablesService],
  exports: [TablesService],
})
export class TablesModule {}
