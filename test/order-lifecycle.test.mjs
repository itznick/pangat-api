import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OrdersService } from '../dist/orders/orders.service.js';
import { OrderStatus, PaymentStatus, StaffRole, AuditAction, TableStatus } from '../dist/common/enums/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 Feature 1: Order Lifecycle, Editing, Cancellation & Refund Test Suite
// ─────────────────────────────────────────────────────────────────────────────

function createMockOrdersService(initialOrder, options = {}) {
  let currentOrder = initialOrder ? { ...initialOrder } : null;
  const auditLogs = [];
  const emittedEvents = [];

  const mockOrderRepo = {
    findOne: async ({ where }) => {
      if (!currentOrder) return null;
      const idMatch = Array.isArray(where)
        ? where.some((w) => w.id === currentOrder.id || w.trackingToken === currentOrder.trackingToken)
        : where.id === currentOrder.id;
      return idMatch ? currentOrder : null;
    },
    find: async () => (currentOrder ? [currentOrder] : []),
    save: async (order) => {
      currentOrder = { ...order };
      return currentOrder;
    },
  };

  const mockOrderItemRepo = {
    create: (dto) => ({ ...dto, id: 'item-uuid-' + Math.random().toString(36).slice(2, 6) }),
  };

  const mockRestaurantRepo = {
    findOne: async () => ({ id: 'rest-uuid-1', slug: 'pangat-pune', name: 'Pangat Pune', gstPercentage: 5 }),
  };

  let currentTable = options.table || {
    id: 'tbl-1',
    restaurantId: 'rest-uuid-1',
    tableNumber: 'T01',
    status: TableStatus.PREPPING,
  };

  const mockTableRepo = {
    findOne: async () => currentTable,
    save: async (tbl) => {
      currentTable = { ...tbl };
      return currentTable;
    },
  };

  const mockMenuItemRepo = {
    findOne: async ({ where }) => options.menuItems?.[where.id] || null,
    find: async () => Object.values(options.menuItems || {}),
  };

  const mockModifierRepo = {
    find: async () => options.modifiers || [],
  };

  const mockGateway = {
    emitOrderStatus: (orderId, status, order, slug) => emittedEvents.push({ event: 'order:status', orderId, status }),
    emitOrderUpdated: (orderId, order, slug) => emittedEvents.push({ event: 'order:updated', orderId, order }),
    emitOrderPaid: (orderId, order, slug) => emittedEvents.push({ event: 'order:paid', orderId, order }),
    emitTableStatus: (slug, table) => emittedEvents.push({ event: 'table:status', table }),
    emitNewOrder: () => {},
  };

  const mockAuditService = {
    record: async (dto) => {
      const entry = { ...dto, id: 'audit-uuid-' + Math.random().toString(36).slice(2, 6), createdAt: new Date() };
      auditLogs.push(entry);
      return entry;
    },
    findByEntity: async () => auditLogs,
  };

  const mockDataSource = {
    transaction: async (cb) => {
      const mockManager = {
        findOne: async (entity, opts) => {
          if (entity.name === 'MenuItem') {
            return options.menuItems?.[opts.where.id] || null;
          }
          if (entity.name === 'Modifier') {
            return options.modifiers?.find((m) => m.menuItemId === opts.where.menuItemId && m.name === opts.where.name) || null;
          }
          return null;
        },
        find: async (entity, opts) => {
          if (entity.name === 'Modifier') {
            return options.modifiers?.filter((m) => m.menuItemId === opts.where.menuItemId) || [];
          }
          return [];
        },
        delete: async () => {},
        create: (entity, dto) => ({ ...dto, id: 'item-uuid-' + Math.random().toString(36).slice(2, 6) }),
        save: async (entity, val) => {
          if (Array.isArray(val)) return val;
          currentOrder = { ...val };
          return currentOrder;
        },
      };
      return cb(mockManager);
    },
  };

  const service = new OrdersService(
    mockOrderRepo,
    mockOrderItemRepo,
    mockRestaurantRepo,
    mockTableRepo,
    mockMenuItemRepo,
    mockModifierRepo,
    mockGateway,
    mockAuditService,
    mockDataSource,
  );

  return {
    service,
    getOrder: () => currentOrder,
    getTable: () => currentTable,
    getAuditLogs: () => auditLogs,
    getEmittedEvents: () => emittedEvents,
  };
}

