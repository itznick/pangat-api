import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { RestaurantsService } from './restaurants.service.js';
import { UpdateSettingsDto } from './dto/update-settings.dto.js';
import { CreateStaffDto } from './dto/create-staff.dto.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { StaffRole } from '../common/enums/index.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';

@Controller('restaurants')
export class RestaurantsController {
  constructor(private readonly restaurantsService: RestaurantsService) {}

  @Get(':slug')
  async getBySlug(@Param('slug') slug: string) {
    const restaurant = await this.restaurantsService.findBySlug(slug);
    return withMessage(restaurant, 'Restaurant details retrieved successfully');
  }

  @Get(':slug/feedback')
  async getFeedback(@Param('slug') slug: string) {
    const feedback = await this.restaurantsService.getFeedback(slug);
    return withMessage(feedback, 'Customer ratings and feedback retrieved successfully');
  }

  @Post(':slug/feedback')
  async submitFeedback(
    @Param('slug') slug: string,
    @Body() dto: { orderId?: string; tableNumber?: string; rating: number; tags?: string[]; comment?: string },
  ) {
    const result = await this.restaurantsService.submitFeedback(slug, dto);
    return withMessage(result, 'Customer review recorded successfully');
  }

  @Patch(':slug/settings')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async updateSettings(
    @Param('slug') slug: string,
    @Body() dto: UpdateSettingsDto,
  ) {
    const updated = await this.restaurantsService.updateSettings(slug, dto);
    return withMessage(updated, 'Restaurant settings updated successfully');
  }

  @Post(':id/staff')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER)
  async createStaff(
    @Param('id') id: string,
    @Body() dto: CreateStaffDto,
  ) {
    const staff = await this.restaurantsService.createStaff(id, dto);
    return withMessage(staff, 'Staff member added to outlet successfully');
  }
}
