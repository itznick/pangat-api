import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryService } from '../dist/inventory/inventory.service.js';
import {
  UnitOfMeasure,
  StockMovementType,
  StaffRole,
} from '../dist/common/enums/index.js';

function createMockInventoryService(options = {}) {
  const ingredients = (options.ingredients || []).map((i) => ({ ...i }));
  const recipes = (options.recipes || []).map((r) => ({ ...r, ingredients: r.ingredients ? [...r.ingredients] : [] }));
  const movements = (options.movements || []).map((m) => ({ ...m }));
  const menuItems = (options.menuItems || []).map((mi) => ({ ...mi }));
  const restaurants = options.restaurants || [
    { id: 'rest-uuid-1', slug: 'pangat-pune', name: 'Pangat Pune', autoDeductInventory: true },
  ];
  const auditLogs = [];

  const createIngredientQb = () => {
    let filterRestaurantId = null;
    let filterActiveOnly = false;
    const qb = {
      where: (_clause, params) => {
        if (params?.restaurantId) filterRestaurantId = params.restaurantId;
        return qb;
      },
      andWhere: (clause) => {
        if (clause.includes('is_active = true')) filterActiveOnly = true;
        return qb;
      },
      orderBy: () => qb,
      getMany: async () => {
        return ingredients.filter((ing) => {
          if (filterRestaurantId && ing.restaurantId !== filterRestaurantId) return false;
          if (filterActiveOnly && !ing.isActive) return false;
          return true;
        });
      },
    };
    return qb;
  };

  const mockIngredientRepo = {
    createQueryBuilder: () => createIngredientQb(),
    find: async ({ where } = {}) => {
      return ingredients.filter((ing) => {
        if (where?.restaurantId && ing.restaurantId !== where.restaurantId) return false;
        if (where?.isActive !== undefined && ing.isActive !== where.isActive) return false;
        return true;
      });
    },
    findOne: async ({ where } = {}) => {
      return (
        ingredients.find((ing) => {
          if (where?.id && ing.id !== where.id) return false;
          if (where?.restaurantId && ing.restaurantId !== where.restaurantId) return false;
          return true;
        }) || null
      );
    },
    save: async (item) => {
      const idx = ingredients.findIndex((i) => i.id === item.id);
      if (idx >= 0) {
        ingredients[idx] = { ...ingredients[idx], ...item };
        return ingredients[idx];
      }
      ingredients.push(item);
      return item;
    },
  };

  const mockRecipeRepo = {
    find: async ({ where } = {}) => {
      return recipes
        .filter((r) => {
          if (where?.restaurantId && r.restaurantId !== where.restaurantId) return false;
          if (where?.isActive !== undefined && r.isActive !== where.isActive) return false;
          return true;
        })
        .map((r) => {
          const menuItem = menuItems.find((m) => m.id === r.menuItemId);
          return { ...r, menuItem };
        });
    },
    findOne: async ({ where } = {}) => {
      const match = recipes.find((r) => {
        if (where?.restaurantId && r.restaurantId !== where.restaurantId) return false;
        if (where?.menuItemId && r.menuItemId !== where.menuItemId) return false;
        if (where?.isActive !== undefined && r.isActive !== where.isActive) return false;
        return true;
      });
      if (!match) return null;
      const menuItem = menuItems.find((m) => m.id === match.menuItemId);
      return { ...match, menuItem };
    },
    save: async (r) => {
      const idx = recipes.findIndex((item) => item.id === r.id);
      if (idx >= 0) {
        recipes[idx] = { ...recipes[idx], ...r };
        return recipes[idx];
      }
      recipes.push(r);
      return r;
    },
  };

  const mockRecipeIngredientRepo = {
    save: async (items) => {
      return Array.isArray(items) ? items : [items];
    },
  };

  const mockStockMovementRepo = {
    find: async ({ where } = {}) => {
      return movements.filter((m) => {
        if (where?.restaurantId && m.restaurantId !== where.restaurantId) return false;
        if (where?.referenceOrderId && m.referenceOrderId !== where.referenceOrderId) return false;
        if (where?.type && m.type !== where.type) return false;
        return true;
      });
    },
    findOne: async ({ where } = {}) => {
      return (
        movements.find((m) => {
          if (where?.idempotencyKey && m.idempotencyKey !== where.idempotencyKey) return false;
          if (where?.restaurantId && m.restaurantId !== where.restaurantId) return false;
          return true;
        }) || null
      );
    },
    save: async (item) => {
      movements.push(item);
      return item;
    },
  };

  const mockMenuItemRepo = {
    findOne: async ({ where } = {}) => {
      return menuItems.find((m) => m.id === where?.id && (!where?.restaurantId || m.restaurantId === where.restaurantId)) || null;
    },
  };

  const mockRestaurantRepo = {
    findOne: async ({ where } = {}) => {
      return restaurants.find((r) => r.id === where?.id) || null;
    },
  };

  const mockAuditService = {
    record: async (dto) => {
      auditLogs.push(dto);
      return dto;
    },
  };

  // Mock QueryRunner for transactions with row-level locking simulation
  const createMockQueryRunner = () => {
    let snapshotIngredients = null;
    let snapshotMovements = null;
    return {
      connect: async () => {},
      startTransaction: async () => {
        snapshotIngredients = ingredients.map((i) => ({ ...i }));
        snapshotMovements = movements.map((m) => ({ ...m }));
      },
      commitTransaction: async () => {},
      rollbackTransaction: async () => {
        if (snapshotIngredients) {
          ingredients.length = 0;
          snapshotIngredients.forEach((i) => ingredients.push({ ...i }));
        }
        if (snapshotMovements) {
          movements.length = 0;
          snapshotMovements.forEach((m) => movements.push({ ...m }));
        }
      },
      release: async () => {},
      manager: {
        create: (entityClass, dto) => ({
          ...dto,
          id: (dto.id || entityClass.name.toLowerCase().slice(0, 3) + '-' + Math.random().toString(36).slice(2, 8)),
          createdAt: new Date(),
        }),
        save: async (_entityClassOrEntity, maybeEntity) => {
          const entity = maybeEntity !== undefined ? maybeEntity : _entityClassOrEntity;
          if (Array.isArray(entity)) {
            return entity.map((e) => {
              if (e.quantity !== undefined && e.unit !== undefined) return e;
              return e;
            });
          }
          if (entity.currentStock !== undefined) {
            return mockIngredientRepo.save(entity);
          }
          if (entity.version !== undefined && entity.menuItemId !== undefined) {
            return mockRecipeRepo.save(entity);
          }
          if (entity.referenceOrderId !== undefined || entity.type !== undefined) {
            return mockStockMovementRepo.save(entity);
          }
          return entity;
        },
        findOne: async (entityClass, opts) => {
          if (entityClass.name === 'StockMovement') return mockStockMovementRepo.findOne(opts);
          if (entityClass.name === 'Recipe') return mockRecipeRepo.findOne(opts);
          return mockIngredientRepo.findOne(opts);
        },
        createQueryBuilder: (_entityClass, _alias) => {
          let lockedId = null;
          let lockedRestaurantId = null;
          const qb = {
            setLock: () => qb,
            where: (_clause, params) => {
              if (params?.id) lockedId = params.id;
              if (params?.restaurantId) lockedRestaurantId = params.restaurantId;
              return qb;
            },
            getOne: async () => {
              return ingredients.find((i) => i.id === lockedId && (!lockedRestaurantId || i.restaurantId === lockedRestaurantId) && i.isActive) || null;
            },
          };
          return qb;
        },
      },
    };
  };

  const mockDataSource = {
    createQueryRunner: () => createMockQueryRunner(),
  };

  const service = new InventoryService(
    mockIngredientRepo,
    mockStockMovementRepo,
    mockRecipeRepo,
    mockRecipeIngredientRepo,
    mockRestaurantRepo,
    mockMenuItemRepo,
    mockAuditService,
    mockDataSource,
  );

  return {
    service,
    ingredients,
    recipes,
    movements,
    auditLogs,
  };
}

