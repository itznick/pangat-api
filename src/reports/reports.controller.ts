import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { FeatureGuard, RequireFeature } from '../common/guards/feature.guard.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { StaffRole } from '../common/enums/index.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';
import { ReportsService } from './reports.service.js';
import { DataSource } from 'typeorm';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { NotFoundException } from '@nestjs/common';

@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard, TenantGuard, FeatureGuard)
@RequireFeature('ANALYTICS')
export class ReportsController {
  constructor(
    private readonly reports: ReportsService,
    private readonly dataSource: DataSource,
  ) {}

  /** Sales summary for one outlet (TenantGuard has already verified access to `restaurantSlug`). */
  @Get('summary')
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async summary(
    @Query('restaurantSlug') restaurantSlug: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const outlet = await this.dataSource.getRepository(Restaurant).findOne({ where: { slug: String(restaurantSlug || '').trim().toLowerCase() } });
    if (!outlet) throw new NotFoundException('Restaurant not found');
    return withMessage(await this.reports.summary(outlet.id, { from, to }), 'Report generated');
  }
}
