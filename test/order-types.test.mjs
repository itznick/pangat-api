import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { OrdersService } from '../dist/orders/orders.service.js';
import {
  OrderType,
  OrderStatus,
  PaymentStatus,
  StaffRole,
  TableStatus,
} from '../dist/common/enums/index.js';

function createMockOrdersService(initialOrders = [], options = {}) {
  const orders = Array.isArray(initialOrders) ? [...initialOrders] : [initialOrders];
  const auditLogs = [];
  const emittedEvents = [];

  const tables = options.tables || [
    { id: 'tbl-1', restaurantId: 'rest-uuid-1', tableNumber: 'T01', status: TableStatus.VACANT },
    { id: 'tbl-2', restaurantId: 'rest-uuid-1', tableNumber: 'T02', status: TableStatus.VACANT },
  ];

  const mockOrderRepo = {
    findOne: async ({ where }) => {
      const match = orders.find((o) => {
        if (Array.isArray(where)) {
          return where.some((w) => (w.id && o.id === w.id) || (w.trackingToken && o.trackingToken === w.trackingToken));
        }
        if (where.id) return o.id === where.id;
        if (where.trackingToken) return o.trackingToken === where.trackingToken;
        return false;
      });
      return match ? { ...match } : null;
    },
    find: async ({ where }) => {
      return orders.filter((o) => {
        if (where.restaurantId && o.restaurantId !== where.restaurantId) return false;
        if (where.tableNumber && o.tableNumber !== where.tableNumber) return false;
        return true;
      });
    },
    create: (dto) => ({ ...dto, id: 'ORD-' + Math.random().toString(36).slice(2, 6).toUpperCase() }),
    save: async (order) => {
      const idx = orders.findIndex((o) => o.id === order.id);
      if (idx >= 0) {
        orders[idx] = { ...order };
      } else {
        orders.push({ ...order });
      }
      return { ...order };
    },
  };

  const mockOrderItemRepo = {
    create: (dto) => ({ ...dto, id: 'item-uuid-' + Math.random().toString(36).slice(2, 6) }),
  };

  const mockRestaurantRepo = {
    findOne: async () => ({ id: 'rest-uuid-1', slug: 'pangat-pune', name: 'Pangat Pune', gstPercentage: 5 }),
  };

  const mockTableRepo = {
    findOne: async ({ where }) => {
      return tables.find((t) => t.restaurantId === where.restaurantId && t.tableNumber === where.tableNumber) || null;
    },
    find: async ({ where }) => {
      return tables.filter((t) => t.restaurantId === where.restaurantId);
    },
    save: async (tbl) => {
      const t = tables.find((item) => item.id === tbl.id);
      if (t) Object.assign(t, tbl);
      return t;
    },
  };

  const mockMenuItemRepo = {
    findOne: async ({ where }) => options.menuItems?.[where.id] || null,
    find: async () => Object.values(options.menuItems || {}),
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
      auditLogs.push(dto);
      return dto;
    },
    findByEntity: async () => auditLogs,
  };

  const mockDataSource = {
    transaction: async (cb) => cb({ findOne: mockMenuItemRepo.findOne, find: async () => [] }),
  };

  const service = new OrdersService(
    mockOrderRepo,
    mockOrderItemRepo,
    mockRestaurantRepo,
    mockTableRepo,
    mockMenuItemRepo,
    null,
    mockGateway,
    mockAuditService,
    mockDataSource,
  );

  return { service, orders, tables, auditLogs, emittedEvents };
}

