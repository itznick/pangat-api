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

  @UseGuards(JwtAuthGuard)
  @Patch(':slug/settings')
  async updateSettings(
    @Param('slug') slug: string,
    @Body() dto: UpdateSettingsDto,
  ) {
    const updated = await this.restaurantsService.updateSettings(slug, dto);
    return withMessage(updated, 'Restaurant settings updated successfully');
  }

  @UseGuards(JwtAuthGuard)
  @Post(':id/staff')
  async createStaff(
    @Param('id') id: string,
    @Body() dto: CreateStaffDto,
  ) {
    const staff = await this.restaurantsService.createStaff(id, dto);
    return withMessage(staff, 'Staff member added to outlet successfully');
  }
}
