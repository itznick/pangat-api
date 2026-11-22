import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';
import { PlatformAdminGuard, RequirePermission } from '../platform/guards.js';
import { actorOf } from '../platform/audit.service.js';
import { clientMeta } from '../platform/login-events.js';
import { PrivacyService } from './privacy.service.js';
import { CreatePrivacyRequestDto, PhoneDto, UpdatePrivacyRequestDto } from './privacy.dto.js';

/** Anyone (a diner, a restaurant visitor) can ask about their own data. No sign-in is needed. */
@Controller('privacy')
export class PrivacyPublicController {
  constructor(private readonly privacy: PrivacyService) {}

  @Post('requests')
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(201)
  async create(@Body() dto: CreatePrivacyRequestDto, @Req() req: any) {
    return withMessage(await this.privacy.create(dto, clientMeta(req)), 'Your request was received');
  }
}

/** The grievance officer's workspace (Super Admin → Privacy requests). */
@Controller('admin/privacy')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class PrivacyAdminController {
  constructor(private readonly privacy: PrivacyService) {}

  @Get('requests') @RequirePermission('privacy.view')
  async list(@Query() q: { status?: string; kind?: string; page?: string; limit?: string }) {
    return withMessage(await this.privacy.list({ ...q, page: Number(q.page) || 1, limit: Number(q.limit) || 25 }), 'Privacy requests');
  }

  @Get('requests/:id') @RequirePermission('privacy.view')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    return withMessage(await this.privacy.get(id), 'Privacy request');
  }

  @Patch('requests/:id') @RequirePermission('privacy.manage')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePrivacyRequestDto, @Req() req: any) {
    return withMessage(await this.privacy.update(id, dto, actorOf(req)), 'Privacy request updated');
  }

  @Post('lookup') @HttpCode(200) @RequirePermission('privacy.manage')
  async lookup(@Body() dto: PhoneDto, @Req() req: any) {
    return withMessage(await this.privacy.lookup(dto.phone, actorOf(req)), 'Data held for this phone number');
  }

  @Post('erase') @HttpCode(200) @RequirePermission('privacy.manage')
  async erase(@Body() dto: PhoneDto & { requestReference?: string }, @Req() req: any) {
    return withMessage(await this.privacy.anonymise(dto.phone, actorOf(req), dto.requestReference), 'Personal details erased');
  }
}