describe('InventoryService — Recipes & Automatic Deductions', () => {
  const actor = {
    id: 'staff-uuid-1',
    name: 'Chef Gordon',
    role: StaffRole.CHEF,
  };

  describe('upsertRecipe', () => {
    it('creates version 1 recipe for a menu item', async () => {
      const { service, recipes } = createMockInventoryService({
        ingredients: [
          { id: 'ing-paneer', restaurantId: 'rest-uuid-1', name: 'Paneer', unit: UnitOfMeasure.GRAM, currentStock: 2000, isActive: true },
          { id: 'ing-butter', restaurantId: 'rest-uuid-1', name: 'Butter', unit: UnitOfMeasure.GRAM, currentStock: 1000, isActive: true },
        ],
        menuItems: [
          { id: 'item-pbm', restaurantId: 'rest-uuid-1', name: 'Paneer Butter Masala', price: 250 },
        ],
      });

      const recipe = await service.upsertRecipe(
        'rest-uuid-1',
        {
          menuItemId: 'item-pbm',
          notes: 'Standard restaurant portion',
          ingredients: [
            { ingredientId: 'ing-paneer', quantity: 200, unit: UnitOfMeasure.GRAM },
            { ingredientId: 'ing-butter', quantity: 30, unit: UnitOfMeasure.GRAM },
          ],
        },
        actor,
      );

      assert.strictEqual(recipe.version, 1);
      assert.strictEqual(recipe.menuItemId, 'item-pbm');
      assert.strictEqual(recipes.length, 1);
      assert.strictEqual(recipes[0].isActive, true);
    });

    it('increments version to 2 and deactivates version 1 when recipe is updated', async () => {
      const { service, recipes } = createMockInventoryService({
        ingredients: [
          { id: 'ing-paneer', restaurantId: 'rest-uuid-1', name: 'Paneer', unit: UnitOfMeasure.GRAM, currentStock: 2000, isActive: true },
          { id: 'ing-butter', restaurantId: 'rest-uuid-1', name: 'Butter', unit: UnitOfMeasure.GRAM, currentStock: 1000, isActive: true },
        ],
        menuItems: [
          { id: 'item-pbm', restaurantId: 'rest-uuid-1', name: 'Paneer Butter Masala', price: 250 },
        ],
        recipes: [
          {
            id: 'rec-1',
            restaurantId: 'rest-uuid-1',
            menuItemId: 'item-pbm',
            version: 1,
            isActive: true,
            ingredients: [
              { ingredientId: 'ing-paneer', quantity: 180, unit: UnitOfMeasure.GRAM },
            ],
          },
        ],
      });

      const updated = await service.upsertRecipe(
        'rest-uuid-1',
        {
          menuItemId: 'item-pbm',
          notes: 'Updated paneer portion to 200g',
          ingredients: [
            { ingredientId: 'ing-paneer', quantity: 200, unit: UnitOfMeasure.GRAM },
            { ingredientId: 'ing-butter', quantity: 25, unit: UnitOfMeasure.GRAM },
          ],
        },
        actor,
      );

      assert.strictEqual(updated.version, 2);
      // Original recipe marked inactive
      const v1 = recipes.find((r) => r.id === 'rec-1');
      assert.strictEqual(v1.isActive, false);
    });
  });

  describe('deductInventoryForOrder', () => {
    it('deducts ingredients according to recipe quantities and order item quantities', async () => {
      const { service, ingredients, movements } = createMockInventoryService({
        ingredients: [
          { id: 'ing-paneer', restaurantId: 'rest-uuid-1', name: 'Paneer', unit: UnitOfMeasure.GRAM, currentStock: 2000, isActive: true },
          { id: 'ing-butter', restaurantId: 'rest-uuid-1', name: 'Butter', unit: UnitOfMeasure.GRAM, currentStock: 1000, isActive: true },
        ],
        menuItems: [
          { id: 'item-pbm', restaurantId: 'rest-uuid-1', name: 'Paneer Butter Masala', price: 250 },
        ],
        recipes: [
          {
            id: 'rec-1',
            restaurantId: 'rest-uuid-1',
            menuItemId: 'item-pbm',
            version: 1,
            isActive: true,
            ingredients: [
              { ingredient: { id: 'ing-paneer', name: 'Paneer', unit: UnitOfMeasure.GRAM, currentStock: 2000, isActive: true }, quantity: 200, unit: UnitOfMeasure.GRAM },
              { ingredient: { id: 'ing-butter', name: 'Butter', unit: UnitOfMeasure.GRAM, currentStock: 1000, isActive: true }, quantity: 30, unit: UnitOfMeasure.GRAM },
            ],
          },
        ],
      });

      // Customer orders 2 plates of Paneer Butter Masala
      await service.deductInventoryForOrder(
        'rest-uuid-1',
        'ORD-101',
        [{ menuItemId: 'item-pbm', quantity: 2, name: 'Paneer Butter Masala' }],
      );

      // Paneer should reduce by 2 * 200 = 400g -> 1600g
      const paneer = ingredients.find((i) => i.id === 'ing-paneer');
      assert.strictEqual(Number(paneer.currentStock), 1600);

      // Butter should reduce by 2 * 30 = 60g -> 940g
      const butter = ingredients.find((i) => i.id === 'ing-butter');
      assert.strictEqual(Number(butter.currentStock), 940);

      // Movements should be recorded
      assert.strictEqual(movements.length, 2);
      const paneerMov = movements.find((m) => m.ingredientId === 'ing-paneer');
      assert.strictEqual(paneerMov.type, StockMovementType.ORDER_CONSUMPTION);
      assert.strictEqual(Number(paneerMov.quantity), -400);
      assert.strictEqual(Number(paneerMov.balanceAfter), 1600);
      assert.strictEqual(paneerMov.referenceOrderId, 'ORD-101');
    });

    it('rejects order with BadRequestException if any required ingredient has insufficient stock', async () => {
      const { service, ingredients } = createMockInventoryService({
        ingredients: [
          { id: 'ing-paneer', restaurantId: 'rest-uuid-1', name: 'Paneer', unit: UnitOfMeasure.GRAM, currentStock: 300, isActive: true },
        ],
        menuItems: [
          { id: 'item-pbm', restaurantId: 'rest-uuid-1', name: 'Paneer Butter Masala', price: 250 },
        ],
        recipes: [
          {
            id: 'rec-1',
            restaurantId: 'rest-uuid-1',
            menuItemId: 'item-pbm',
            version: 1,
            isActive: true,
            ingredients: [
              { ingredient: { id: 'ing-paneer', name: 'Paneer', unit: UnitOfMeasure.GRAM, currentStock: 300, isActive: true }, quantity: 200, unit: UnitOfMeasure.GRAM },
            ],
          },
        ],
      });

      // Customer orders 2 plates (requires 400g, but only 300g available)
      await assert.rejects(
        service.deductInventoryForOrder(
          'rest-uuid-1',
          'ORD-102',
          [{ menuItemId: 'item-pbm', quantity: 2, name: 'Paneer Butter Masala' }],
        ),
        /Insufficient stock for 'Paneer'/i,
      );

      // Stock should remain unchanged
      const paneer = ingredients.find((i) => i.id === 'ing-paneer');
      assert.strictEqual(Number(paneer.currentStock), 300);
    });

    it('rolls back entire deduction and leaves no partial deductions if one of multiple ingredients fails', async () => {
      const { service, ingredients, movements } = createMockInventoryService({
        ingredients: [
          { id: 'ing-butter', restaurantId: 'rest-uuid-1', name: 'Butter', unit: UnitOfMeasure.GRAM, currentStock: 1000, isActive: true },
          { id: 'ing-paneer', restaurantId: 'rest-uuid-1', name: 'Paneer', unit: UnitOfMeasure.GRAM, currentStock: 100, isActive: true },
        ],
        menuItems: [
          { id: 'item-pbm', restaurantId: 'rest-uuid-1', name: 'Paneer Butter Masala', price: 250 },
        ],
        recipes: [
          {
            id: 'rec-1',
            restaurantId: 'rest-uuid-1',
            menuItemId: 'item-pbm',
            version: 1,
            isActive: true,
            ingredients: [
              { ingredient: { id: 'ing-butter', name: 'Butter', unit: UnitOfMeasure.GRAM, currentStock: 1000, isActive: true }, quantity: 50, unit: UnitOfMeasure.GRAM },
              { ingredient: { id: 'ing-paneer', name: 'Paneer', unit: UnitOfMeasure.GRAM, currentStock: 100, isActive: true }, quantity: 200, unit: UnitOfMeasure.GRAM },
            ],
          },
        ],
      });

      // Butter has 1000g (sufficient), but Paneer has only 100g (needs 200g). Entire deduction must roll back!
      await assert.rejects(
        service.deductInventoryForOrder(
          'rest-uuid-1',
          'ORD-FAIL-1',
          [{ menuItemId: 'item-pbm', quantity: 1, name: 'Paneer Butter Masala' }],
        ),
        /Insufficient stock for 'Paneer'/i,
      );

      // Butter must NOT have been partially deducted!
      const butter = ingredients.find((i) => i.id === 'ing-butter');
      assert.strictEqual(Number(butter.currentStock), 1000);
      assert.strictEqual(movements.length, 0);
    });

    it('prevents duplicate deductions when the same order deduction is retried (exact idempotency)', async () => {
      const { service, ingredients, movements } = createMockInventoryService({
        ingredients: [
          { id: 'ing-rice', restaurantId: 'rest-uuid-1', name: 'Basmati Rice', unit: UnitOfMeasure.GRAM, currentStock: 5000, isActive: true },
        ],
        menuItems: [
          { id: 'item-biryani', restaurantId: 'rest-uuid-1', name: 'Dum Biryani', price: 300 },
        ],
        recipes: [
          {
            id: 'rec-biryani',
            restaurantId: 'rest-uuid-1',
            menuItemId: 'item-biryani',
            version: 1,
            isActive: true,
            ingredients: [
              { ingredient: { id: 'ing-rice', name: 'Basmati Rice', unit: UnitOfMeasure.GRAM, currentStock: 5000, isActive: true }, quantity: 250, unit: UnitOfMeasure.GRAM },
            ],
          },
        ],
      });

      // First deduction
      await service.deductInventoryForOrder(
        'rest-uuid-1',
        'ORD-DUP-01',
        [{ menuItemId: 'item-biryani', quantity: 2, name: 'Dum Biryani' }],
      );

      const rice1 = ingredients.find((i) => i.id === 'ing-rice');
      assert.strictEqual(Number(rice1.currentStock), 4500);
      assert.strictEqual(movements.length, 1);

      // Duplicate retry for same order
      await service.deductInventoryForOrder(
        'rest-uuid-1',
        'ORD-DUP-01',
        [{ menuItemId: 'item-biryani', quantity: 2, name: 'Dum Biryani' }],
      );

      // Stock must remain 4500, no second deduction!
      const rice2 = ingredients.find((i) => i.id === 'ing-rice');
      assert.strictEqual(Number(rice2.currentStock), 4500);
      assert.strictEqual(movements.length, 1);
    });

    it('does not alter historical stock movements when a recipe version changes after order placement', async () => {
      const { service, ingredients, movements } = createMockInventoryService({
        ingredients: [
          { id: 'ing-paneer', restaurantId: 'rest-uuid-1', name: 'Paneer', unit: UnitOfMeasure.GRAM, currentStock: 2000, isActive: true },
        ],
        menuItems: [
          { id: 'item-pbm', restaurantId: 'rest-uuid-1', name: 'Paneer Butter Masala', price: 250 },
        ],
        recipes: [
          {
            id: 'rec-1',
            restaurantId: 'rest-uuid-1',
            menuItemId: 'item-pbm',
            version: 1,
            isActive: true,
            ingredients: [
              { ingredient: { id: 'ing-paneer', name: 'Paneer', unit: UnitOfMeasure.GRAM, currentStock: 2000, isActive: true }, quantity: 200, unit: UnitOfMeasure.GRAM },
            ],
          },
        ],
      });

      // Order placed under Recipe v1 (200g per plate)
      await service.deductInventoryForOrder(
        'rest-uuid-1',
        'ORD-HIST-01',
        [{ menuItemId: 'item-pbm', quantity: 1, name: 'Paneer Butter Masala' }],
      );
      assert.strictEqual(Number(ingredients.find((i) => i.id === 'ing-paneer').currentStock), 1800);
      assert.strictEqual(movements[0].reason.includes('Recipe v1'), true);

      // Recipe is subsequently updated to v2 (250g per plate)
      await service.upsertRecipe('rest-uuid-1', {
        menuItemId: 'item-pbm',
        notes: 'Increased portion in v2',
        ingredients: [
          { ingredientId: 'ing-paneer', quantity: 250, unit: UnitOfMeasure.GRAM },
        ],
      }, actor);

      // Historical deduction movement for ORD-HIST-01 remains unchanged (-200g, v1)
      const historicalMov = movements.find((m) => m.referenceOrderId === 'ORD-HIST-01');
      assert.strictEqual(Number(historicalMov.quantity), -200);
      assert.strictEqual(historicalMov.reason.includes('Recipe v1'), true);

      // Cancelling ORD-HIST-01 restores strictly 200g (the historical amount), NOT the new v2 amount of 250g
      await service.reverseInventoryForCancelledOrder('rest-uuid-1', 'ORD-HIST-01', actor);
      assert.strictEqual(Number(ingredients.find((i) => i.id === 'ing-paneer').currentStock), 2000);
    });

    it('enforces tenant isolation: orders cannot deduct ingredients across restaurants', async () => {
      const { service, ingredients } = createMockInventoryService({
        ingredients: [
          { id: 'ing-tenant-2', restaurantId: 'rest-uuid-2', name: 'Other Rest Paneer', unit: UnitOfMeasure.GRAM, currentStock: 2000, isActive: true },
        ],
        menuItems: [
          { id: 'item-rest-1', restaurantId: 'rest-uuid-1', name: 'Local Paneer', price: 200 },
        ],
        recipes: [
          {
            id: 'rec-cross',
            restaurantId: 'rest-uuid-1',
            menuItemId: 'item-rest-1',
            version: 1,
            isActive: true,
            ingredients: [
              { ingredient: { id: 'ing-tenant-2', name: 'Other Rest Paneer', unit: UnitOfMeasure.GRAM, currentStock: 2000, isActive: true }, quantity: 200, unit: UnitOfMeasure.GRAM },
            ],
          },
        ],
      });

      // Deduction query runner locks by (id = :id AND restaurant_id = :restaurantId)
      // Attempting to deduct from rest-uuid-1 will find 0 matching rows for rest-uuid-2's ingredient
      await assert.rejects(
        service.deductInventoryForOrder(
          'rest-uuid-1',
          'ORD-CROSS-01',
          [{ menuItemId: 'item-rest-1', quantity: 1 }],
        ),
        /Ingredient 'ing-tenant-2' not found for deduction/i,
      );

      // Tenant 2 ingredient untouched
      assert.strictEqual(Number(ingredients.find((i) => i.id === 'ing-tenant-2').currentStock), 2000);
    });
  });

  describe('reverseInventoryForCancelledOrder', () => {
    it('restores stock when order is cancelled before PREPARING', async () => {
      const { service, ingredients, movements } = createMockInventoryService({
        ingredients: [
          { id: 'ing-paneer', restaurantId: 'rest-uuid-1', name: 'Paneer', unit: UnitOfMeasure.GRAM, currentStock: 1600, isActive: true },
        ],
        movements: [
          {
            id: 'mov-1',
            restaurantId: 'rest-uuid-1',
            ingredientId: 'ing-paneer',
            type: StockMovementType.ORDER_CONSUMPTION,
            quantity: -400,
            balanceAfter: 1600,
            referenceOrderId: 'ORD-101',
            idempotencyKey: 'ord-deduct-ORD-101-ing-paneer',
          },
        ],
      });

      await service.reverseInventoryForCancelledOrder(
        'rest-uuid-1',
        'ORD-101',
        actor,
        'Diner cancelled before kitchen accepted',
      );

      // Stock should be restored back to 2000
      const paneer = ingredients.find((i) => i.id === 'ing-paneer');
      assert.strictEqual(Number(paneer.currentStock), 2000);

      // Reversal movement recorded
      const revMov = movements.find((m) => m.type === StockMovementType.ORDER_CANCELLATION_REVERSAL);
      assert.ok(revMov);
      assert.strictEqual(Number(revMov.quantity), 400);
      assert.strictEqual(Number(revMov.balanceAfter), 2000);
      assert.strictEqual(revMov.referenceOrderId, 'ORD-101');
    });

    it('enforces exact-once reversal idempotency on duplicate reversal call', async () => {
      const { service, ingredients, movements } = createMockInventoryService({
        ingredients: [
          { id: 'ing-paneer', restaurantId: 'rest-uuid-1', name: 'Paneer', unit: UnitOfMeasure.GRAM, currentStock: 1600, isActive: true },
        ],
        movements: [
          {
            id: 'mov-1',
            restaurantId: 'rest-uuid-1',
            ingredientId: 'ing-paneer',
            type: StockMovementType.ORDER_CONSUMPTION,
            quantity: -400,
            balanceAfter: 1600,
            referenceOrderId: 'ORD-101',
            idempotencyKey: 'ord-deduct-ORD-101-ing-paneer',
          },
        ],
      });

      // First reversal call
      await service.reverseInventoryForCancelledOrder('rest-uuid-1', 'ORD-101', actor);
      const paneerAfter1 = ingredients.find((i) => i.id === 'ing-paneer').currentStock;
      assert.strictEqual(Number(paneerAfter1), 2000);

      // Second duplicate reversal call
      await service.reverseInventoryForCancelledOrder('rest-uuid-1', 'ORD-101', actor);
      const paneerAfter2 = ingredients.find((i) => i.id === 'ing-paneer').currentStock;
      // Must NOT restore stock twice
      assert.strictEqual(Number(paneerAfter2), 2000);
      const revMovements = movements.filter((m) => m.type === StockMovementType.ORDER_CANCELLATION_REVERSAL);
      assert.strictEqual(revMovements.length, 1);
    });
  });
});