describe('Feature 2 — Suite 1: Order Types & Table Assignment Validation', () => {
  const menuItems = {
    'item-1': { id: 'item-1', restaurantId: 'rest-uuid-1', name: 'Thali Special', price: 250, isAvailable: true, modifiers: [] },
  };

  it('creates DINE_IN order successfully when referencing a valid outlet table', async () => {
    const { service, tables } = createMockOrdersService([], { menuItems });
    const order = await service.create({
      restaurantSlug: 'pangat-pune',
      orderType: OrderType.DINE_IN,
      tableNumber: 'T01',
      items: [{ menuItemId: 'item-1', name: 'Thali Special', price: 250, quantity: 2 }],
    }, 'idem-101');

    assert.equal(order.orderType, OrderType.DINE_IN);
    assert.equal(order.tableNumber, 'T01');
    assert.equal(order.deliveryFee, 0);
    assert.equal(order.subtotal, 500);
    assert.equal(order.totalAmount, 525); // 500 + 5% GST = 525
    assert.equal(tables.find((t) => t.tableNumber === 'T01').status, TableStatus.PREPPING);
  });

  it('rejects DINE_IN order when table number is missing or does not exist in outlet', async () => {
    const { service } = createMockOrdersService([], { menuItems });
    
    await assert.rejects(
      () =>
        service.create({
          restaurantSlug: 'pangat-pune',
          orderType: OrderType.DINE_IN,
          tableNumber: '',
          items: [{ menuItemId: 'item-1', name: 'Thali Special', price: 250, quantity: 1 }],
        }, 'idem-102'),
      (err) => err.status === 400 && /Table number is required/.test(err.message),
    );

    await assert.rejects(
      () =>
        service.create({
          restaurantSlug: 'pangat-pune',
          orderType: OrderType.DINE_IN,
          tableNumber: 'T99_INVALID',
          items: [{ menuItemId: 'item-1', name: 'Thali Special', price: 250, quantity: 1 }],
        }, 'idem-103'),
      (err) => err.status === 400 && /does not exist/.test(err.message),
    );
  });

  it('creates TAKEAWAY order with pickup customer name and does not require or assign a table', async () => {
    const { service, tables } = createMockOrdersService([], { menuItems });
    const order = await service.create({
      restaurantSlug: 'pangat-pune',
      orderType: OrderType.TAKEAWAY,
      customerName: 'Aarav Patel',
      items: [{ menuItemId: 'item-1', name: 'Thali Special', price: 250, quantity: 1 }],
    }, 'idem-104');

    assert.equal(order.orderType, OrderType.TAKEAWAY);
    assert.equal(order.customerName, 'Aarav Patel');
    assert.equal(order.tableNumber, null);
    assert.equal(order.deliveryFee, 0);
    // Verifies physical tables remain VACANT
    assert.ok(tables.every((t) => t.status === TableStatus.VACANT));
  });

  it('rejects TAKEAWAY order if client attempts to assign a table number', async () => {
    const { service } = createMockOrdersService([], { menuItems });
    await assert.rejects(
      () =>
        service.create({
          restaurantSlug: 'pangat-pune',
          orderType: OrderType.TAKEAWAY,
          customerName: 'Aarav Patel',
          tableNumber: 'T01',
          items: [{ menuItemId: 'item-1', name: 'Thali Special', price: 250, quantity: 1 }],
        }, 'idem-105'),
      (err) => err.status === 400 && /Table assignment is only permitted for dine-in/.test(err.message),
    );
  });
});

describe('Feature 2 — Suite 2: Delivery Workflow, Verification & Fee Security', () => {
  const menuItems = {
    'item-1': { id: 'item-1', restaurantId: 'rest-uuid-1', name: 'Thali Special', price: 200, isAvailable: true, modifiers: [] },
  };

  it('creates DELIVERY order with server-calculated delivery fee and required contact information', async () => {
    const { service } = createMockOrdersService([], { menuItems });
    const order = await service.create({
      restaurantSlug: 'pangat-pune',
      orderType: OrderType.DELIVERY,
      customerName: 'Meera Sharma',
      customerPhone: '+919876543210',
      deliveryAddress: 'Flat 402, Sunshine Heights, Pune',
      deliveryInstructions: 'Ring doorbell twice',
      items: [{ menuItemId: 'item-1', name: 'Thali Special', price: 200, quantity: 2 }],
    }, 'idem-201');

    assert.equal(order.orderType, OrderType.DELIVERY);
    assert.equal(order.customerName, 'Meera Sharma');
    assert.equal(order.customerPhone, '+919876543210');
    assert.equal(order.deliveryAddress, 'Flat 402, Sunshine Heights, Pune');
    assert.equal(order.deliveryFee, 30.00);
    // Subtotal = 400, GST 5% = 20, Delivery Fee = 30 -> Total = 450
    assert.equal(order.subtotal, 400);
    assert.equal(order.gstAmount, 20);
    assert.equal(order.totalAmount, 450);
    assert.equal(order.paymentStatus, PaymentStatus.PENDING);
  });

  it('rejects DELIVERY order if missing customer address or contact phone', async () => {
    const { service } = createMockOrdersService([], { menuItems });
    await assert.rejects(
      () =>
        service.create({
          restaurantSlug: 'pangat-pune',
          orderType: OrderType.DELIVERY,
          customerName: 'Meera Sharma',
          deliveryAddress: '', // missing
          items: [{ menuItemId: 'item-1', name: 'Thali Special', price: 200, quantity: 1 }],
        }, 'idem-202'),
      (err) => err.status === 400 && /Customer contact phone is required/.test(err.message),
    );
  });

  it('redacts sensitive customer personal data from public tracking projection', () => {
    const { service } = createMockOrdersService();
    const mockOrder = {
      id: 'ORD-SEC-01',
      trackingToken: 'tok_abc123',
      orderType: OrderType.DELIVERY,
      customerName: 'Meera Sharma',
      customerPhone: '+919876543210',
      deliveryAddress: 'Flat 402, Sunshine Heights, Pune',
      deliveryFee: 30,
      orderStatus: OrderStatus.RECEIVED,
      paymentStatus: PaymentStatus.PENDING,
      subtotal: 400,
      gstAmount: 20,
      totalAmount: 450,
      items: [],
    };

    const projection = service.getPublicTrackingProjection(mockOrder);
    assert.equal(projection.customerName, 'Meera Sharma');
    // Verifies phone is masked to protect diner privacy: +919876543210 -> **********3210
    // Verifies phone is stripped from public projection to protect diner privacy
    assert.equal(projection.customerPhone, undefined);
    assert.equal(projection.deliveryFee, 30);
  });
});

