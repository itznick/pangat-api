// ─────────────────────────────────────────────────────────────────────────────
// src/inventory/inventory.controller.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { InventoryService } from './inventory.service.js';
import { CreateIngredientDto } from './dto/create-ingredient.dto.js';
import { UpdateIngredientDto } from './dto/update-ingredient.dto.js';
import { AdjustStockDto } from './dto/adjust-stock.dto.js';
import { ReceiveStockDto } from './dto/receive-stock.dto.js';
import { StockMovementQueryDto } from './dto/stock-movement-query.dto.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../common/guards/roles.guard.js';
import { TenantGuard } from '../common/guards/tenant.guard.js';
import { Roles } from '../common/decorators/roles.decorator.js';
import { StaffRole } from '../common/enums/index.js';
import { withMessage } from '../common/interceptors/response.interceptor.js';

@Controller('inventory')
@UseGuards(JwtAuthGuard, RolesGuard, TenantGuard)
export class InventoryController {
  constructor(private readonly inventoryService: InventoryService) {}

  /**
   * List all ingredients for the authorized outlet.
   */
  @Get('ingredients')
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER, StaffRole.CHEF, StaffRole.STEWARD)
  async findAllIngredients(
    @Query('restaurantId') restaurantId: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    const isOnlyActive = activeOnly === 'true' || activeOnly === '1';
    const ingredients = await this.inventoryService.findAllIngredients(restaurantId, isOnlyActive);
    return withMessage(ingredients, 'Ingredients retrieved successfully');
  }

  /**
   * Create an ingredient with initial opening stock.
   */
  @Post('ingredients')
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async createIngredient(
    @Body() dto: CreateIngredientDto,
    @Req() req: any,
    @Headers('x-idempotency-key') idempotencyKey?: string,
  ) {
    const ingredient = await this.inventoryService.createIngredient(
      dto.restaurantId,
      dto,
      req?.user,
      idempotencyKey,
    );
    return withMessage(ingredient, `Ingredient '${ingredient.name}' created successfully`);
  }

  /**
   * View ingredient details.
   */
  @Get('ingredients/:id')
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER, StaffRole.CHEF)
  async findIngredient(
    @Param('id') id: string,
    @Query('restaurantId') restaurantId?: string,
  ) {
    const ingredient = await this.inventoryService.findIngredientById(id, restaurantId);
    return withMessage(ingredient, 'Ingredient retrieved successfully');
  }

  /**
   * Update ingredient metadata (reorder thresholds, unit, cost).
   */
  @Patch('ingredients/:id')
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async updateIngredient(
    @Param('id') id: string,
    @Query('restaurantId') restaurantId: string,
    @Body() dto: UpdateIngredientDto,
    @Req() req: any,
  ) {
    const ingredient = await this.inventoryService.updateIngredient(id, restaurantId, dto, req?.user);
    return withMessage(ingredient, `Ingredient '${ingredient.name}' updated successfully`);
  }

  /**
   * Manual stock adjustment with mandatory audit reason.
   */
  @Post('ingredients/:id/adjust')
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async adjustStock(
    @Param('id') id: string,
    @Query('restaurantId') restaurantId: string,
    @Body() dto: AdjustStockDto,
    @Req() req: any,
    @Headers('x-idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.inventoryService.adjustStock(
      id,
      restaurantId,
      dto,
      req?.user,
      idempotencyKey,
    );
    return withMessage(result, 'Stock adjusted and movement recorded successfully');
  }

  /**
   * Batch receive stock from supplier delivery invoice.
   */
  @Post('receive')
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER)
  async receiveStock(
    @Body() dto: ReceiveStockDto,
    @Req() req: any,
    @Headers('x-idempotency-key') idempotencyKey?: string,
  ) {
    const result = await this.inventoryService.receiveStock(
      dto.restaurantId,
      dto,
      req?.user,
      idempotencyKey,
    );
    return withMessage(result, `Received ${result.receivedMovements.length} items into inventory`);
  }

  /**
   * Audited stock movements ledger.
   */
  @Get('movements')
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER, StaffRole.CHEF)
  async findMovements(
    @Query('restaurantId') restaurantId: string,
    @Query() query: StockMovementQueryDto,
  ) {
    const movements = await this.inventoryService.findStockMovements(restaurantId, query);
    return withMessage(movements, 'Stock movements retrieved successfully');
  }

  /**
   * Active low-stock and out-of-stock warnings.
   */
  @Get('alerts')
  @Roles(StaffRole.SUPER_OWNER, StaffRole.STORE_MANAGER, StaffRole.CHEF)
  async getAlerts(@Query('restaurantId') restaurantId: string) {
    const alerts = await this.inventoryService.getLowStockAlerts(restaurantId);
    return withMessage(alerts, 'Inventory alerts retrieved successfully');
  }
}
