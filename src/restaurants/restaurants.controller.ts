import { Controller, Get, Patch, Param, Body, UseGuards } from '@nestjs/common';
import { RestaurantsService } from './restaurants.service.js';
import { UpdateSettingsDto } from './dto/update-settings.dto.js';
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

  @UseGuards(JwtAuthGuard)
  @Patch(':slug/settings')
  async updateSettings(
    @Param('slug') slug: string,
    @Body() dto: UpdateSettingsDto,
  ) {
    const updated = await this.restaurantsService.updateSettings(slug, dto);
    return withMessage(updated, 'Restaurant settings updated successfully');
  }
}