describe('Feature 1 — Suite 1: Order State Transitions & Regressions', () => {
  it('allows valid forward transitions: RECEIVED -> PREPARING -> READY -> COMPLETED', async () => {
    const initial = {
      id: 'ORD-101',
      restaurantId: 'rest-uuid-1',
      tableNumber: 'T01',
      orderStatus: OrderStatus.RECEIVED,
      paymentStatus: PaymentStatus.PENDING,
      totalAmount: 500,
    };
    const { service, getOrder, getAuditLogs } = createMockOrdersService(initial);
    const chef = { id: 'staff-1', name: 'Chef Mario', role: StaffRole.CHEF };
    const steward = { id: 'staff-2', name: 'Steward Rahul', role: StaffRole.STEWARD };

    // 1. Advance to PREPARING
    let updated = await service.updateStatus('ORD-101', OrderStatus.PREPARING, 'rest-uuid-1', chef);
    assert.equal(updated.orderStatus, OrderStatus.PREPARING);
    assert.ok(updated.preparingAt);

    // 2. Advance to READY
    updated = await service.updateStatus('ORD-101', OrderStatus.READY, 'rest-uuid-1', chef);
    assert.equal(updated.orderStatus, OrderStatus.READY);
    assert.ok(updated.readyAt);

    // 3. Advance to COMPLETED (served by steward)
    updated = await service.updateStatus('ORD-101', OrderStatus.COMPLETED, 'rest-uuid-1', steward);
    assert.equal(updated.orderStatus, OrderStatus.COMPLETED);
    assert.ok(updated.completedAt);

    assert.equal(getAuditLogs().length, 3);
    assert.equal(getAuditLogs()[0].action, AuditAction.ORDER_STATUS_CHANGED);
  });

  it('rejects jumping states forward (e.g. RECEIVED -> READY or RECEIVED -> COMPLETED)', async () => {
    const initial = {
      id: 'ORD-102',
      restaurantId: 'rest-uuid-1',
      tableNumber: 'T01',
      orderStatus: OrderStatus.RECEIVED,
    };
    const { service } = createMockOrdersService(initial);
    const chef = { id: 'staff-1', role: StaffRole.CHEF };

    await assert.rejects(
      () => service.updateStatus('ORD-102', OrderStatus.READY, 'rest-uuid-1', chef),
      (err) => err.status === 400 && /Invalid forward order status transition/.test(err.message),
    );

    await assert.rejects(
      () => service.updateStatus('ORD-102', OrderStatus.COMPLETED, 'rest-uuid-1', chef),
      (err) => err.status === 400 && /Invalid forward order status transition/.test(err.message),
    );
  });

  it('strictly locks COMPLETED orders from any further status advance or modification', async () => {
    const initial = {
      id: 'ORD-103',
      restaurantId: 'rest-uuid-1',
      tableNumber: 'T01',
      orderStatus: OrderStatus.COMPLETED,
    };
    const { service } = createMockOrdersService(initial);
    const manager = { id: 'mgr-1', role: StaffRole.STORE_MANAGER };

    await assert.rejects(
      () => service.updateStatus('ORD-103', OrderStatus.READY, 'rest-uuid-1', manager),
      (err) => err.status === 400 && /Completed orders are immutable/.test(err.message),
    );
  });

  it('allows authorized chef to regress READY -> PREPARING and PREPARING -> RECEIVED with mandatory reason', async () => {
    const initial = {
      id: 'ORD-104',
      restaurantId: 'rest-uuid-1',
      tableNumber: 'T01',
      orderStatus: OrderStatus.READY,
    };
    const { service, getOrder, getAuditLogs } = createMockOrdersService(initial);
    const chef = { id: 'staff-1', name: 'Chef Mario', role: StaffRole.CHEF };

    // 1. READY -> PREPARING
    let regressed = await service.regressStatus(
      'ORD-104',
      { targetStatus: OrderStatus.PREPARING, reason: 'Customer requested extra spicy remake' },
      'rest-uuid-1',
      chef,
    );
    assert.equal(regressed.orderStatus, OrderStatus.PREPARING);

    // 2. PREPARING -> RECEIVED
    regressed = await service.regressStatus(
      'ORD-104',
      { targetStatus: OrderStatus.RECEIVED, reason: 'Accidentally marked as cooking' },
      'rest-uuid-1',
      chef,
    );
    assert.equal(regressed.orderStatus, OrderStatus.RECEIVED);

    const regressionLogs = getAuditLogs().filter((l) => l.action === AuditAction.ORDER_STAGE_REGRESSED);
    assert.equal(regressionLogs.length, 2);
    assert.equal(regressionLogs[0].reason, 'Customer requested extra spicy remake');
    assert.equal(regressionLogs[0].staffName, 'Chef Mario');
  });

  it('rejects ticket regression on COMPLETED or CANCELLED orders', async () => {
    const completedOrder = {
      id: 'ORD-105',
      restaurantId: 'rest-uuid-1',
      tableNumber: 'T01',
      orderStatus: OrderStatus.COMPLETED,
    };
    const { service } = createMockOrdersService(completedOrder);
    const chef = { id: 'staff-1', role: StaffRole.CHEF };

    await assert.rejects(
      () => service.regressStatus('ORD-105', { targetStatus: OrderStatus.READY, reason: 'Remake' }, 'rest-uuid-1', chef),
      (err) => err.status === 400 && /COMPLETED orders cannot be regressed/.test(err.message),
    );
  });
});

