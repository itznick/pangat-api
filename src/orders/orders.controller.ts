import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Headers,
  Req,
  UseGuards,
} from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto.js';
import { RegressOrderStatusDto } from './dto/regress-order-status.dto.js';
import { CancelOrderDto } from './dto/cancel-order.dto.js';
import { EditOrderItemsDto } from './dto/edit-order-items.dto.js';
import { ProcessRefundDto } from './dto/process-refund.dto.js';
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

  /** Single order lookup (open for diner live tracking with token and staff with JWT) */
  @Get(':id')
  async findOne(
    @Param('id') id: string,
    @Query('token') token?: string,
    @Req() req?: any,
  ) {
    const order = await this.ordersService.findOrderForCaller(id, token, req?.user);
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

  /** KDS & Live status advance: Allowed for Chefs, Stewards, Managers, Owners */
  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER, StaffRole.CHEF, StaffRole.STEWARD)
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @Req() req: any,
  ) {
    const updated = await this.ordersService.updateStatus(id, dto.status, req?.user?.restaurantId, req?.user);
    return withMessage(updated, `Order status advanced to ${dto.status}`);
  }

  /** KDS ticket regression: Chefs, Managers, Owners returning ticket to earlier stage with reason */
  @Patch(':id/regress-status')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER, StaffRole.CHEF)
  async regressStatus(
    @Param('id') id: string,
    @Body() dto: RegressOrderStatusDto,
    @Req() req: any,
  ) {
    const updated = await this.ordersService.regressStatus(id, dto, req?.user?.restaurantId, req?.user);
    return withMessage(updated, `Order returned to ${dto.targetStatus}`);
  }

  /** Order cancellation with mandatory reason */
  @Post(':id/cancel')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER, StaffRole.STEWARD)
  async cancel(
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
    @Req() req: any,
  ) {
    const updated = await this.ordersService.cancelOrder(id, dto, req?.user?.restaurantId, req?.user);
    return withMessage(updated, 'Order cancelled successfully');
  }

  /** Order item editing (Option A: Allowed strictly while order is in RECEIVED stage) */
  @Patch(':id/items')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER, StaffRole.STEWARD)
  async editItems(
    @Param('id') id: string,
    @Body() dto: EditOrderItemsDto,
    @Req() req: any,
  ) {
    const updated = await this.ordersService.editItems(id, dto, req?.user?.restaurantId, req?.user);
    return withMessage(updated, 'Order items and pricing updated successfully');
  }

  /** Settle counter payment: Allowed for Cashiers, Stewards, Managers, Owners */
  @Patch(':id/mark-paid')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER, StaffRole.STEWARD)
  async markPaid(@Param('id') id: string, @Req() req: any) {
    const updated = await this.ordersService.markPaid(id, req?.user?.restaurantId);
    return withMessage(updated, 'Order marked as paid');
  }

  /** Process counter cash refund or verified provider refund: Manager/Owner only */
  @Post(':id/refund')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async processRefund(
    @Param('id') id: string,
    @Body() dto: ProcessRefundDto,
    @Req() req: any,
  ) {
    const updated = await this.ordersService.processRefund(id, dto, req?.user?.restaurantId, req?.user);
    return withMessage(updated, 'Refund processed successfully');
  }
}
