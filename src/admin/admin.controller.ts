import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { PlatformAdminGuard } from './guards/platform-admin.guard.js';
import { AdminService } from './admin.service.js';
import { ProvisionRestaurantDto } from './dto/provision-restaurant.dto.js';
import { UpdateLeadDto } from '../leads/dto/update-lead.dto.js';

@Controller('admin')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('metrics')
  async getMetrics() {
    return this.adminService.getMetrics();
  }

  @Get('leads')
  async getLeads() {
    return this.adminService.getLeads();
  }

  @Patch('leads/:id')
  async updateLead(
    @Param('id') id: string,
    @Body() updateLeadDto: UpdateLeadDto,
  ) {
    return this.adminService.updateLead(id, updateLeadDto);
  }

  @Post('provision')
  async provisionRestaurant(@Body() dto: ProvisionRestaurantDto) {
    return this.adminService.provisionRestaurant(dto);
  }

  @Get('organizations')
  async getOrganizations() {
    return this.adminService.getOrganizations();
  }

  @Post('organizations/:id/reset-password')
  async resetOrganizationPassword(@Param('id') id: string) {
    return this.adminService.resetOrganizationPassword(id);
  }

  @Get('outlets')
  async getOutlets() {
    return this.adminService.getOutlets();
  }

  @Get('system-health')
  async getSystemHealth() {
    return this.adminService.getSystemHealth();
  }
}