describe('Feature 1 — Suite 2: Order Item Editing (Option A: Conservative)', () => {
  const menuItems = {
    'item-1': { id: 'item-1', name: 'Paneer Tikka', price: 250, isAvailable: true, restaurantId: 'rest-uuid-1' },
    'item-2': { id: 'item-2', name: 'Butter Naan', price: 40, isAvailable: true, restaurantId: 'rest-uuid-1' },
    'item-out': { id: 'item-out', name: 'Mango Lassi', price: 80, isAvailable: false, restaurantId: 'rest-uuid-1' },
  };
  const modifiers = [
    { menuItemId: 'item-1', name: 'Cheese Topping', options: [{ name: 'Cheese Topping', price: 30 }] },
  ];

  it('allows editing items and quantities strictly in RECEIVED stage, recalculating DB prices', async () => {
    const initial = {
      id: 'ORD-201',
      restaurantId: 'rest-uuid-1',
      tableNumber: 'T01',
      orderStatus: OrderStatus.RECEIVED,
      subtotal: 250,
      gstAmount: 12.5,
      totalAmount: 262.5,
      items: [{ id: 'old-1', name: 'Paneer Tikka', price: 250, quantity: 1, selectedModifiers: [] }],
    };
    const { service, getOrder, getAuditLogs } = createMockOrdersService(initial, { menuItems, modifiers });
    const steward = { id: 'staff-2', name: 'Steward Rahul', role: StaffRole.STEWARD };

    // Diner changes mind to 2x Paneer Tikka with cheese (280 ea) + 2x Butter Naan (40 ea)
    // subtotal = 2 * 280 + 2 * 40 = 560 + 80 = 640. GST 5% = 32. Total = 672
    const updated = await service.editItems(
      'ORD-201',
      {
        items: [
          {
            menuItemId: 'item-1',
            name: 'Paneer Tikka',
            price: 999, // client price ignored
            quantity: 2,
            selectedModifiers: [{ name: 'Cheese Topping', price: 0 }],
          },
          {
            menuItemId: 'item-2',
            name: 'Butter Naan',
            price: 999, // client price ignored
            quantity: 2,
            selectedModifiers: [],
          },
        ],
      },
      'rest-uuid-1',
      steward,
    );

    assert.equal(updated.subtotal, 640);
    assert.equal(updated.gstAmount, 32);
    assert.equal(updated.totalAmount, 672);
    assert.equal(updated.items.length, 2);

    const editLog = getAuditLogs().find((l) => l.action === AuditAction.ORDER_ITEMS_EDITED);
    assert.ok(editLog);
    assert.equal(editLog.metadata.newTotal, 672);
  });

  it('strictly locks item editing once PREPARING begins (Rule 1 Option A)', async () => {
    const inPrepOrder = {
      id: 'ORD-202',
      restaurantId: 'rest-uuid-1',
      tableNumber: 'T01',
      orderStatus: OrderStatus.PREPARING,
      totalAmount: 300,
    };
    const { service } = createMockOrdersService(inPrepOrder, { menuItems });
    const steward = { id: 'staff-2', role: StaffRole.STEWARD };

    await assert.rejects(
      () => service.editItems('ORD-202', { items: [{ menuItemId: 'item-1', quantity: 1 }] }, 'rest-uuid-1', steward),
      (err) => err.status === 400 && /Order items are locked once preparation has begun/.test(err.message),
    );
  });

  it('rejects editing items with an out-of-stock item', async () => {
    const initial = {
      id: 'ORD-203',
      restaurantId: 'rest-uuid-1',
      tableNumber: 'T01',
      orderStatus: OrderStatus.RECEIVED,
    };
    const { service } = createMockOrdersService(initial, { menuItems });
    const steward = { id: 'staff-2', role: StaffRole.STEWARD };

    await assert.rejects(
      () =>
        service.editItems(
          'ORD-203',
          { items: [{ menuItemId: 'item-out', name: 'Mango Lassi', quantity: 1 }] },
          'rest-uuid-1',
          steward,
        ),
      (err) => err.status === 400 && /currently out of stock/.test(err.message),
    );
  });
});

