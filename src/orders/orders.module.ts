import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Order } from './entities/order.entity.js';
import { OrderItem } from './entities/order-item.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { Table } from '../tables/entities/table.entity.js';
import { MenuItem } from '../menu/entities/menu-item.entity.js';
import { Modifier } from '../menu/entities/modifier.entity.js';
import { OrdersService } from './orders.service.js';
import { OrdersController } from './orders.controller.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Order, OrderItem, Restaurant, Table, MenuItem, Modifier]),
    AuditModule,
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
