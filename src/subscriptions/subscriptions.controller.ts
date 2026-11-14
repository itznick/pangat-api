// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/subscriptions.controller.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  Body,
  Controller,
  HttpCode,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { SubscriptionsService } from './subscriptions.service.js';
import { CreatePlanDto } from './dto/create-plan.dto.js';
import { UpdatePlanDto } from './dto/update-plan.dto.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { StaffRole } from '../common/enums/index.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';

export class RequestPlanChangeDto {
  @IsString()
  @IsNotEmpty()
  planCode: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}

export class AssignPlanDto {
  @IsOptional()
  @IsString()
  planId?: string;

  @IsOptional()
  @IsString()
  planCode?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(36)
  months: number;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

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
    @Req() req: any,
  ) {
    // Signature must be checked against the exact bytes received, not a re-serialised copy
    const rawBody: string = req?.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(payload);
    const result = await this.subscriptionsService.handleRazorpayWebhook(
      rawBody,
      signature || '',
      payload,
    );
    return withMessage(result, 'Webhook processed successfully');
  }

  // ── Owner self-service ────────────────────────────────────────────────────
  @Post('cancel')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.SUPER_OWNER)
  @HttpCode(200)
  async cancel(@Req() req: any) {
    const sub = await this.subscriptionsService.setCancelAtPeriodEnd(req.user.organizationId, true, req.user);
    return withMessage(sub, 'Renewal turned off. You keep access until the end of the paid period.');
  }

  @Post('resume')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.SUPER_OWNER)
  @HttpCode(200)
  async resume(@Req() req: any) {
    const sub = await this.subscriptionsService.setCancelAtPeriodEnd(req.user.organizationId, false, req.user);
    return withMessage(sub, 'Great, your plan will keep renewing.');
  }

  @Post('request-change')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.SUPER_OWNER)
  @HttpCode(200)
  async requestChange(@Req() req: any, @Body() dto: RequestPlanChangeDto) {
    const r = await this.subscriptionsService.requestPlanChange(req.user.organizationId, dto.planCode, dto.message, req.user);
    return withMessage(r, 'Request sent. The Pangat team will contact you shortly.');
  }

  // ── Super Admin Plan Management ──────────────────────────────────────────

  @Get('admin/organizations/:orgId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.PLATFORM_SUPER_ADMIN)
  async adminOrgSubscription(@Param('orgId') orgId: string) {
    const [data, audit] = await Promise.all([
      this.subscriptionsService.getOrganizationSubscription(orgId),
      this.subscriptionsService.listAuditForOrganization(orgId),
    ]);
    return withMessage({ ...data, audit }, 'Organization subscription retrieved');
  }

  @Post('admin/organizations/:orgId/assign')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(StaffRole.PLATFORM_SUPER_ADMIN)
  @HttpCode(200)
  async adminAssign(@Param('orgId') orgId: string, @Body() dto: AssignPlanDto, @Req() req: any) {
    const sub = await this.subscriptionsService.adminAssignPlan(orgId, dto, req.user);
    return withMessage(sub, 'Plan assigned successfully');
  }

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