describe('Feature 1 — Suite 3: Order Cancellation & Table State Rules', () => {
  it('allows steward to cancel an unpaid order in RECEIVED stage, setting paymentStatus to FAILED', async () => {
    const initial = {
      id: 'ORD-301',
      restaurantId: 'rest-uuid-1',
      tableNumber: 'T01',
      orderStatus: OrderStatus.RECEIVED,
      paymentStatus: PaymentStatus.PENDING,
      totalAmount: 350,
    };
    const { service, getOrder, getTable, getAuditLogs } = createMockOrdersService(initial);
    const steward = { id: 'staff-2', name: 'Steward Rahul', role: StaffRole.STEWARD };

    const cancelled = await service.cancelOrder(
      'ORD-301',
      { reason: 'Customer walked out before ordering finished' },
      'rest-uuid-1',
      steward,
    );

    assert.equal(cancelled.orderStatus, OrderStatus.CANCELLED);
    assert.equal(cancelled.paymentStatus, PaymentStatus.FAILED);
    assert.ok(cancelled.cancelledAt);
    assert.equal(cancelled.cancelledByStaffId, 'staff-2');
    assert.equal(getTable().status, TableStatus.VACANT);

    const cancelLog = getAuditLogs().find((l) => l.action === AuditAction.ORDER_CANCELLED);
    assert.ok(cancelLog);
    assert.equal(cancelLog.reason, 'Customer walked out before ordering finished');
  });

  it('requires manager/owner authorization to cancel orders in PREPARING or READY stage (Rule 4)', async () => {
    const inPrepOrder = {
      id: 'ORD-302',
      restaurantId: 'rest-uuid-1',
      tableNumber: 'T01',
      orderStatus: OrderStatus.PREPARING,
      paymentStatus: PaymentStatus.PENDING,
    };
    const { service } = createMockOrdersService(inPrepOrder);
    const steward = { id: 'staff-2', role: StaffRole.STEWARD };
    const chef = { id: 'staff-1', role: StaffRole.CHEF };
    const manager = { id: 'mgr-1', name: 'Manager Priya', role: StaffRole.STORE_MANAGER };

    // Steward forbidden
    await assert.rejects(
      () => service.cancelOrder('ORD-302', { reason: 'Cancel prep' }, 'rest-uuid-1', steward),
      (err) => err.status === 403 && /requires manager or owner authorization/.test(err.message),
    );

    // Chef forbidden
    await assert.rejects(
      () => service.cancelOrder('ORD-302', { reason: 'Cancel prep' }, 'rest-uuid-1', chef),
      (err) => err.status === 403 && /requires manager or owner authorization/.test(err.message),
    );

    // Manager allowed
    const cancelled = await service.cancelOrder('ORD-302', { reason: 'Burnt dish, diner refused wait' }, 'rest-uuid-1', manager);
    assert.equal(cancelled.orderStatus, OrderStatus.CANCELLED);
  });

  it('cancelling a PAID order creates a REFUND_PENDING request and records audit record (Rule 2)', async () => {
    const paidOrder = {
      id: 'ORD-303',
      restaurantId: 'rest-uuid-1',
      tableNumber: 'T01',
      orderStatus: OrderStatus.RECEIVED,
      paymentStatus: PaymentStatus.PAID,
      totalAmount: 850,
    };
    const { service, getAuditLogs } = createMockOrdersService(paidOrder);
    const manager = { id: 'mgr-1', name: 'Manager Priya', role: StaffRole.STORE_MANAGER };

    const cancelled = await service.cancelOrder('ORD-303', { reason: 'Kitchen power outage' }, 'rest-uuid-1', manager);

    assert.equal(cancelled.orderStatus, OrderStatus.CANCELLED);
    assert.equal(cancelled.paymentStatus, PaymentStatus.REFUND_PENDING);

    const refundReqLog = getAuditLogs().find((l) => l.action === AuditAction.ORDER_REFUND_REQUESTED);
    assert.ok(refundReqLog);
    assert.equal(refundReqLog.metadata.refundableAmount, 850);
  });

  it('strictly rejects cancelling COMPLETED orders (Rule 3)', async () => {
    const completedOrder = {
      id: 'ORD-304',
      restaurantId: 'rest-uuid-1',
      tableNumber: 'T01',
      orderStatus: OrderStatus.COMPLETED,
    };
    const { service } = createMockOrdersService(completedOrder);
    const manager = { id: 'mgr-1', role: StaffRole.STORE_MANAGER };

    await assert.rejects(
      () => service.cancelOrder('ORD-304', { reason: 'Cancel after food eaten' }, 'rest-uuid-1', manager),
      (err) => err.status === 400 && /COMPLETED orders cannot be cancelled/.test(err.message),
    );
  });
});

