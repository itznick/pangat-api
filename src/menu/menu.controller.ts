import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { MenuService } from './menu.service.js';
import { UpdateAvailabilityDto } from './dto/update-availability.dto.js';
import { UpdatePriceDto } from './dto/update-price.dto.js';
import { CreateItemDto, UpdateItemDto } from './dto/create-item.dto.js';
import { CreateCategoryDto } from './dto/create-category.dto.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { StaffRole } from '../common/enums/index.js';

@Controller('menu')
export class MenuController {
  constructor(private readonly menuService: MenuService) {}

  /** Public endpoint for diners scanning QR codes */
  @Get('public/:restaurantSlug')
  async getPublicMenu(@Param('restaurantSlug') restaurantSlug: string) {
    const data = await this.menuService.getPublicMenu(restaurantSlug);
    return withMessage(data, 'Public menu retrieved successfully');
  }

  /** Staff & Diner items list */
  @Get('items')
  async getAllItems(@Query('restaurantId') restaurantId?: string) {
    const items = await this.menuService.getAllItems(restaurantId);
    return withMessage(items, 'Menu items retrieved successfully');
  }

  /** Mark item available or out of stock: Allowed for Chefs, Managers, Owners */
  @Patch('items/:id/availability')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER, StaffRole.CHEF)
  async updateAvailability(
    @Param('id') id: string,
    @Body() dto: UpdateAvailabilityDto,
    @Req() req: any,
  ) {
    const updated = await this.menuService.updateAvailability(id, dto.isAvailable, req?.user?.restaurantId);
    return withMessage(
      updated,
      `Item marked as ${dto.isAvailable ? 'available' : 'sold out (out of stock)'}`,
    );
  }

  /** Update price: Allowed for Owners and Managers only */
  @Patch('items/:id/price')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async updatePrice(
    @Param('id') id: string,
    @Body() dto: UpdatePriceDto,
    @Req() req: any,
  ) {
    const updated = await this.menuService.updatePrice(id, dto.price, req?.user?.restaurantId);
    return withMessage(updated, `Item price updated to ₹${dto.price}`);
  }

  /** Create menu item: Allowed for Owners and Managers */
  @Post('items')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async createItem(@Body() dto: CreateItemDto) {
    const item = await this.menuService.createItem(dto);
    return withMessage(item, 'Menu dish created successfully');
  }

  /** Update menu item: Allowed for Owners and Managers */
  @Patch('items/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async updateItem(
    @Param('id') id: string,
    @Body() dto: UpdateItemDto,
    @Req() req: any,
  ) {
    const updated = await this.menuService.updateItem(id, dto, req?.user?.restaurantId);
    return withMessage(updated, 'Menu item updated successfully');
  }

  /** Create category: Allowed for Owners and Managers */
  @Post('categories')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async createCategory(@Body() dto: CreateCategoryDto) {
    const created = await this.menuService.createCategory(dto);
    return withMessage(created, `Category '${created.name}' created successfully`);
  }

  /** Remove category: Allowed for Owners and Managers */
  @Delete('categories/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async removeCategory(@Param('id') id: string, @Req() req: any) {
    await this.menuService.removeCategory(id, req?.user?.restaurantId);
    return withMessage({ id }, 'Category deleted successfully');
  }
}
