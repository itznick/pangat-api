// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/subscriptions.controller.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service.js';
import { CreatePlanDto } from './dto/create-plan.dto.js';
import { UpdatePlanDto } from './dto/update-plan.dto.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { StaffRole } from '../common/enums/index.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';

@Controller('subscriptions')
export class SubscriptionsController {
  constructor(private readonly subscriptionsService: SubscriptionsService) {}

  /**
   * Public list of available subscription plans with GST breakdown.
   */
  @Get('plans')
  async findAllPlans() {
    const plans = await this.subscriptionsService.findAllPlans(false);
    return withMessage(plans, 'Subscription plans retrieved successfully');
  }

  /**
   * Current organization's subscription status, active plan, and tax invoices.
   */
  @Get('my-subscription')
  @UseGuards(JwtAuthGuard)
  async getMySubscription(@Req() req: any) {
    const orgId = req.user?.organizationId;
    if (!orgId) {
      return withMessage(null, 'User does not belong to an organization');
    }
    const data = await this.subscriptionsService.getOrganizationSubscription(orgId);
    return withMessage(data, 'Organization subscription retrieved successfully');
  }

  /**
   * Razorpay Webhook receiver with verified HMAC-SHA256 signature and idempotency.
   */
  @Post('webhook/razorpay')
  async handleRazorpayWebhook(
    @Body() payload: any,
    @Headers('x-razorpay-signature') signature: string,
  ) {
    const rawBody = JSON.stringify(payload);
    const result = await this.subscriptionsService.handleRazorpayWebhook(
      rawBody,
      signature || '',
      payload,
    );
    return withMessage(result, 'Webhook processed successfully');
  }

  // ── Super Admin Plan Management ──────────────────────────────────────────

  @Get('admin/plans')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.PLATFORM_SUPER_ADMIN)
  async listAllPlansForAdmin() {
    const plans = await this.subscriptionsService.findAllPlans(true);
    return withMessage(plans, 'All plans retrieved successfully');
  }

  @Post('admin/plans')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.PLATFORM_SUPER_ADMIN)
  async createPlan(@Body() dto: CreatePlanDto) {
    const plan = await this.subscriptionsService.createPlan(dto);
    return withMessage(plan, `Plan '${plan.name}' created successfully`);
  }

  @Patch('admin/plans/:id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.PLATFORM_SUPER_ADMIN)
  async updatePlan(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    const plan = await this.subscriptionsService.updatePlan(id, dto);
    return withMessage(plan, `Plan '${plan.name}' updated successfully`);
  }
}
