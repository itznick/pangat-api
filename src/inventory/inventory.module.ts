// ─────────────────────────────────────────────────────────────────────────────
// src/inventory/inventory.module.ts
// ─────────────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Ingredient } from './entities/ingredient.entity.js';
import { StockMovement } from './entities/stock-movement.entity.js';
import { Recipe } from './entities/recipe.entity.js';
import { RecipeIngredient } from './entities/recipe-ingredient.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { MenuItem } from '../menu/entities/menu-item.entity.js';
import { AuditModule } from '../audit/audit.module.js';
import { InventoryService } from './inventory.service.js';
import { InventoryController } from './inventory.controller.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Ingredient,
      StockMovement,
      Recipe,
      RecipeIngredient,
      Restaurant,
      MenuItem,
    ]),
    AuditModule,
  ],
  controllers: [InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
