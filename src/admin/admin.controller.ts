import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PlatformAdminGuard, RequirePermission } from '../platform/guards.js';
import { actorOf, PlatformAuditService } from '../platform/audit.service.js';
import { PlatformEventsService } from '../platform/events.service.js';
import { AdminService } from './admin.service.js';
import { ProvisionRestaurantDto } from './dto/provision-restaurant.dto.js';
import { UpdateLeadDto } from '../leads/dto/update-lead.dto.js';

/** Original platform operations endpoints, now permission-checked per route and written to the platform audit log. */
@Controller('admin')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly audit: PlatformAuditService,
    private readonly events: PlatformEventsService,
  ) {}

  @Get('metrics')
  @RequirePermission('dashboard.view')
  async getMetrics() {
    return this.adminService.getMetrics();
  }

  @Get('leads')
  @RequirePermission('leads.manage')
  async getLeads() {
    return this.adminService.getLeads();
  }

  @Patch('leads/:id')
  @RequirePermission('leads.manage')
  async updateLead(@Param('id') id: string, @Body() updateLeadDto: UpdateLeadDto, @Req() req: any) {
    const lead = await this.adminService.updateLead(id, updateLeadDto);
    await this.audit.record(actorOf(req), {
      action: 'LEAD_UPDATED', category: 'RESTAURANT', entityType: 'lead', entityId: id, entityLabel: lead.restaurantName,
      summary: `Updated lead ${lead.restaurantName}${updateLeadDto.status ? ` → ${updateLeadDto.status}` : ''}`, changes: updateLeadDto,
    });
    return lead;
  }

  @Post('provision')
  @RequirePermission('restaurants.provision')
  async provisionRestaurant(@Body() dto: ProvisionRestaurantDto, @Req() req: any) {
    const result: any = await this.adminService.provisionRestaurant(dto, req.user);
    await this.audit.record(actorOf(req), {
      action: 'RESTAURANT_PROVISIONED', category: 'RESTAURANT', entityType: 'organization', entityId: result.organization.id, entityLabel: result.organization.name,
      organizationId: result.organization.id, summary: `Provisioned ${result.organization.name} (${result.outlet.slug})`,
    });
    await this.events.emit('NEW_RESTAURANT', 'INFO', `New restaurant: ${result.organization.name}`, 'Provisioned by a platform admin', { organizationId: result.organization.id, actorName: req.user?.name });
    return result;
  }

  @Get('organizations')
  @RequirePermission('restaurants.view')
  async getOrganizations() {
    return this.adminService.getOrganizations();
  }

  @Post('organizations/:id/reset-password')
  @HttpCode(201)
  @RequirePermission('users.manage')
  async resetOrganizationPassword(@Param('id') id: string, @Req() req: any) {
    const result: any = await this.adminService.resetOrganizationPassword(id);
    await this.audit.record(actorOf(req), {
      action: 'OWNER_PASSWORD_RESET_LINK_SENT', category: 'SECURITY', entityType: 'organization', entityId: id, entityLabel: result.organizationName, organizationId: id,
      summary: `Emailed a password reset link to the owner of ${result.organizationName}`,
    });
    return result;
  }

  @Get('outlets')
  @RequirePermission('restaurants.view')
  async getOutlets() {
    return this.adminService.getOutlets();
  }

  @Get('system-health')
  @RequirePermission('monitoring.view')
  async getSystemHealth() {
    return this.adminService.getSystemHealth();
  }
}
