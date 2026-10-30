// ─────────────────────────────────────────────────────────────────────────────
// src/inventory/inventory.service.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Ingredient } from './entities/ingredient.entity.js';
import { StockMovement } from './entities/stock-movement.entity.js';
import { Recipe } from './entities/recipe.entity.js';
import { RecipeIngredient } from './entities/recipe-ingredient.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { MenuItem } from '../menu/entities/menu-item.entity.js';
import { AuditService } from '../audit/audit.service.js';
import { CreateIngredientDto } from './dto/create-ingredient.dto.js';
import { UpdateIngredientDto } from './dto/update-ingredient.dto.js';
import { AdjustStockDto } from './dto/adjust-stock.dto.js';
import { ReceiveStockDto } from './dto/receive-stock.dto.js';
import { StockMovementQueryDto } from './dto/stock-movement-query.dto.js';
import { CreateRecipeDto } from './dto/create-recipe.dto.js';
import { AuditAction, StockMovementType } from '../common/enums/index.js';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(
    @InjectRepository(Ingredient)
    private readonly ingredientRepo: Repository<Ingredient>,
    @InjectRepository(StockMovement)
    private readonly stockMovementRepo: Repository<StockMovement>,
    @InjectRepository(Recipe)
    private readonly recipeRepo: Repository<Recipe>,
    @InjectRepository(RecipeIngredient)
    private readonly recipeIngredientRepo: Repository<RecipeIngredient>,
    @InjectRepository(Restaurant)
    private readonly restaurantRepo: Repository<Restaurant>,
    @InjectRepository(MenuItem)
    private readonly menuItemRepo: Repository<MenuItem>,
    private readonly auditService: AuditService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Create an ingredient with optional opening stock in a single transaction.
   */
  async createIngredient(
    restaurantId: string,
    dto: CreateIngredientDto,
    actor?: any,
    idempotencyKey?: string,
  ): Promise<Ingredient> {
    const restaurant = await this.restaurantRepo.findOne({ where: { id: restaurantId } });
    if (!restaurant) {
      throw new NotFoundException(`Restaurant '${restaurantId}' not found`);
    }

    const cleanName = dto.name.trim();
    const existing = await this.ingredientRepo.findOne({
      where: { restaurantId, name: cleanName },
    });
    if (existing && existing.isActive) {
      throw new ConflictException(`Ingredient '${cleanName}' already exists in this outlet`);
    }

    const openingStock = Number(dto.openingStock ?? 0);
    const minStock = Number(dto.minimumStock ?? 0);
    const cost = Number(dto.costPerUnit ?? 0);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const ingredient = queryRunner.manager.create(Ingredient, {
        restaurantId,
        name: cleanName,
        sku: dto.sku?.trim() || null,
        unit: dto.unit,
        currentStock: openingStock,
        minimumStock: minStock,
        costPerUnit: cost,
        isActive: true,
      });

      const savedIngredient = await queryRunner.manager.save(Ingredient, ingredient);

      if (openingStock > 0) {
        const movementKey = idempotencyKey || `open-${savedIngredient.id}-${Date.now()}`;
        const movement = queryRunner.manager.create(StockMovement, {
          restaurantId,
          ingredientId: savedIngredient.id,
          type: StockMovementType.OPENING_STOCK,
          quantity: openingStock,
          balanceAfter: openingStock,
          reason: 'Initial opening stock setup',
          actorStaffId: actor?.id || null,
          idempotencyKey: movementKey,
        });
        await queryRunner.manager.save(StockMovement, movement);
      }

      await queryRunner.commitTransaction();

      await this.auditService.record({
        restaurantId,
        entityType: 'Ingredient',
        entityId: savedIngredient.id,
        action: AuditAction.INGREDIENT_CREATED,
        staffId: actor?.id,
        staffName: actor?.name,
        staffRole: actor?.role,
        reason: `Ingredient '${savedIngredient.name}' created with opening stock ${openingStock} ${savedIngredient.unit}`,
        metadata: { openingStock, unit: savedIngredient.unit },
      });

      return savedIngredient;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * List ingredients for an outlet with optional active filter.
   */
  async findAllIngredients(restaurantId: string, activeOnly = false): Promise<Ingredient[]> {
    const query = this.ingredientRepo
      .createQueryBuilder('i')
      .where('i.restaurant_id = :restaurantId', { restaurantId })
      .orderBy('i.name', 'ASC');

    if (activeOnly) {
      query.andWhere('i.is_active = true');
    }

    return query.getMany();
  }

  /**
   * Retrieve single ingredient by ID with tenant check.
   */
  async findIngredientById(id: string, restaurantId?: string): Promise<Ingredient> {
    const ingredient = await this.ingredientRepo.findOne({
      where: { id },
      relations: { restaurant: true },
    });

    if (!ingredient) {
      throw new NotFoundException(`Ingredient with ID '${id}' not found`);
    }

    if (restaurantId && ingredient.restaurantId !== restaurantId) {
      throw new ForbiddenException('Access denied: Ingredient belongs to another outlet');
    }

    return ingredient;
  }

  /**
   * Update ingredient metadata (minimum stock, cost, unit, name).
   */
  async updateIngredient(
    id: string,
    restaurantId: string,
    dto: UpdateIngredientDto,
    actor?: any,
  ): Promise<Ingredient> {
    const ingredient = await this.findIngredientById(id, restaurantId);

    if (dto.name && dto.name.trim() !== ingredient.name) {
      const cleanName = dto.name.trim();
      const duplicate = await this.ingredientRepo.findOne({
        where: { restaurantId, name: cleanName },
      });
      if (duplicate && duplicate.id !== id && duplicate.isActive) {
        throw new ConflictException(`Another ingredient named '${cleanName}' already exists`);
      }
      ingredient.name = cleanName;
    }

    if (dto.sku !== undefined) ingredient.sku = dto.sku ? dto.sku.trim() : null;
    if (dto.unit !== undefined) ingredient.unit = dto.unit;
    if (dto.minimumStock !== undefined) ingredient.minimumStock = Number(dto.minimumStock);
    if (dto.costPerUnit !== undefined) ingredient.costPerUnit = Number(dto.costPerUnit);
    if (dto.isActive !== undefined) ingredient.isActive = dto.isActive;

    const saved = await this.ingredientRepo.save(ingredient);

    await this.auditService.record({
      restaurantId,
      entityType: 'Ingredient',
      entityId: saved.id,
      action: AuditAction.INGREDIENT_UPDATED,
      staffId: actor?.id,
      staffName: actor?.name,
      staffRole: actor?.role,
      reason: `Ingredient '${saved.name}' metadata updated`,
      metadata: { minimumStock: saved.minimumStock, costPerUnit: saved.costPerUnit },
    });

    return saved;
  }

  /**
   * Manual Stock Adjustment with atomic row-level lock and idempotency.
   */
  async adjustStock(
    id: string,
    restaurantId: string,
    dto: AdjustStockDto,
    actor?: any,
    idempotencyKey?: string,
  ): Promise<{ ingredient: Ingredient; movement: StockMovement }> {
    const cleanKey = (idempotencyKey || `adj-${id}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`).trim();

    // Check idempotency first
    const existingMovement = await this.stockMovementRepo.findOne({
      where: { idempotencyKey: cleanKey },
      relations: { ingredient: true },
    });
    if (existingMovement) {
      return {
        ingredient: existingMovement.ingredient,
        movement: existingMovement,
      };
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Row-level lock to prevent concurrent race conditions
      const ingredient = await queryRunner.manager
        .createQueryBuilder(Ingredient, 'i')
        .setLock('pessimistic_write')
        .where('i.id = :id AND i.restaurant_id = :restaurantId', { id, restaurantId })
        .getOne();

      if (!ingredient) {
        throw new NotFoundException(`Ingredient '${id}' not found in outlet '${restaurantId}'`);
      }

      const delta = Number(dto.quantityDelta);
      const current = Number(ingredient.currentStock);
      const balanceAfter = Math.round((current + delta) * 1000) / 1000;

      if (balanceAfter < 0) {
        throw new BadRequestException(
          `Cannot reduce stock by ${Math.abs(delta)} ${ingredient.unit}. Current balance is ${current} ${ingredient.unit}.`,
        );
      }

      ingredient.currentStock = balanceAfter;
      const updatedIngredient = await queryRunner.manager.save(Ingredient, ingredient);

      const movement = queryRunner.manager.create(StockMovement, {
        restaurantId,
        ingredientId: id,
        type: dto.type || (delta < 0 ? StockMovementType.WASTAGE : StockMovementType.MANUAL_ADJUSTMENT),
        quantity: delta,
        balanceAfter,
        reason: dto.reason.trim(),
        actorStaffId: actor?.id || null,
        idempotencyKey: cleanKey,
      });

      const savedMovement = await queryRunner.manager.save(StockMovement, movement);
      await queryRunner.commitTransaction();

      await this.auditService.record({
        restaurantId,
        entityType: 'Ingredient',
        entityId: id,
        action: AuditAction.STOCK_ADJUSTED,
        staffId: actor?.id,
        staffName: actor?.name,
        staffRole: actor?.role,
        reason: `Stock adjusted by ${delta > 0 ? '+' : ''}${delta} ${ingredient.unit} (Reason: ${dto.reason})`,
        metadata: { delta, balanceAfter, movementId: savedMovement.id },
      });

      return { ingredient: updatedIngredient, movement: savedMovement };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Batch receive stock from supplier delivery.
   */
  async receiveStock(
    restaurantId: string,
    dto: ReceiveStockDto,
    actor?: any,
    idempotencyKey?: string,
  ): Promise<{ receivedMovements: StockMovement[]; updatedIngredients: Ingredient[] }> {
    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('At least one item must be included in stock receipt');
    }

    const cleanBatchKey = (idempotencyKey || `rec-${restaurantId}-${Date.now()}`).trim();

    // Verify outlet exists
    const restaurant = await this.restaurantRepo.findOne({ where: { id: restaurantId } });
    if (!restaurant) {
      throw new NotFoundException(`Restaurant '${restaurantId}' not found`);
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Sort ingredient IDs to avoid database deadlocks during multi-row lock
      const sortedItemDtos = [...dto.items].sort((a, b) => a.ingredientId.localeCompare(b.ingredientId));
      const receivedMovements: StockMovement[] = [];
      const updatedIngredients: Ingredient[] = [];

      let itemIndex = 0;
      for (const item of sortedItemDtos) {
        const itemKey = `${cleanBatchKey}-item-${itemIndex++}`;

        // Check idempotency per line
        const existing = await queryRunner.manager.findOne(StockMovement, {
          where: { idempotencyKey: itemKey },
        });
        if (existing) {
          receivedMovements.push(existing);
          continue;
        }

        const ingredient = await queryRunner.manager
          .createQueryBuilder(Ingredient, 'i')
          .setLock('pessimistic_write')
          .where('i.id = :id AND i.restaurant_id = :restaurantId', {
            id: item.ingredientId,
            restaurantId,
          })
          .getOne();

        if (!ingredient) {
          throw new BadRequestException(
            `Ingredient '${item.ingredientId}' not found in outlet '${restaurantId}'`,
          );
        }

        const qty = Number(item.quantity);
        const newBalance = Math.round((Number(ingredient.currentStock) + qty) * 1000) / 1000;
        ingredient.currentStock = newBalance;

        if (item.costPerUnit !== undefined && Number(item.costPerUnit) > 0) {
          ingredient.costPerUnit = Number(item.costPerUnit);
        }

        const savedIng = await queryRunner.manager.save(Ingredient, ingredient);
        updatedIngredients.push(savedIng);

        const reason = [
          dto.supplierName ? `Supplier: ${dto.supplierName}` : null,
          dto.invoiceNumber ? `Invoice: ${dto.invoiceNumber}` : null,
          item.notes ? item.notes : null,
        ]
          .filter(Boolean)
          .join(' | ') || 'Stock received from supplier';

        const movement = queryRunner.manager.create(StockMovement, {
          restaurantId,
          ingredientId: item.ingredientId,
          type: StockMovementType.RECEIVED,
          quantity: qty,
          balanceAfter: newBalance,
          reason,
          actorStaffId: actor?.id || null,
          idempotencyKey: itemKey,
        });

        const savedMovement = await queryRunner.manager.save(StockMovement, movement);
        receivedMovements.push(savedMovement);
      }

      await queryRunner.commitTransaction();

      await this.auditService.record({
        restaurantId,
        entityType: 'Inventory',
        entityId: restaurantId,
        action: AuditAction.STOCK_RECEIVED,
        staffId: actor?.id,
        staffName: actor?.name,
        staffRole: actor?.role,
        reason: `Received ${receivedMovements.length} stock line items. Ref: ${dto.invoiceNumber || 'N/A'}`,
        metadata: {
          invoiceNumber: dto.invoiceNumber,
          supplierName: dto.supplierName,
          itemCount: receivedMovements.length,
        },
      });

      return { receivedMovements, updatedIngredients };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Query audited stock movements ledger.
   */
  async findStockMovements(restaurantId: string, query: StockMovementQueryDto) {
    const qb = this.stockMovementRepo
      .createQueryBuilder('m')
      .leftJoinAndSelect('m.ingredient', 'ingredient')
      .leftJoinAndSelect('m.actor', 'actor')
      .where('m.restaurant_id = :restaurantId', { restaurantId });

    if (query.ingredientId) {
      qb.andWhere('m.ingredient_id = :ingredientId', { ingredientId: query.ingredientId });
    }

    if (query.type) {
      qb.andWhere('m.type = :type', { type: query.type });
    }

    if (query.startDate) {
      const start = new Date(query.startDate);
      if (!isNaN(start.getTime())) {
        qb.andWhere('m.created_at >= :start', { start: start.toISOString() });
      }
    }

    if (query.endDate) {
      const end = new Date(query.endDate);
      if (!isNaN(end.getTime())) {
        qb.andWhere('m.created_at <= :end', { end: end.toISOString() });
      }
    }

    const page = Math.max(1, query.page || 1);
    const limit = Math.min(100, Math.max(1, query.limit || 50));
    const skip = (page - 1) * limit;

    qb.orderBy('m.created_at', 'DESC').skip(skip).take(limit);

    const [items, total] = await qb.getManyAndCount();
    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Returns active low-stock (< min) and out-of-stock (<= 0) alerts.
   */
  async getLowStockAlerts(restaurantId: string): Promise<{
    outOfStock: Ingredient[];
    lowStock: Ingredient[];
    healthyCount: number;
  }> {
    const ingredients = await this.findAllIngredients(restaurantId, true);

    const outOfStock: Ingredient[] = [];
    const lowStock: Ingredient[] = [];
    let healthyCount = 0;

    for (const ing of ingredients) {
      const stock = Number(ing.currentStock);
      const min = Number(ing.minimumStock);

      if (stock <= 0) {
        outOfStock.push(ing);
      } else if (stock <= min && min > 0) {
        lowStock.push(ing);
      } else {
        healthyCount++;
      }
    }

    return {
      outOfStock,
      lowStock,
      healthyCount,
    };
  }

  /**
   * Create or update recipe for a menu item.
   * Increments version on update and marks previous versions inactive.
   */
  async upsertRecipe(
    restaurantId: string,
    dto: CreateRecipeDto,
    actor?: any,
  ): Promise<Recipe> {
    const restaurant = await this.restaurantRepo.findOne({ where: { id: restaurantId } });
    if (!restaurant) {
      throw new NotFoundException(`Restaurant '${restaurantId}' not found`);
    }

    const menuItem = await this.menuItemRepo.findOne({
      where: { id: dto.menuItemId, restaurantId },
    });
    if (!menuItem) {
      throw new NotFoundException(`Menu item '${dto.menuItemId}' not found in outlet '${restaurantId}'`);
    }

    if (!dto.ingredients || dto.ingredients.length === 0) {
      throw new BadRequestException('Recipe must include at least one ingredient');
    }

    // Verify all ingredients exist in this restaurant
    const foundIngredients = await this.ingredientRepo.find({
      where: { restaurantId },
    });
    const foundMap = new Map(foundIngredients.map((ing) => [ing.id, ing]));

    for (const item of dto.ingredients) {
      const ing = foundMap.get(item.ingredientId);
      if (!ing || !ing.isActive) {
        throw new BadRequestException(`Ingredient '${item.ingredientId}' not found or inactive in this outlet`);
      }
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Find existing active recipe for this menu item
      const existing = await queryRunner.manager.findOne(Recipe, {
        where: { restaurantId, menuItemId: dto.menuItemId, isActive: true },
      });

      let version = 1;
      if (existing) {
        version = existing.version + 1;
        existing.isActive = false;
        await queryRunner.manager.save(Recipe, existing);
      }

      const recipe = queryRunner.manager.create(Recipe, {
        restaurantId,
        menuItemId: dto.menuItemId,
        version,
        isActive: true,
        notes: dto.notes ? dto.notes.trim() : null,
      });

      const savedRecipe = await queryRunner.manager.save(Recipe, recipe);

      const recipeIngredients = dto.ingredients.map((ing) =>
        queryRunner.manager.create(RecipeIngredient, {
          recipeId: savedRecipe.id,
          ingredientId: ing.ingredientId,
          quantity: ing.quantity,
          unit: ing.unit,
        }),
      );

      await queryRunner.manager.save(RecipeIngredient, recipeIngredients);
      await queryRunner.commitTransaction();

      await this.auditService.record({
        restaurantId,
        entityType: 'Recipe',
        entityId: savedRecipe.id,
        action: existing ? AuditAction.RECIPE_UPDATED : AuditAction.RECIPE_CREATED,
        staffId: actor?.id,
        staffName: actor?.name,
        staffRole: actor?.role,
        reason: `Recipe for '${menuItem.name}' (v${version}) saved with ${recipeIngredients.length} ingredients`,
        metadata: { menuItemId: dto.menuItemId, version, ingredientCount: recipeIngredients.length },
      });

      return this.findRecipeByMenuItem(restaurantId, dto.menuItemId);
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Find active recipe for a menu item with ingredient details.
   */
  async findRecipeByMenuItem(restaurantId: string, menuItemId: string): Promise<Recipe> {
    const recipe = await this.recipeRepo.findOne({
      where: { restaurantId, menuItemId, isActive: true },
      relations: {
        ingredients: { ingredient: true },
        menuItem: true,
      },
    });

    if (!recipe) {
      throw new NotFoundException(`No active recipe found for menu item '${menuItemId}'`);
    }

    return recipe;
  }

  /**
   * List all active recipes in an outlet.
   */
  async findAllRecipes(restaurantId: string): Promise<Recipe[]> {
    return this.recipeRepo.find({
      where: { restaurantId, isActive: true },
      relations: {
        ingredients: { ingredient: true },
        menuItem: true,
      },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Atomic inventory deduction for confirmed order.
   * Deducts ingredients when order enters RECEIVED.
   * Row-level write locks prevent overselling across concurrent orders.
   */
  async deductInventoryForOrder(
    restaurantId: string,
    orderId: string,
    orderItems: Array<{ menuItemId: string; quantity: number; name?: string }>,
  ): Promise<void> {
    const restaurant = await this.restaurantRepo.findOne({ where: { id: restaurantId } });
    if (!restaurant || !restaurant.autoDeductInventory) {
      this.logger.debug(`Auto inventory deduction skipped for restaurant ${restaurantId}`);
      return;
    }

    // 1. Collect all menu item IDs and load active recipes
    const menuItemIds = [...new Set(orderItems.map((i) => i.menuItemId))];
    const recipes = await this.recipeRepo.find({
      where: {
        restaurantId,
        isActive: true,
      },
      relations: {
        ingredients: { ingredient: true },
        menuItem: true,
      },
    });

    const recipeMap = new Map<string, Recipe>();
    for (const r of recipes) {
      if (menuItemIds.includes(r.menuItemId)) {
        recipeMap.set(r.menuItemId, r);
      }
    }

    // If no active recipes exist for ordered items, nothing to deduct
    if (recipeMap.size === 0) {
      return;
    }

    // 2. Consolidate required ingredient amounts across all ordered items
    const requiredAmounts = new Map<string, {
      ingredient: Ingredient;
      requiredQty: number;
      recipeVersions: Set<number>;
      itemNames: Set<string>;
    }>();

    for (const item of orderItems) {
      const recipe = recipeMap.get(item.menuItemId);
      if (!recipe || !recipe.ingredients) continue;

      for (const ri of recipe.ingredients) {
        const ing = ri.ingredient;
        if (!ing) continue;

        const needed = Number(ri.quantity) * Number(item.quantity);
        const existing = requiredAmounts.get(ing.id);

        if (existing) {
          existing.requiredQty = Math.round((existing.requiredQty + needed) * 1000) / 1000;
          existing.recipeVersions.add(recipe.version);
          existing.itemNames.add(recipe.menuItem?.name || item.name || 'Dish');
        } else {
          requiredAmounts.set(ing.id, {
            ingredient: ing,
            requiredQty: Math.round(needed * 1000) / 1000,
            recipeVersions: new Set([recipe.version]),
            itemNames: new Set([recipe.menuItem?.name || item.name || 'Dish']),
          });
        }
      }
    }

    if (requiredAmounts.size === 0) {
      return;
    }

    // 3. Acquire row-level locks and deduct stock inside a concurrency-safe transaction
    // Sort ingredient IDs alphabetically to prevent deadlocks
    const sortedIngredientIds = Array.from(requiredAmounts.keys()).sort();

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const recordedMovements: StockMovement[] = [];

      for (const ingredientId of sortedIngredientIds) {
        const req = requiredAmounts.get(ingredientId)!;
        const movementKey = `ord-deduct-${orderId}-${ingredientId}`;

        // Check idempotency first
        const existingMovement = await queryRunner.manager.findOne(StockMovement, {
          where: { idempotencyKey: movementKey },
        });
        if (existingMovement) {
          continue;
        }

        // Lock ingredient row
        const lockedIng = await queryRunner.manager
          .createQueryBuilder(Ingredient, 'i')
          .setLock('pessimistic_write')
          .where('i.id = :id AND i.restaurant_id = :restaurantId', {
            id: ingredientId,
            restaurantId,
          })
          .getOne();

        if (!lockedIng) {
          throw new BadRequestException(`Ingredient '${ingredientId}' not found for deduction`);
        }

        const currentStock = Number(lockedIng.currentStock);
        if (currentStock < req.requiredQty) {
          const dishList = Array.from(req.itemNames).join(', ');
          throw new BadRequestException(
            `Insufficient stock for '${lockedIng.name}' to fulfill ${dishList}. Available: ${currentStock} ${lockedIng.unit}, Required: ${req.requiredQty} ${lockedIng.unit}.`,
          );
        }

        const balanceAfter = Math.round((currentStock - req.requiredQty) * 1000) / 1000;
        lockedIng.currentStock = balanceAfter;
        await queryRunner.manager.save(Ingredient, lockedIng);

        const versionSummary = Array.from(req.recipeVersions).join(',');
        const itemSummary = Array.from(req.itemNames).join(', ');
        const movement = queryRunner.manager.create(StockMovement, {
          restaurantId,
          ingredientId,
          type: StockMovementType.ORDER_CONSUMPTION,
          quantity: -req.requiredQty,
          balanceAfter,
          reason: `Order ${orderId} preparation: ${itemSummary} (Recipe v${versionSummary})`,
          referenceOrderId: orderId,
          idempotencyKey: movementKey,
        });

        const savedMov = await queryRunner.manager.save(StockMovement, movement);
        recordedMovements.push(savedMov);
      }

      await queryRunner.commitTransaction();

      if (recordedMovements.length > 0) {
        await this.auditService.record({
          restaurantId,
          entityType: 'Order',
          entityId: orderId,
          action: AuditAction.STOCK_DEDUCTED,
          reason: `Auto deducted ${recordedMovements.length} ingredients for confirmed order ${orderId}`,
          metadata: { orderId, deductedCount: recordedMovements.length },
        });
      }
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Reverse stock exactly once if an order is cancelled before PREPARING.
   * If cancelled after PREPARING starts, no automatic stock restoration is performed.
   */
  async reverseInventoryForCancelledOrder(
    restaurantId: string,
    orderId: string,
    actor?: any,
    reason?: string,
  ): Promise<void> {
    // Find all consumption movements for this order
    const consumptionMovements = await this.stockMovementRepo.find({
      where: {
        restaurantId,
        referenceOrderId: orderId,
        type: StockMovementType.ORDER_CONSUMPTION,
      },
    });

    if (!consumptionMovements || consumptionMovements.length === 0) {
      return; // Nothing was deducted for this order
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const restoredMovements: StockMovement[] = [];

      for (const mov of consumptionMovements) {
        const reversalKey = `ord-rev-${orderId}-${mov.id}`;

        // Check idempotency: ensure exact-once reversal
        const existingReversal = await queryRunner.manager.findOne(StockMovement, {
          where: { idempotencyKey: reversalKey },
        });
        if (existingReversal) {
          continue;
        }

        const lockedIng = await queryRunner.manager
          .createQueryBuilder(Ingredient, 'i')
          .setLock('pessimistic_write')
          .where('i.id = :id AND i.restaurant_id = :restaurantId', {
            id: mov.ingredientId,
            restaurantId,
          })
          .getOne();

        if (!lockedIng) continue;

        const returnQty = Math.abs(Number(mov.quantity));
        const newBalance = Math.round((Number(lockedIng.currentStock) + returnQty) * 1000) / 1000;
        lockedIng.currentStock = newBalance;
        await queryRunner.manager.save(Ingredient, lockedIng);

        const reversal = queryRunner.manager.create(StockMovement, {
          restaurantId,
          ingredientId: mov.ingredientId,
          type: StockMovementType.ORDER_CANCELLATION_REVERSAL,
          quantity: returnQty,
          balanceAfter: newBalance,
          reason: reason || `Stock restored from cancelled order ${orderId} (Prior to preparation)`,
          referenceOrderId: orderId,
          actorStaffId: actor?.id || null,
          idempotencyKey: reversalKey,
        });

        const saved = await queryRunner.manager.save(StockMovement, reversal);
        restoredMovements.push(saved);
      }

      await queryRunner.commitTransaction();

      if (restoredMovements.length > 0) {
        await this.auditService.record({
          restaurantId,
          entityType: 'Order',
          entityId: orderId,
          action: AuditAction.STOCK_RESTORED,
          staffId: actor?.id,
          staffName: actor?.name,
          staffRole: actor?.role,
          reason: `Stock reversed for cancelled order ${orderId} (${restoredMovements.length} ingredients restored)`,
          metadata: { orderId, restoredCount: restoredMovements.length },
        });
      }
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }
}
