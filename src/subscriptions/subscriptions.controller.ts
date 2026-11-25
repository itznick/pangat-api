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
import { PlatformAdminGuard, RequirePermission } from '../platform/guards.js';
import { actorOf, PlatformAuditService } from '../platform/audit.service.js';

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
  constructor(
    private readonly subscriptionsService: SubscriptionsService,
    private readonly platformAudit: PlatformAuditService,
  ) {}

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

  // ── Super Admin Plan Management (permission-checked on the server) ───────
  @Get('admin/organizations/:orgId')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  @RequirePermission('subscriptions.view')
  async adminOrgSubscription(@Param('orgId') orgId: string) {
    const [data, audit] = await Promise.all([
      this.subscriptionsService.getOrganizationSubscription(orgId),
      this.subscriptionsService.listAuditForOrganization(orgId),
    ]);
    return withMessage({ ...data, audit }, 'Organization subscription retrieved');
  }

  /** Kept for existing clients; the console uses /admin/restaurants/:id/subscription/assign (reason required). */
  @Post('admin/organizations/:orgId/assign')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  @RequirePermission('subscriptions.manage')
  @HttpCode(200)
  async adminAssign(@Param('orgId') orgId: string, @Body() dto: AssignPlanDto, @Req() req: any) {
    const sub = await this.subscriptionsService.adminAssignPlan(orgId, dto, req.user);
    await this.platformAudit.record(actorOf(req), {
      action: 'SUBSCRIPTION_ASSIGNED', category: 'SUBSCRIPTION', entityType: 'organization', entityId: orgId, organizationId: orgId,
      summary: `Granted plan ${dto.planCode || dto.planId} for ${dto.months} month(s) (manual grant, no payment recorded)`, reason: dto.note ?? null,
    });
    return withMessage(sub, 'Plan assigned successfully');
  }

  @Get('admin/plans')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  @RequirePermission('subscriptions.view')
  async listAllPlansForAdmin() {
    const plans = await this.subscriptionsService.findAllPlans(true);
    return withMessage(plans, 'All plans retrieved successfully');
  }

  @Post('admin/plans')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  @RequirePermission('plans.manage')
  async createPlan(@Body() dto: CreatePlanDto, @Req() req: any) {
    const plan = await this.subscriptionsService.createPlan(dto);
    await this.platformAudit.record(actorOf(req), {
      action: 'PLAN_CREATED', category: 'PLAN', entityType: 'plan', entityId: plan.id, entityLabel: plan.code,
      summary: `Created plan ${plan.code} (${plan.name}) at ₹${plan.basePrice}/${String(plan.billingInterval).toLowerCase()}`, changes: dto,
    });
    return withMessage(plan, `Plan '${plan.name}' created successfully`);
  }

  @Patch('admin/plans/:id')
  @UseGuards(JwtAuthGuard, PlatformAdminGuard)
  @RequirePermission('plans.manage')
  async updatePlan(@Param('id') id: string, @Body() dto: UpdatePlanDto, @Req() req: any) {
    const before = await this.subscriptionsService.findPlanById(id);
    const prev: Record<string, unknown> = {};
    for (const k of Object.keys(dto)) prev[k] = (before as any)[k];
    const plan = await this.subscriptionsService.updatePlan(id, dto);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of Object.keys(dto)) {
      const a = JSON.stringify(prev[k]);
      const b = JSON.stringify((plan as any)[k]);
      if (a !== b) changes[k] = { from: prev[k], to: (plan as any)[k] };
    }
    await this.platformAudit.record(actorOf(req), {
      action: dto.isActive === false ? 'PLAN_RETIRED' : 'PLAN_UPDATED', category: 'PLAN', entityType: 'plan', entityId: plan.id, entityLabel: plan.code,
      summary: `Updated plan ${plan.code}: ${Object.keys(changes).join(', ') || 'no field changes'}`, changes,
    });
    // Lowering a limit never deletes anything: report who is now over it so the operator can act (they cannot add more until within limits)
    const limitsTouched = ['maxOutlets', 'maxTablesPerOutlet', 'maxStaffPerOutlet'].some((k) => k in changes);
    const overLimit = limitsTouched ? await this.subscriptionsService.organisationsOverPlanLimits(plan.id) : [];
    return withMessage({ ...plan, overLimitOrganisations: overLimit }, `Plan '${plan.name}' updated successfully`);
  }
}
