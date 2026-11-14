import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  UseGuards,
  Req,
  BadRequestException,
  Delete,
  Query,
} from '@nestjs/common';
import { RestaurantsService } from './restaurants.service.js';
import { UpdateSettingsDto } from './dto/update-settings.dto.js';
import { CreateStaffDto, UpdateStaffDto, SetKitchenPinDto } from './dto/create-staff.dto.js';
import { Throttle } from '@nestjs/throttler';
import { OptionalJwtAuthGuard } from '../auth/optional-jwt-auth.guard.js';
import { OrdersService } from '../orders/orders.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { StaffRole } from '../common/enums/index.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';

@Controller('restaurants')
export class RestaurantsController {
  constructor(
    private readonly restaurantsService: RestaurantsService,
    private readonly ordersService: OrdersService,
  ) {}

  /** Public diner view of an outlet; staff of that outlet (valid JWT) get the full settings record. */
  @Get(':slug')
  @UseGuards(OptionalJwtAuthGuard)
  async getBySlug(@Param('slug') slug: string, @Req() req: any) {
    const restaurant = await this.restaurantsService.findBySlug(slug);
    const full = await this.restaurantsService.canSeeFull(req?.user, restaurant);
    return withMessage(
      full ? restaurant : this.restaurantsService.toPublic(restaurant),
      'Restaurant details retrieved successfully',
    );
  }

  /** Reviews contain customer comments: staff of the outlet only. */
  @Get(':slug/feedback')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async getFeedback(@Param('slug') slug: string) {
    const feedback = await this.restaurantsService.getFeedback(slug);
    return withMessage(feedback, 'Customer ratings and feedback retrieved successfully');
  }

  /** Diner review. Requires the order's private tracking token, so only the real customer can review. */
  @Post(':slug/feedback')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async submitFeedback(
    @Param('slug') slug: string,
    @Body() dto: { orderId?: string; token?: string; tableNumber?: string; rating: number; tags?: string[]; comment?: string },
  ) {
    const restaurant = await this.restaurantsService.findBySlug(slug);
    if (!dto?.orderId) {
      throw new BadRequestException('orderId is required to leave a review');
    }
    const result = await this.ordersService.submitFeedback(dto.orderId, dto, dto.token, restaurant.id);
    return withMessage({ success: true, orderId: result.id, feedback: result.feedback }, 'Customer review recorded successfully');
  }

  @Patch(':slug/settings')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async updateSettings(@Param('slug') slug: string, @Body() dto: UpdateSettingsDto, @Req() req: any) {
    const updated = await this.restaurantsService.updateSettings(slug, dto, req.user);
    return withMessage(updated, 'Restaurant settings updated successfully');
  }

  // ── Staff management (outlet owners) ─────────────────────────────────────
  @Get(':id/staff')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async listStaff(@Param('id') id: string) {
    return withMessage(await this.restaurantsService.listStaff(id), 'Staff retrieved successfully');
  }

  @Post(':id/staff')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER)
  async createStaff(@Param('id') id: string, @Body() dto: CreateStaffDto, @Req() req: any) {
    const staff = await this.restaurantsService.createStaff(id, dto);
    await this.restaurantsService.audit(id, 'STAFF', staff.id, 'STAFF_CREATED', req.user, { role: staff.role, email: staff.email });
    return withMessage(staff, 'Staff member added to outlet successfully');
  }

  @Patch(':id/staff/:staffId')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER)
  async updateStaff(@Param('id') id: string, @Param('staffId') staffId: string, @Body() dto: UpdateStaffDto, @Req() req: any) {
    const staff = await this.restaurantsService.updateStaff(id, staffId, dto, req.user.id);
    await this.restaurantsService.audit(id, 'STAFF', staffId, 'STAFF_UPDATED', req.user, { changes: dto });
    return withMessage(staff, 'Staff member updated');
  }

  @Post(':id/staff/:staffId/reset-password')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER)
  async resetStaffPassword(@Param('id') id: string, @Param('staffId') staffId: string, @Req() req: any) {
    const r = await this.restaurantsService.resetStaffPassword(id, staffId);
    await this.restaurantsService.audit(id, 'STAFF', staffId, 'STAFF_PASSWORD_RESET', req.user, null);
    return withMessage(r, 'Temporary password generated. Share it securely; it is shown only once.');
  }

  // ── Kitchen station PIN ──────────────────────────────────────────────────
  @Get(':id/kitchen-pin')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async kitchenPinStatus(@Param('id') id: string) {
    return withMessage(await this.restaurantsService.kitchenPinStatus(id), 'Kitchen PIN status');
  }

  @Post(':id/kitchen-pin')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async setKitchenPin(@Param('id') id: string, @Body() dto: SetKitchenPinDto, @Req() req: any) {
    const r = await this.restaurantsService.setKitchenPin(id, dto.pin);
    await this.restaurantsService.audit(id, 'RESTAURANT', id, 'KITCHEN_PIN_CHANGED', req.user, null);
    return withMessage(r, 'Kitchen PIN saved');
  }

  // ── Audit trail ──────────────────────────────────────────────────────────
  @Get(':id/audit-logs')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async auditLogs(
    @Param('id') id: string,
    @Query('entityType') entityType?: string,
    @Query('action') action?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const r = await this.restaurantsService.auditLogs(id, { entityType, action, page: Number(page) || 1, limit: Number(limit) || 50 });
    return withMessage(r, 'Audit log retrieved');
  }
}