describe('Feature 1 — Suite 4: Refund Processing & Idempotency', () => {
  it('allows manager to settle refund for REFUND_PENDING order (Rule 2)', async () => {
    const pendingRefundOrder = {
      id: 'ORD-401',
      restaurantId: 'rest-uuid-1',
      totalAmount: 500,
      refundAmount: 0,
      paymentStatus: PaymentStatus.REFUND_PENDING,
      orderStatus: OrderStatus.CANCELLED,
    };
    const { service, getOrder, getAuditLogs } = createMockOrdersService(pendingRefundOrder);
    const manager = { id: 'mgr-1', name: 'Manager Priya', role: StaffRole.STORE_MANAGER };

    const refunded = await service.processRefund(
      'ORD-401',
      {
        refundMethod: 'COUNTER_CASH',
        amount: 500,
        reason: 'Handed ₹500 cash at cashier desk',
        idempotencyKey: 'refund-idem-1',
      },
      'rest-uuid-1',
      manager,
    );

    assert.equal(refunded.paymentStatus, PaymentStatus.REFUNDED);
    assert.equal(refunded.refundAmount, 500);
    assert.ok(refunded.refundedAt);
    assert.equal(refunded.refundedByStaffId, 'mgr-1');

    const refundLog = getAuditLogs().find((l) => l.action === AuditAction.ORDER_REFUND_SETTLED);
    assert.ok(refundLog);
    assert.equal(refundLog.metadata.refundMethod, 'COUNTER_CASH');
  });

  it('supports partial refunds transitioning to PARTIALLY_REFUNDED', async () => {
    const order = {
      id: 'ORD-402',
      restaurantId: 'rest-uuid-1',
      totalAmount: 1000,
      refundAmount: 0,
      paymentStatus: PaymentStatus.REFUND_PENDING,
    };
    const { service } = createMockOrdersService(order);
    const manager = { id: 'mgr-1', role: StaffRole.STORE_MANAGER };

    const partial = await service.processRefund(
      'ORD-402',
      {
        refundMethod: 'GATEWAY_VERIFIED',
        amount: 400,
        reason: 'Partial discount refund',
        providerReference: 'razorpay_rfnd_99881',
        idempotencyKey: 'rfnd-partial-1',
      },
      'rest-uuid-1',
      manager,
    );

    assert.equal(partial.paymentStatus, PaymentStatus.PARTIALLY_REFUNDED);
    assert.equal(partial.refundAmount, 400);
  });

  it('enforces idempotency on duplicate refund requests without double deductions', async () => {
    const order = {
      id: 'ORD-403',
      restaurantId: 'rest-uuid-1',
      totalAmount: 600,
      refundAmount: 0,
      paymentStatus: PaymentStatus.REFUND_PENDING,
    };
    const { service, getOrder } = createMockOrdersService(order);
    const manager = { id: 'mgr-1', role: StaffRole.STORE_MANAGER };

    const dto = {
      refundMethod: 'COUNTER_CASH',
      amount: 600,
      reason: 'Cash refund',
      idempotencyKey: 'unique-idem-rfnd-33',
    };

    // First attempt
    await service.processRefund('ORD-403', dto, 'rest-uuid-1', manager);
    assert.equal(getOrder().refundAmount, 600);
    assert.equal(getOrder().paymentStatus, PaymentStatus.REFUNDED);

    // Duplicate replay with same idempotency key
    const replay = await service.processRefund('ORD-403', dto, 'rest-uuid-1', manager);
    assert.equal(replay.refundAmount, 600); // Not 1200!
  });

  it('rejects refund on unpaid or already fully refunded orders', async () => {
    const unpaidOrder = {
      id: 'ORD-404',
      restaurantId: 'rest-uuid-1',
      paymentStatus: PaymentStatus.PENDING,
      totalAmount: 500,
    };
    const { service } = createMockOrdersService(unpaidOrder);
    const manager = { id: 'mgr-1', role: StaffRole.STORE_MANAGER };

    await assert.rejects(
      () =>
        service.processRefund(
          'ORD-404',
          { refundMethod: 'COUNTER_CASH', amount: 500, reason: 'Invalid', idempotencyKey: 'key-err' },
          'rest-uuid-1',
          manager,
        ),
      (err) => err.status === 400 && /Cannot process refund for order with payment status PENDING/.test(err.message),
    );
  });
});
