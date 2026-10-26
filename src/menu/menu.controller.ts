import { Controller, Get, Post, Patch, Delete, Param, Body, Query } from '@nestjs/common';
import { MenuService } from './menu.service.js';
import { UpdateAvailabilityDto } from './dto/update-availability.dto.js';
import { UpdatePriceDto } from './dto/update-price.dto.js';
import { CreateItemDto, UpdateItemDto } from './dto/create-item.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
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
      `Item marked as ${dto.isAvailable ? 'available' : 'sold out (out of stock)'}`,
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

  @Post('items')
  async createItem(@Body() dto: CreateItemDto) {
    const item = await this.menuService.createItem(dto);
    return withMessage(item, 'Menu dish created successfully');
  }

  @Patch('items/:id')
  async updateItem(
    @Param('id') id: string,
    @Body() dto: UpdateItemDto,
  ) {
    const updated = await this.menuService.updateItem(id, dto);
    return withMessage(updated, 'Menu item updated successfully');
  }

  @Post('categories')
  async createCategory(@Body() dto: CreateCategoryDto) {
    const created = await this.menuService.createCategory(dto);
    return withMessage(created, `Category '${created.name}' created successfully`);
  }

  @Delete('categories/:id')
  async removeCategory(@Param('id') id: string) {
    await this.menuService.removeCategory(id);
    return withMessage({ id }, 'Category deleted successfully');
  }
}
