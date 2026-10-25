import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Headers,
  UseGuards,
} from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';
import { IdempotencyGuard } from '../common/guards/idempotency.guard.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post()
  @UseGuards(IdempotencyGuard)
  async create(
    @Body() dto: CreateOrderDto,
    @Headers('x-idempotency-key') idempotencyKey: string,
  ) {
    const order = await this.ordersService.create(dto, idempotencyKey);
    return withMessage(order, 'Order placed successfully and fired to kitchen');
  }

  @Get()
  async findAll(@Query('restaurantSlug') restaurantSlug?: string) {
    const orders = await this.ordersService.findAll(restaurantSlug);
    return withMessage(orders, 'Orders retrieved successfully');
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const order = await this.ordersService.findOne(id);
    return withMessage(order, 'Order retrieved successfully');
  }

  @Patch(':id/status')
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    const updated = await this.ordersService.updateStatus(id, dto.status);
    return withMessage(updated, `Order status advanced to ${dto.status}`);
  }

  @Patch(':id/mark-paid')
  async markPaid(@Param('id') id: string) {
    const updated = await this.ordersService.markPaid(id);
    return withMessage(updated, 'Order marked as paid');
  }
}
