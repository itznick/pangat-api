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
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { StaffRole } from '../common/enums/index.js';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  /** Public diner order placement */
  @Post()
  @UseGuards(IdempotencyGuard)
  async create(
    @Body() dto: CreateOrderDto,
    @Headers('x-idempotency-key') idempotencyKey: string,
  ) {
    const order = await this.ordersService.create(dto, idempotencyKey);
    return withMessage(order, 'Order placed successfully and fired to kitchen');
  }

  /** Staff live orders listing with filters & pagination */
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  async findAll(
    @Query('restaurantSlug') restaurantSlug?: string,
    @Query('status') status?: string,
    @Query('paymentStatus') paymentStatus?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const orders = await this.ordersService.findAll(restaurantSlug, {
      status,
      paymentStatus,
      startDate,
      endDate,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return withMessage(orders, 'Orders retrieved successfully');
  }

  /** Single order lookup (open for diner live tracking and staff) */
  @Get(':id')
  async findOne(@Param('id') id: string) {
    const order = await this.ordersService.findOne(id);
    return withMessage(order, 'Order retrieved successfully');
  }

  /** Diner feedback submission */
  @Post(':id/feedback')
  async submitFeedback(
    @Param('id') id: string,
    @Body() dto: { rating: number; tags?: string[]; comment?: string },
  ) {
    const updated = await this.ordersService.submitFeedback(id, dto);
    return withMessage(updated, 'Customer feedback recorded successfully');
  }

  /** KDS & Live status advance: Allowed for Chefs, Managers, Owners */
  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER, StaffRole.CHEF)
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    const updated = await this.ordersService.updateStatus(id, dto.status);
    return withMessage(updated, `Order status advanced to ${dto.status}`);
  }

  /** Settle counter payment: Allowed for Cashiers, Stewards, Managers, Owners */
  @Patch(':id/mark-paid')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER, StaffRole.STEWARD)
  async markPaid(@Param('id') id: string) {
    const updated = await this.ordersService.markPaid(id);
    return withMessage(updated, 'Order marked as paid');
  }
}
