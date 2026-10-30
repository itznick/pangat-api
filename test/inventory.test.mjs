import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InventoryService } from '../dist/inventory/inventory.service.js';
import {
  UnitOfMeasure,
  StockMovementType,
  StaffRole,
  AuditAction,
} from '../dist/common/enums/index.js';

function createMockInventoryService(initialIngredients = [], initialMovements = [], options = {}) {
  const ingredients = initialIngredients.map((i) => ({ ...i }));
  const movements = initialMovements.map((m) => ({ ...m }));
  const restaurants = options.restaurants || [
    { id: 'rest-uuid-1', slug: 'pangat-pune', name: 'Pangat Pune' },
    { id: 'rest-uuid-2', slug: 'pangat-mumbai', name: 'Pangat Mumbai' },
  ];
  const auditLogs = [];

  const createIngredientQb = () => {
    let filterRestaurantId = null;
    let filterActiveOnly = false;
    const qb = {
      where: (clause, params) => {
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
          if (where?.name && ing.name !== where.name) return false;
          if (where?.isActive !== undefined && ing.isActive !== where.isActive) return false;
          return true;
        }) || null
      );
    },
    create: (dto) => ({
      ...dto,
      id: 'ing-' + Math.random().toString(36).slice(2, 8),
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    save: async (item) => {
      const idx = ingredients.findIndex((i) => i.id === item.id);
      if (idx >= 0) {
        ingredients[idx] = { ...ingredients[idx], ...item };
        return ingredients[idx];
      } else {
        ingredients.push(item);
        return item;
      }
    },
  };

  const mockStockMovementRepo = {
    find: async ({ where } = {}) => {
      return movements.filter((m) => {
        if (where?.restaurantId && m.restaurantId !== where.restaurantId) return false;
        if (where?.ingredientId && m.ingredientId !== where.ingredientId) return false;
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
    create: (dto) => ({
      ...dto,
      id: 'mov-' + Math.random().toString(36).slice(2, 8),
      createdAt: new Date(),
    }),
    save: async (item) => {
      movements.push(item);
      return item;
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

  // Mock QueryRunner for transactions
  const createMockQueryRunner = () => {
    return {
      connect: async () => {},
      startTransaction: async () => {},
      commitTransaction: async () => {},
      rollbackTransaction: async () => {},
      release: async () => {},
      manager: {
        create: (entityClass, dto) => {
          if (entityClass.name === 'Ingredient') {
            return mockIngredientRepo.create(dto);
          }
          return mockStockMovementRepo.create(dto);
        },
        save: async (entityClassOrEntity, maybeEntity) => {
          const entity = maybeEntity !== undefined ? maybeEntity : entityClassOrEntity;
          if (Array.isArray(entity)) {
            return Promise.all(entity.map((e) => (e.unit ? mockIngredientRepo.save(e) : mockStockMovementRepo.save(e))));
          }
          if (entity.unit || entity.currentStock !== undefined) {
            return mockIngredientRepo.save(entity);
          }
          return mockStockMovementRepo.save(entity);
        },
        findOne: async (entityClass, opts) => {
          if (entityClass.name === 'StockMovement') {
            return mockStockMovementRepo.findOne(opts);
          }
          return mockIngredientRepo.findOne(opts);
        },
        createQueryBuilder: (_entityClass, _alias) => {
          let lockedId = null;
          let lockedRestaurantId = null;
          const qb = {
            setLock: () => qb,
            where: (clause, params) => {
              if (params?.id) lockedId = params.id;
              if (params?.restaurantId) lockedRestaurantId = params.restaurantId;
              return qb;
            },
            getOne: async () => {
              return (
                ingredients.find((i) => {
                  if (lockedId && i.id !== lockedId) return false;
                  if (lockedRestaurantId && i.restaurantId !== lockedRestaurantId) return false;
                  if (!i.isActive) return false;
                  return true;
                }) || null
              );
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

  const mockRecipeRepo = {
    find: async () => [],
    findOne: async () => null,
    save: async (r) => r,
  };

  const mockRecipeIngredientRepo = {
    save: async (ri) => ri,
  };

  const mockMenuItemRepo = {
    findOne: async () => null,
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
    movements,
    auditLogs,
  };
}

describe('InventoryService — Ingredient & Stock Management', () => {
  const actor = {
    id: 'staff-uuid-1',
    name: 'Chef Gordon',
    role: StaffRole.STORE_MANAGER,
    outletId: 'rest-uuid-1',
  };

  describe('createIngredient', () => {
    it('creates an ingredient with initial opening stock and records StockMovement', async () => {
      const { service, movements, auditLogs } = createMockInventoryService();

      const created = await service.createIngredient(
        'rest-uuid-1',
        {
          name: 'Paneer',
          unit: UnitOfMeasure.GRAM,
          openingStock: 5000,
          minimumStock: 1000,
          costPerUnit: 0.45,
        },
        actor,
      );

      assert.strictEqual(created.name, 'Paneer');
      assert.strictEqual(Number(created.currentStock), 5000);
      assert.strictEqual(Number(created.minimumStock), 1000);
      assert.strictEqual(created.unit, UnitOfMeasure.GRAM);

      // Verify stock movement
      assert.strictEqual(movements.length, 1);
      assert.strictEqual(movements[0].type, StockMovementType.OPENING_STOCK);
      assert.strictEqual(Number(movements[0].quantity), 5000);
      assert.strictEqual(Number(movements[0].balanceAfter), 5000);

      // Verify audit log
      assert.ok(auditLogs.some((l) => l.action === AuditAction.INGREDIENT_CREATED));
    });

    it('rejects duplicate ingredient name within the same outlet', async () => {
      const { service } = createMockInventoryService([
        {
          id: 'ing-1',
          restaurantId: 'rest-uuid-1',
          name: 'Paneer',
          unit: UnitOfMeasure.GRAM,
          currentStock: 2000,
          isActive: true,
        },
      ]);

      await assert.rejects(
        service.createIngredient(
          'rest-uuid-1',
          { name: 'Paneer', unit: UnitOfMeasure.GRAM },
          actor,
        ),
        /already exists in this outlet/i,
      );
    });
  });

  describe('adjustStock', () => {
    it('increases stock and records a MANUAL_ADJUSTMENT movement', async () => {
      const { service, movements } = createMockInventoryService([
        {
          id: 'ing-1',
          restaurantId: 'rest-uuid-1',
          name: 'Butter',
          unit: UnitOfMeasure.GRAM,
          currentStock: 1000,
          isActive: true,
        },
      ]);

      const result = await service.adjustStock(
        'ing-1',
        'rest-uuid-1',
        {
          quantityDelta: 250,
          reason: 'Physical inventory recount found excess',
        },
        actor,
      );

      assert.strictEqual(Number(result.ingredient.currentStock), 1250);
      assert.strictEqual(movements.length, 1);
      assert.strictEqual(movements[0].type, StockMovementType.MANUAL_ADJUSTMENT);
      assert.strictEqual(Number(movements[0].quantity), 250);
      assert.strictEqual(Number(movements[0].balanceAfter), 1250);
    });

    it('decreases stock and records a MANUAL_ADJUSTMENT / WASTAGE movement', async () => {
      const { service, movements } = createMockInventoryService([
        {
          id: 'ing-1',
          restaurantId: 'rest-uuid-1',
          name: 'Butter',
          unit: UnitOfMeasure.GRAM,
          currentStock: 1000,
          isActive: true,
        },
      ]);

      const result = await service.adjustStock(
        'ing-1',
        'rest-uuid-1',
        {
          quantityDelta: -300,
          reason: 'Spillage / wastage',
        },
        actor,
      );

      assert.strictEqual(Number(result.ingredient.currentStock), 700);
      assert.strictEqual(movements.length, 1);
      assert.strictEqual(Number(movements[0].quantity), -300);
      assert.strictEqual(Number(movements[0].balanceAfter), 700);
    });

    it('rejects adjustment that would result in negative stock', async () => {
      const { service } = createMockInventoryService([
        {
          id: 'ing-1',
          restaurantId: 'rest-uuid-1',
          name: 'Cream',
          unit: UnitOfMeasure.ML,
          currentStock: 500,
          isActive: true,
        },
      ]);

      await assert.rejects(
        service.adjustStock(
          'ing-1',
          'rest-uuid-1',
          {
            quantityDelta: -600,
            reason: 'Excess deduction',
          },
          actor,
        ),
        /Cannot reduce stock by 600/i,
      );
    });

    it('returns existing movement if retried with the same idempotencyKey', async () => {
      const { service } = createMockInventoryService(
        [
          {
            id: 'ing-1',
            restaurantId: 'rest-uuid-1',
            name: 'Cream',
            unit: UnitOfMeasure.ML,
            currentStock: 500,
            isActive: true,
          },
        ],
        [
          {
            id: 'mov-existing',
            restaurantId: 'rest-uuid-1',
            ingredientId: 'ing-1',
            quantity: 100,
            balanceAfter: 600,
            type: StockMovementType.MANUAL_ADJUSTMENT,
            idempotencyKey: 'idem-adj-123',
            ingredient: { id: 'ing-1', name: 'Cream', currentStock: 600 },
          },
        ],
      );

      const result = await service.adjustStock(
        'ing-1',
        'rest-uuid-1',
        { quantityDelta: 100, reason: 'Duplicate test' },
        actor,
        'idem-adj-123',
      );

      assert.strictEqual(result.movement.id, 'mov-existing');
    });
  });

  describe('receiveStock (Batch Receipt)', () => {
    it('receives multiple items atomically and updates stocks and movements', async () => {
      const { service, ingredients } = createMockInventoryService([
        {
          id: 'ing-1',
          restaurantId: 'rest-uuid-1',
          name: 'Rice',
          unit: UnitOfMeasure.KG,
          currentStock: 10,
          costPerUnit: 50,
          isActive: true,
        },
        {
          id: 'ing-2',
          restaurantId: 'rest-uuid-1',
          name: 'Oil',
          unit: UnitOfMeasure.LITRE,
          currentStock: 5,
          costPerUnit: 120,
          isActive: true,
        },
      ]);

      const result = await service.receiveStock(
        'rest-uuid-1',
        {
          invoiceNumber: 'INV-2026-001',
          supplierName: 'Metro Cash & Carry',
          items: [
            { ingredientId: 'ing-1', quantity: 25, costPerUnit: 48 },
            { ingredientId: 'ing-2', quantity: 15, costPerUnit: 115 },
          ],
        },
        actor,
      );

      assert.strictEqual(result.receivedMovements.length, 2);
      const rice = ingredients.find((i) => i.id === 'ing-1');
      const oil = ingredients.find((i) => i.id === 'ing-2');

      assert.strictEqual(Number(rice.currentStock), 35);
      assert.strictEqual(Number(rice.costPerUnit), 48); // Updates latest cost per unit
      assert.strictEqual(Number(oil.currentStock), 20);
      assert.strictEqual(Number(oil.costPerUnit), 115);
    });
  });

  describe('Low Stock Alerts', () => {
    it('returns out-of-stock and low-stock ingredients', async () => {
      const { service } = createMockInventoryService([
        {
          id: 'ing-1',
          restaurantId: 'rest-uuid-1',
          name: 'Paneer',
          currentStock: 800,
          minimumStock: 1000,
          unit: UnitOfMeasure.GRAM,
          isActive: true,
        },
        {
          id: 'ing-2',
          restaurantId: 'rest-uuid-1',
          name: 'Butter',
          currentStock: 2500,
          minimumStock: 1000,
          unit: UnitOfMeasure.GRAM,
          isActive: true,
        },
        {
          id: 'ing-3',
          restaurantId: 'rest-uuid-1',
          name: 'Salt',
          currentStock: 0,
          minimumStock: 500,
          unit: UnitOfMeasure.GRAM,
          isActive: true,
        },
      ]);

      const alerts = await service.getLowStockAlerts('rest-uuid-1');
      assert.strictEqual(alerts.lowStock.length, 1);
      assert.strictEqual(alerts.lowStock[0].name, 'Paneer');
      assert.strictEqual(alerts.outOfStock.length, 1);
      assert.strictEqual(alerts.outOfStock[0].name, 'Salt');
      assert.strictEqual(alerts.healthyCount, 1);
    });
  });

  describe('Tenant Isolation', () => {
    it('prevents cross-tenant ingredient lookup or adjustment', async () => {
      const { service } = createMockInventoryService([
        {
          id: 'ing-outlet-1',
          restaurantId: 'rest-uuid-1',
          name: 'Secret Spice',
          currentStock: 100,
          isActive: true,
        },
      ]);

      // Attempting to access from outlet 2 should throw ForbiddenException
      await assert.rejects(
        service.findIngredientById('ing-outlet-1', 'rest-uuid-2'),
        /Access denied/i,
      );

      // Attempting to adjust from outlet 2 should throw NotFoundException
      await assert.rejects(
        service.adjustStock(
          'ing-outlet-1',
          'rest-uuid-2',
          { quantityDelta: 50, reason: 'Illicit adjustment' },
          actor,
        ),
        /not found in outlet/i,
      );
    });
  });
});
