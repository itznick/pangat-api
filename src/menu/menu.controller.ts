import { Controller, Get, Patch, Param, Body, Query } from '@nestjs/common';
import { MenuService } from './menu.service.js';
import { UpdateAvailabilityDto } from './dto/update-availability.dto.js';
import { UpdatePriceDto } from './dto/update-price.dto.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';

@Controller('menu')
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  @Get('public/:restaurantSlug')
  async getPublicMenu(@Param('restaurantSlug') restaurantSlug: string) {
    const data = await this.menuService.getPublicMenu(restaurantSlug);
    return withMessage(data, 'Public menu retrieved successfully');
  }

  @Get('items')
  async getAllItems(@Query('restaurantId') restaurantId?: string) {
    const items = await this.menuService.getAllItems(restaurantId);
    return withMessage(items, 'Menu items retrieved successfully');
  }

  @Patch('items/:id/availability')
  async updateAvailability(
    @Param('id') id: string,
    @Body() dto: UpdateAvailabilityDto,
  ) {
    const updated = await this.menuService.updateAvailability(id, dto.isAvailable);
    return withMessage(
      updated,
      `Item marked as ${dto.isAvailable ? 'available' : 'sold out (86)'}`,
    );
  }

  @Patch('items/:id/price')
  async updatePrice(
    @Param('id') id: string,
    @Body() dto: UpdatePriceDto,
  ) {
    const updated = await this.menuService.updatePrice(id, dto.price);
    return withMessage(updated, `Item price updated to ₹${dto.price}`);
  }
}