describe('Feature 2 — Suite 3: Fulfillment State Machine & Roles', () => {
  it('follows Delivery lifecycle: RECEIVED -> PREPARING -> READY -> DISPATCHED -> COMPLETED', async () => {
    const initial = {
      id: 'ORD-DEL-01',
      restaurantId: 'rest-uuid-1',
      orderType: OrderType.DELIVERY,
      orderStatus: OrderStatus.READY,
      paymentStatus: PaymentStatus.PENDING,
    };
    const { service, orders } = createMockOrdersService(initial);
    const steward = { id: 'steward-1', name: 'Rohan', role: StaffRole.STEWARD };
    const manager = { id: 'mgr-1', name: 'Priya', role: StaffRole.STORE_MANAGER };

    // 1. Dispatch order
    const dispatched = await service.updateStatus('ORD-DEL-01', OrderStatus.DISPATCHED, 'rest-uuid-1', steward);
    assert.equal(dispatched.orderStatus, OrderStatus.DISPATCHED);
    assert.ok(dispatched.dispatchedAt);
    assert.equal(dispatched.dispatchedByStaffId, 'steward-1');
    // Does NOT auto-mark as paid
    assert.equal(dispatched.paymentStatus, PaymentStatus.PENDING);

    // 2. Mark Delivered
    const delivered = await service.updateStatus('ORD-DEL-01', OrderStatus.COMPLETED, 'rest-uuid-1', manager);
    assert.equal(delivered.orderStatus, OrderStatus.COMPLETED);
    assert.ok(delivered.deliveredAt);
    assert.equal(delivered.paymentStatus, PaymentStatus.PENDING);
  });

  it('rejects skipping DISPATCHED stage directly to COMPLETED for Delivery orders', async () => {
    const initial = {
      id: 'ORD-DEL-02',
      restaurantId: 'rest-uuid-1',
      orderType: OrderType.DELIVERY,
      orderStatus: OrderStatus.READY,
      paymentStatus: PaymentStatus.PENDING,
    };
    const { service } = createMockOrdersService(initial);
    const manager = { id: 'mgr-1', name: 'Priya', role: StaffRole.STORE_MANAGER };

    await assert.rejects(
      () => service.updateStatus('ORD-DEL-02', OrderStatus.COMPLETED, 'rest-uuid-1', manager),
      (err) => err.status === 400 && /Invalid forward order status transition/.test(err.message),
    );
  });

  it('allows manager to regress DISPATCHED delivery order back to READY with mandatory reason', async () => {
    const initial = {
      id: 'ORD-DEL-03',
      restaurantId: 'rest-uuid-1',
      orderType: OrderType.DELIVERY,
      orderStatus: OrderStatus.DISPATCHED,
      paymentStatus: PaymentStatus.PENDING,
    };
    const { service } = createMockOrdersService(initial);
    const manager = { id: 'mgr-1', name: 'Priya', role: StaffRole.STORE_MANAGER };

    const regressed = await service.regressStatus('ORD-DEL-03', {
      targetStatus: OrderStatus.READY,
      reason: 'Rider bike punctured, waiting for replacement rider',
    }, 'rest-uuid-1', manager);

    assert.equal(regressed.orderStatus, OrderStatus.READY);
  });

  it('allows Takeaway order to complete handover from READY to COMPLETED', async () => {
    const initial = {
      id: 'ORD-TAK-01',
      restaurantId: 'rest-uuid-1',
      orderType: OrderType.TAKEAWAY,
      orderStatus: OrderStatus.READY,
      paymentStatus: PaymentStatus.PENDING,
    };
    const { service } = createMockOrdersService(initial);
    const steward = { id: 'steward-1', name: 'Rohan', role: StaffRole.STEWARD };

    const collected = await service.updateStatus('ORD-TAK-01', OrderStatus.COMPLETED, 'rest-uuid-1', steward);
    assert.equal(collected.orderStatus, OrderStatus.COMPLETED);
    assert.ok(collected.completedAt);
  });
});
