import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Restaurant } from './entities/restaurant.entity.js';
import { Staff } from '../auth/entities/staff.entity.js';
import { Order } from '../orders/entities/order.entity.js';
import { RestaurantsService } from './restaurants.service.js';
import { RestaurantsController } from './restaurants.controller.js';
import { OperationsColumnBootstrap } from './operations-column.bootstrap.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Restaurant, Staff, Order]),
    SubscriptionsModule,
  ],
  controllers: [RestaurantsController],
  providers: [RestaurantsService, OperationsColumnBootstrap],
  exports: [RestaurantsService],
})
export class RestaurantsModule {}
