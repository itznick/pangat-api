import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import * as crypto from 'crypto';
import { Order } from './entities/order.entity.js';
import { OrderItem, SelectedModifierSnapshot } from './entities/order-item.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { Table } from '../tables/entities/table.entity.js';
import { MenuItem } from '../menu/entities/menu-item.entity.js';
import { Modifier } from '../menu/entities/modifier.entity.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { RegressOrderStatusDto } from './dto/regress-order-status.dto.js';
import { CancelOrderDto } from './dto/cancel-order.dto.js';
import { EditOrderItemsDto } from './dto/edit-order-items.dto.js';
import { ProcessRefundDto } from './dto/process-refund.dto.js';
import {
  OrderStatus,
  OrderType,
  PaymentMethod,
  PaymentStatus,
  TableStatus,
  StaffRole,
  AuditAction,
} from '../common/enums/index.js';
import { EventsGateway } from '../events/events.gateway.js';
import { AuditService } from '../audit/audit.service.js';
import { InventoryService } from '../inventory/inventory.service.js';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private readonly orderRepo: Repository<Order>,
    @InjectRepository(OrderItem)
    private readonly orderItemRepo: Repository<OrderItem>,
    @InjectRepository(Restaurant)
    private readonly restaurantRepo: Repository<Restaurant>,
    @InjectRepository(Table)
    private readonly tableRepo: Repository<Table>,
    @InjectRepository(MenuItem)
    private readonly menuItemRepo: Repository<MenuItem>,
    @InjectRepository(Modifier)
    private readonly modifierRepo: Repository<Modifier>,
    private readonly eventsGateway: EventsGateway,
    private readonly auditService: AuditService,
    private readonly dataSource: DataSource,
    @Optional()
    private readonly inventoryService?: InventoryService,
  ) {}

  async create(dto: CreateOrderDto, idempotencyKey: string): Promise<Order> {
    const cleanSlug = dto.restaurantSlug.trim().toLowerCase();
    const restaurant = await this.restaurantRepo.findOne({
      where: [{ slug: cleanSlug }, { slug: dto.restaurantSlug.trim() }],
    });

    if (!restaurant) {
      throw new NotFoundException(`Restaurant '${dto.restaurantSlug}' not found`);
    }

    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('Order must contain at least one item');
    }

    const orderType = dto.orderType || OrderType.DINE_IN;
    let finalTableNumber: string | null = null;
    let table: Table | null = null;

    if (orderType === OrderType.DINE_IN) {
      if (!dto.tableNumber || !dto.tableNumber.trim()) {
        throw new BadRequestException('Table number is required for dine-in orders');
      }
      const rawTable = dto.tableNumber.trim().toUpperCase();
      const numOnly = rawTable.replace(/\D/g, '');
      const padded = numOnly ? `T${numOnly.padStart(2, '0')}` : rawTable;

      table = await this.tableRepo.findOne({
        where: {
          restaurantId: restaurant.id,
          tableNumber: rawTable,
        },
      });

      if (!table && padded !== rawTable) {
        table = await this.tableRepo.findOne({
          where: {
            restaurantId: restaurant.id,
            tableNumber: padded,
          },
        });
      }

      if (!table && numOnly) {
        table = await this.tableRepo.findOne({
          where: {
            restaurantId: restaurant.id,
            tableNumber: numOnly,
          },
        });
      }

      if (!table) {
        const allTables = await this.tableRepo.find({ where: { restaurantId: restaurant.id } });
        table = allTables.find((t) => {
          const sA = t.tableNumber.trim().toUpperCase();
          const sB = rawTable;
          if (sA === sB) return true;
          const nA = sA.replace(/\D/g, '');
          const nB = sB.replace(/\D/g, '');
          if (nA && nB && Number(nA) === Number(nB)) {
            const pA = sA.replace(/\d/g, '');
            const pB = sB.replace(/\d/g, '');
            const normA = (!pA || pA === 'T') ? 'T' : pA;
            const normB = (!pB || pB === 'T') ? 'T' : pB;
            return normA === normB;
          }
          return false;
        }) || null;
      }

      if (!table) {
        throw new BadRequestException(`Table '${dto.tableNumber}' does not exist in restaurant '${restaurant.name}'`);
      }
      finalTableNumber = table.tableNumber;
    } else {
      // TAKEAWAY or DELIVERY must NOT require or assign a table
      if (dto.tableNumber && dto.tableNumber.trim()) {
        throw new BadRequestException(`Table assignment is only permitted for dine-in orders, not ${orderType}`);
      }
      finalTableNumber = null;
    }

    // Validation for Takeaway and Delivery customer details
    if (orderType === OrderType.TAKEAWAY && (!dto.customerName || !dto.customerName.trim())) {
      throw new BadRequestException('Customer name is required for takeaway / parcel pickup');
    }

    if (orderType === OrderType.DELIVERY) {
      if (!dto.customerName || !dto.customerName.trim()) {
        throw new BadRequestException('Customer name is required for delivery orders');
      }
      if (!dto.customerPhone || !dto.customerPhone.trim()) {
        throw new BadRequestException('Customer contact phone is required for delivery orders');
      }
      if (!dto.deliveryAddress || !dto.deliveryAddress.trim()) {
        throw new BadRequestException('Delivery address is required for delivery orders');
      }
    }

    // Server-Side Verification: Do NOT trust client-supplied item names, prices, or modifier amounts.
    // Reload every item and modifier from the database, check restaurant ownership & availability.
    let subtotal = 0;
    const orderItems: OrderItem[] = [];

    for (const itemDto of dto.items) {
      const menuItem = await this.menuItemRepo.findOne({
        where: { id: itemDto.menuItemId },
        relations: { modifiers: true },
      });

      if (!menuItem) {
        throw new BadRequestException(
          `Menu item with ID '${itemDto.menuItemId}' does not exist`,
        );
      }

      // Verify item belongs strictly to this restaurant
      if (menuItem.restaurantId !== restaurant.id) {
        throw new BadRequestException(
          `Menu item '${menuItem.name}' does not belong to restaurant '${restaurant.name}'`,
        );
      }

      // Verify item is currently available
      if (!menuItem.isAvailable) {
        throw new BadRequestException(
          `Item '${menuItem.name}' is currently unavailable (out of stock)`,
        );
      }

      const verifiedBasePrice = Number(menuItem.price);
      const verifiedItemName = menuItem.name;

      // Validate selected modifiers and compute verified modifier prices server-side
      let verifiedModTotal = 0;
      const verifiedSelectedModifiers: SelectedModifierSnapshot[] = [];

      if (Array.isArray(itemDto.selectedModifiers) && itemDto.selectedModifiers.length > 0) {
        const itemModifiers = menuItem.modifiers || [];
        const validOptionsMap = new Map<string, number>();

        for (const mod of itemModifiers) {
          if (Array.isArray(mod.options)) {
            for (const opt of mod.options) {
              validOptionsMap.set(opt.name.trim().toLowerCase(), Number(opt.price));
            }
          }
        }

        for (const selected of itemDto.selectedModifiers) {
          const optKey = (selected.name || '').trim().toLowerCase();
          const officialPrice = validOptionsMap.get(optKey);
          if (officialPrice === undefined) {
            throw new BadRequestException(
              `Invalid modifier selection '${selected.name}' for item '${menuItem.name}'`,
            );
          }
          verifiedModTotal += officialPrice;
          verifiedSelectedModifiers.push({
            name: selected.name,
            price: officialPrice,
          });
        }
      }

      const lineTotal = (verifiedBasePrice + verifiedModTotal) * itemDto.quantity;
      subtotal += lineTotal;

      const orderItem = this.orderItemRepo.create({
        menuItemId: menuItem.id,
        name: verifiedItemName,
        price: verifiedBasePrice,
        quantity: itemDto.quantity,
        selectedModifiers: verifiedSelectedModifiers,
        notes: itemDto.notes ? String(itemDto.notes).slice(0, 500) : null,
      });
      orderItems.push(orderItem);
    }

    const gstPct = Number(restaurant.gstPercentage || 5);
    const gstAmount = Math.round(subtotal * (gstPct / 100) * 100) / 100;

    // Server-Authoritative Delivery Fee (standard flat delivery fee if delivery order, ₹30 or configured)
    const serverDeliveryFee = orderType === OrderType.DELIVERY ? 30.00 : 0.00;
    const totalAmount = Math.round((subtotal + gstAmount + serverDeliveryFee) * 100) / 100;

    // High-Entropy IDs: Replace enumerable sequential/4-digit IDs with high-entropy tracking token
    const trackingToken = crypto.randomBytes(24).toString('hex');
    const orderId = `ORD-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

    // Security & Data Integrity: Never auto-mark orders as PAID without verified gateway confirmation.
    // Both PAY_AT_COUNTER and UPI_INSTANT initialize as PENDING until confirmed by cashier or payment webhook.
    const paymentStatus = PaymentStatus.PENDING;

    const order = this.orderRepo.create({
      id: orderId,
      trackingToken,
      restaurantId: restaurant.id,
      orderType,
      tableNumber: finalTableNumber,
      customerName: dto.customerName ? dto.customerName.trim() : null,
      customerPhone: dto.customerPhone ? dto.customerPhone.trim() : null,
      deliveryAddress: dto.deliveryAddress ? dto.deliveryAddress.trim() : null,
      deliveryInstructions: dto.deliveryInstructions ? dto.deliveryInstructions.trim() : null,
      deliveryFee: serverDeliveryFee,
      orderStatus: OrderStatus.RECEIVED,
      paymentStatus,
      paymentMethod: dto.paymentMethod || PaymentMethod.PAY_AT_COUNTER,
      subtotal,
      gstAmount,
      totalAmount,
      idempotencyKey,
      items: orderItems,
    });

    let savedOrder: Order | undefined = undefined;
    try {
      savedOrder = await this.orderRepo.save(order);

      // Concurrency-safe automatic inventory deduction when order enters RECEIVED
      if (this.inventoryService) {
        await this.inventoryService.deductInventoryForOrder(
          restaurant.id,
          savedOrder.id,
          dto.items.map((i) => ({ menuItemId: i.menuItemId, quantity: i.quantity, name: i.name })),
        );
      }
    } catch (err) {
      // Clean up order so it is not left in a misleading RECEIVED state upon inventory failure
      if (savedOrder && this.orderRepo.delete) {
        try {
          await this.orderRepo.delete({ id: savedOrder.id });
        } catch {
          // Ignore secondary cleanup error
        }
      }
      throw err;
    }

    // Update table status to PREPPING if found
    if (table) {
      table.status = TableStatus.PREPPING;
      await this.tableRepo.save(table);
      this.eventsGateway.emitTableStatus(restaurant.slug, table);
    }

    // Emit live KOT event to KDS & Admin rooms
    this.eventsGateway.emitNewOrder(restaurant.slug, {
      ...savedOrder,
      tableNumber: finalTableNumber,
      restaurant: { slug: restaurant.slug, name: restaurant.name },
    });

    return savedOrder;
  }

  async findAll(
    restaurantSlug?: string,
    filters?: {
      status?: string;
      paymentStatus?: string;
      startDate?: string;
      endDate?: string;
      page?: number;
      limit?: number;
    },
  ): Promise<Order[]> {
    if (!restaurantSlug) {
      return [];
    }

    const cleanSlug = restaurantSlug.trim().toLowerCase();
    const restaurant = await this.restaurantRepo.findOne({
      where: [{ slug: cleanSlug }, { slug: restaurantSlug.trim() }],
    });

    if (!restaurant) {
      return [];
    }

    const page = Math.max(1, filters?.page || 1);
    const limit = Math.min(100, Math.max(1, filters?.limit || 50));
    const skip = (page - 1) * limit;

    const query = this.orderRepo
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'item')
      .where('order.restaurantId = :restaurantId', { restaurantId: restaurant.id });

    if (filters?.status) {
      const s = filters.status.toUpperCase();
      if (s === 'ARCHIVED') {
        query.andWhere('order.orderStatus IN (:...archivedStatuses)', {
          archivedStatuses: [OrderStatus.COMPLETED, OrderStatus.CANCELLED],
        });
      } else if (Object.values(OrderStatus).includes(s as OrderStatus)) {
        query.andWhere('order.orderStatus = :status', { status: s });
      }
    }

    if (filters?.paymentStatus) {
      const ps = filters.paymentStatus.toUpperCase();
      if (Object.values(PaymentStatus).includes(ps as PaymentStatus)) {
        query.andWhere('order.paymentStatus = :paymentStatus', { paymentStatus: ps });
      }
    }

    if (filters?.startDate) {
      const start = new Date(filters.startDate);
      if (!isNaN(start.getTime())) {
        query.andWhere('order.createdAt >= :startDate', { startDate: start.toISOString() });
      }
    }

    if (filters?.endDate) {
      const end = new Date(filters.endDate);
      if (!isNaN(end.getTime())) {
        query.andWhere('order.createdAt <= :endDate', { endDate: end.toISOString() });
      }
    }

    query.orderBy('order.createdAt', 'DESC').skip(skip).take(limit);

    return query.getMany();
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.orderRepo.findOne({
      where: [{ id }, { trackingToken: id }],
      relations: { items: true, restaurant: true },
    });

    if (!order) {
      throw new NotFoundException(`Order '${id}' not found`);
    }

    return order;
  }

  async findOrderForCaller(
    idOrToken: string,
    tokenParam?: string,
    user?: any,
  ): Promise<any> {
    const cleanIdentifier = (idOrToken || '').trim();
    const cleanToken = (tokenParam || '').trim();

    const order = await this.orderRepo.findOne({
      where: [
        { id: cleanIdentifier },
        { trackingToken: cleanIdentifier },
        ...(cleanToken ? [{ trackingToken: cleanToken }] : []),
      ],
      relations: { items: true, restaurant: true },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    // 1. Authenticated Staff Access
    if (user) {
      const isPlatformAdmin =
        user.isPlatformAdmin === true || user.role === StaffRole.PLATFORM_SUPER_ADMIN;
      if (isPlatformAdmin) {
        return order;
      }
      if (user.restaurantId && user.restaurantId === order.restaurantId) {
        return order;
      }
      if (user.organizationId) {
        const rest = await this.restaurantRepo.findOne({ where: { id: order.restaurantId } });
        if (rest && rest.organizationId === user.organizationId) {
          return order;
        }
      }
      throw new ForbiddenException('Access denied: Unauthorized for this restaurant');
    }

    // 2. Unauthenticated Diner Tracking Access:
    // Requires exact match with high-entropy tracking token to prevent sequential/enumerable order scraping.
    const isTokenMatch =
      order.trackingToken &&
      (cleanIdentifier === order.trackingToken || cleanToken === order.trackingToken);

    if (!isTokenMatch) {
      // Non-disclosing 404 to block order enumeration attacks
      throw new NotFoundException('Order not found');
    }

    // Restricted diner-facing projection
    return this.getPublicTrackingProjection(order);
  }

  getPublicTrackingProjection(order: Order) {
    return {
      id: order.id,
      trackingToken: order.trackingToken,
      orderType: order.orderType,
      tableNumber: order.tableNumber,
      customerName: order.customerName,
      deliveryAddress: order.deliveryAddress,
      deliveryInstructions: order.deliveryInstructions,
      deliveryFee: order.deliveryFee,
      dispatchedAt: order.dispatchedAt,
      deliveredAt: order.deliveredAt,
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      subtotal: order.subtotal,
      gstAmount: order.gstAmount,
      totalAmount: order.totalAmount,
      cancellationReason: order.cancellationReason,
      refundAmount: order.refundAmount,
      createdAt: order.createdAt,
      preparingAt: order.preparingAt,
      readyAt: order.readyAt,
      settledAt: order.settledAt,
      feedback: order.feedback,
      items: (order.items || []).map((item) => ({
        name: item.name,
        quantity: item.quantity,
        price: item.price,
        selectedModifiers: item.selectedModifiers,
        notes: item.notes,
      })),
    };
  }

  async submitFeedback(
    id: string,
    dto: { rating: number; tags?: string[]; comment?: string },
  ): Promise<Order> {
    const order = await this.findOne(id);
    order.feedback = {
      rating: Math.min(5, Math.max(1, dto.rating)),
      tags: Array.isArray(dto.tags) ? dto.tags : [],
      comment: dto.comment ? String(dto.comment).slice(0, 500) : undefined,
      submittedAt: new Date().toISOString(),
    };
    return this.orderRepo.save(order);
  }

  async updateStatus(
    id: string,
    status: OrderStatus,
    authorizedRestaurantId?: string,
    staffUser?: any,
  ): Promise<Order> {
    const order = await this.findOne(id);
    if (authorizedRestaurantId && order.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Order does not belong to authorized restaurant');
    }

    // Completed and Cancelled orders are terminal
    if (order.orderStatus === OrderStatus.COMPLETED) {
      throw new BadRequestException('Cannot update status of COMPLETED order. Completed orders are immutable.');
    }
    if (order.orderStatus === OrderStatus.CANCELLED) {
      throw new BadRequestException('Cannot update status of CANCELLED order.');
    }
    if (status === OrderStatus.CANCELLED) {
      throw new BadRequestException('Use the POST /orders/:id/cancel endpoint with a mandatory cancellation reason.');
    }

    // Permitted forward progression based on orderType
    let isPermitted = false;
    if (order.orderStatus === OrderStatus.RECEIVED && status === OrderStatus.PREPARING) {
      isPermitted = true;
    } else if (order.orderStatus === OrderStatus.PREPARING && status === OrderStatus.READY) {
      isPermitted = true;
    } else if (order.orderType === OrderType.DELIVERY) {
      if (order.orderStatus === OrderStatus.READY && status === OrderStatus.DISPATCHED) {
        isPermitted = true;
      } else if (order.orderStatus === OrderStatus.DISPATCHED && status === OrderStatus.COMPLETED) {
        isPermitted = true;
      }
    } else {
      // DINE_IN and TAKEAWAY transition directly from READY to COMPLETED
      if (order.orderStatus === OrderStatus.READY && status === OrderStatus.COMPLETED) {
        isPermitted = true;
      }
    }

    if (!isPermitted) {
      throw new BadRequestException(
        `Invalid forward order status transition from ${order.orderStatus} to ${status} for order type ${order.orderType}. For ticket regressions, use the regress-status endpoint with a reason.`,
      );
    }

    // Role-based transition enforcement
    if (staffUser?.role) {
      if (status === OrderStatus.PREPARING || status === OrderStatus.READY) {
        if (![StaffRole.CHEF, StaffRole.STORE_MANAGER, StaffRole.SUPER_OWNER, StaffRole.PLATFORM_SUPER_ADMIN].includes(staffUser.role)) {
          throw new ForbiddenException(`Role ${staffUser.role} is not authorized to advance kitchen orders to ${status}`);
        }
      } else if (status === OrderStatus.DISPATCHED) {
        if (![StaffRole.STEWARD, StaffRole.STORE_MANAGER, StaffRole.SUPER_OWNER, StaffRole.PLATFORM_SUPER_ADMIN].includes(staffUser.role)) {
          throw new ForbiddenException(`Role ${staffUser.role} is not authorized to dispatch orders`);
        }
      } else if (status === OrderStatus.COMPLETED) {
        if (![StaffRole.STEWARD, StaffRole.STORE_MANAGER, StaffRole.SUPER_OWNER, StaffRole.PLATFORM_SUPER_ADMIN].includes(staffUser.role)) {
          throw new ForbiddenException(`Role ${staffUser.role} is not authorized to mark orders as ${status}`);
        }
      }
    }

    const previousStatus = order.orderStatus;
    order.orderStatus = status;
    const now = new Date();
    if (status === OrderStatus.PREPARING && !order.preparingAt) {
      order.preparingAt = now;
    } else if (status === OrderStatus.READY && !order.readyAt) {
      order.readyAt = now;
    } else if (status === OrderStatus.DISPATCHED) {
      order.dispatchedAt = now;
      order.dispatchedByStaffId = staffUser?.id || null;
    } else if (status === OrderStatus.COMPLETED) {
      order.completedAt = now;
      if (order.orderType === OrderType.DELIVERY) {
        order.deliveredAt = now;
      }
    }

    const saved = await this.orderRepo.save(order);

    // Operational audit logging
    await this.auditService.record({
      restaurantId: order.restaurantId,
      entityType: 'ORDER',
      entityId: order.id,
      action: AuditAction.ORDER_STATUS_CHANGED,
      staffId: staffUser?.id || null,
      staffName: staffUser?.name || null,
      staffRole: staffUser?.role || null,
      metadata: { previousStatus, newStatus: status },
    });

    // Synchronize table status
    let restaurantSlug: string | undefined = order.restaurant?.slug;
    if (!restaurantSlug && order.restaurantId) {
      const rest = await this.restaurantRepo.findOne({ where: { id: order.restaurantId } });
      restaurantSlug = rest?.slug;
    }
    await this.syncTableStatus(order, restaurantSlug);

    // Notify rooms
    this.eventsGateway.emitOrderStatus(id, status, { ...saved, restaurant: { slug: restaurantSlug } }, restaurantSlug);

    return saved;
  }

  async regressStatus(
    id: string,
    dto: RegressOrderStatusDto,
    authorizedRestaurantId?: string,
    staffUser?: any,
  ): Promise<Order> {
    const order = await this.findOne(id);
    if (authorizedRestaurantId && order.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Order does not belong to authorized restaurant');
    }

    if (order.orderStatus === OrderStatus.COMPLETED) {
      throw new BadRequestException('COMPLETED orders cannot be regressed.');
    }
    if (order.orderStatus === OrderStatus.CANCELLED) {
      throw new BadRequestException('CANCELLED orders cannot be regressed.');
    }

    // Rule 4: Authorized chef and manager regressions
    let isRegressionValid = false;
    if (order.orderStatus === OrderStatus.READY && dto.targetStatus === OrderStatus.PREPARING) {
      isRegressionValid = true;
    } else if (order.orderStatus === OrderStatus.PREPARING && dto.targetStatus === OrderStatus.RECEIVED) {
      isRegressionValid = true;
    } else if (order.orderStatus === OrderStatus.DISPATCHED && dto.targetStatus === OrderStatus.READY) {
      // Regressing from DISPATCHED to READY requires manager role
      if (staffUser?.role && ![StaffRole.STORE_MANAGER, StaffRole.SUPER_OWNER, StaffRole.PLATFORM_SUPER_ADMIN].includes(staffUser.role)) {
        throw new ForbiddenException('Only managers and owners can regress dispatched orders back to ready status.');
      }
      isRegressionValid = true;
    }

    if (!isRegressionValid) {
      throw new BadRequestException(
        `Invalid regression from ${order.orderStatus} to ${dto.targetStatus}.`,
      );
    }

    const previousStatus = order.orderStatus;
    order.orderStatus = dto.targetStatus;

    const saved = await this.orderRepo.save(order);

    // Operational audit log
    await this.auditService.record({
      restaurantId: order.restaurantId,
      entityType: 'ORDER',
      entityId: order.id,
      action: AuditAction.ORDER_STAGE_REGRESSED,
      staffId: staffUser?.id || null,
      staffName: staffUser?.name || null,
      staffRole: staffUser?.role || null,
      reason: dto.reason.trim(),
      metadata: { previousStatus, newStatus: dto.targetStatus },
    });

    let restaurantSlug: string | undefined = order.restaurant?.slug;
    if (!restaurantSlug && order.restaurantId) {
      const rest = await this.restaurantRepo.findOne({ where: { id: order.restaurantId } });
      restaurantSlug = rest?.slug;
    }
    await this.syncTableStatus(order, restaurantSlug);

    this.eventsGateway.emitOrderStatus(id, dto.targetStatus, { ...saved, restaurant: { slug: restaurantSlug } }, restaurantSlug);

    return saved;
  }

  async cancelOrder(
    id: string,
    dto: CancelOrderDto,
    authorizedRestaurantId?: string,
    staffUser?: any,
  ): Promise<Order> {
    const order = await this.findOne(id);
    if (authorizedRestaurantId && order.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Order does not belong to authorized restaurant');
    }

    if (order.orderStatus === OrderStatus.COMPLETED) {
      throw new BadRequestException('COMPLETED orders cannot be cancelled. Use the refund workflow for post-service corrections.');
    }
    if (order.orderStatus === OrderStatus.CANCELLED) {
      throw new BadRequestException('Order is already cancelled.');
    }

    // Rule 4: Cancelling in PREPARING or READY requires manager/owner authorization
    if (order.orderStatus === OrderStatus.PREPARING || order.orderStatus === OrderStatus.READY) {
      if (staffUser?.role && ![StaffRole.STORE_MANAGER, StaffRole.SUPER_OWNER, StaffRole.PLATFORM_SUPER_ADMIN].includes(staffUser.role)) {
        throw new ForbiddenException('Cancelling an order in PREPARING or READY stage requires manager or owner authorization.');
      }
    }

    const previousStatus = order.orderStatus;
    const previousPaymentStatus = order.paymentStatus;
    const fullReason = dto.notes ? `${dto.reason.trim()} - ${dto.notes.trim()}` : dto.reason.trim();

    order.orderStatus = OrderStatus.CANCELLED;
    order.cancellationReason = fullReason;
    order.cancelledAt = new Date();
    order.cancelledByStaffId = staffUser?.id || null;

    // Rule 2: Paid order cancellation creates a refund request (REFUND_PENDING)
    if (order.paymentStatus === PaymentStatus.PAID) {
      order.paymentStatus = PaymentStatus.REFUND_PENDING;
    } else if (order.paymentStatus === PaymentStatus.PENDING) {
      order.paymentStatus = PaymentStatus.FAILED;
    }

    const saved = await this.orderRepo.save(order);

    // Reverse stock exactly once if an order is cancelled before PREPARING.
    // After PREPARING begins, NO automatic stock restoration is permitted.
    if (previousStatus === OrderStatus.RECEIVED && this.inventoryService) {
      await this.inventoryService.reverseInventoryForCancelledOrder(
        order.restaurantId,
        order.id,
        staffUser,
        fullReason,
      );
    }

    // Audit record for cancellation
    await this.auditService.record({
      restaurantId: order.restaurantId,
      entityType: 'ORDER',
      entityId: order.id,
      action: AuditAction.ORDER_CANCELLED,
      staffId: staffUser?.id || null,
      staffName: staffUser?.name || null,
      staffRole: staffUser?.role || null,
      reason: fullReason,
      metadata: {
        previousStatus,
        newStatus: OrderStatus.CANCELLED,
        previousPaymentStatus,
        newPaymentStatus: saved.paymentStatus,
      },
    });

    if (previousPaymentStatus === PaymentStatus.PAID) {
      await this.auditService.record({
        restaurantId: order.restaurantId,
        entityType: 'ORDER',
        entityId: order.id,
        action: AuditAction.ORDER_REFUND_REQUESTED,
        staffId: staffUser?.id || null,
        staffName: staffUser?.name || null,
        staffRole: staffUser?.role || null,
        reason: `Auto refund request generated from order cancellation: ${fullReason}`,
        metadata: {
          refundableAmount: saved.totalAmount,
        },
      });
    }

    let restaurantSlug: string | undefined = order.restaurant?.slug;
    if (!restaurantSlug && order.restaurantId) {
      const rest = await this.restaurantRepo.findOne({ where: { id: order.restaurantId } });
      restaurantSlug = rest?.slug;
    }
    await this.syncTableStatus(order, restaurantSlug);

    this.eventsGateway.emitOrderStatus(id, OrderStatus.CANCELLED, { ...saved, restaurant: { slug: restaurantSlug } }, restaurantSlug);

    return saved;
  }

  async editItems(
    id: string,
    dto: EditOrderItemsDto,
    authorizedRestaurantId?: string,
    staffUser?: any,
  ): Promise<Order> {
    const order = await this.findOne(id);
    if (authorizedRestaurantId && order.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Order does not belong to authorized restaurant');
    }

    // Rule 1: Option A (Conservative): Staff can only edit items while order is in RECEIVED stage
    if (order.orderStatus === OrderStatus.PREPARING) {
      throw new BadRequestException(
        'Order items are locked once preparation has begun. Additional items must be placed as a separate linked add-on order.',
      );
    }
    if (order.orderStatus !== OrderStatus.RECEIVED) {
      throw new BadRequestException(`Order items cannot be edited while order is in ${order.orderStatus} status.`);
    }

    return this.dataSource.transaction(async (manager) => {
      const itemMap = new Map<string, MenuItem>();
      const modifierPriceMap = new Map<string, number>();

      for (const itemDto of dto.items) {
        if (!itemMap.has(itemDto.menuItemId)) {
          const menuItem = await manager.findOne(MenuItem, {
            where: { id: itemDto.menuItemId, restaurantId: order.restaurantId },
          });
          if (!menuItem) {
            throw new BadRequestException(`Menu item "${itemDto.name}" (${itemDto.menuItemId}) does not exist in this restaurant`);
          }
          if (menuItem.isAvailable === false) {
            throw new BadRequestException(`Menu item "${menuItem.name}" is currently out of stock`);
          }
          itemMap.set(itemDto.menuItemId, menuItem);
        }

        if (itemDto.selectedModifiers && itemDto.selectedModifiers.length > 0) {
          for (const mod of itemDto.selectedModifiers) {
            const modKey = `${itemDto.menuItemId}:${mod.name}`;
            if (!modifierPriceMap.has(modKey)) {
              const modifiers = await manager.find(Modifier, {
                where: { menuItemId: itemDto.menuItemId },
              });
              for (const m of modifiers) {
                if (Array.isArray(m.options)) {
                  for (const opt of m.options) {
                    modifierPriceMap.set(`${m.menuItemId}:${opt.name}`, Number(opt.price));
                  }
                }
              }
            }
          }
        }
      }

      let subtotal = 0;
      const newItems: OrderItem[] = [];

      for (const itemDto of dto.items) {
        const menuItem = itemMap.get(itemDto.menuItemId)!;
        const verifiedModifiers: SelectedModifierSnapshot[] = [];
        let itemModifiersPrice = 0;

        if (itemDto.selectedModifiers && itemDto.selectedModifiers.length > 0) {
          for (const mod of itemDto.selectedModifiers) {
            const modKey = `${itemDto.menuItemId}:${mod.name}`;
            const dbPrice = modifierPriceMap.get(modKey);
            const modPrice = dbPrice !== undefined ? dbPrice : Number(mod.price || 0);
            verifiedModifiers.push({ name: mod.name, price: modPrice });
            itemModifiersPrice += modPrice;
          }
        }

        const itemBasePrice = Number(menuItem.price);
        const itemLineTotal = (itemBasePrice + itemModifiersPrice) * itemDto.quantity;
        subtotal += itemLineTotal;

        const orderItem = manager.create(OrderItem, {
          orderId: order.id,
          menuItemId: menuItem.id,
          name: menuItem.name,
          price: itemBasePrice,
          quantity: itemDto.quantity,
          selectedModifiers: verifiedModifiers,
          notes: itemDto.notes || null,
        });
        newItems.push(orderItem);
      }

      const gstRate = 0.05;
      const gstAmount = Math.round(subtotal * gstRate * 100) / 100;
      const totalAmount = Math.round((subtotal + gstAmount) * 100) / 100;

      const previousSubtotal = order.subtotal;
      const previousTotal = order.totalAmount;
      const previousItemsCount = order.items?.length || 0;

      await manager.delete(OrderItem, { orderId: order.id });
      await manager.save(OrderItem, newItems);

      order.subtotal = subtotal;
      order.gstAmount = gstAmount;
      order.totalAmount = totalAmount;
      order.items = newItems;

      const updatedOrder = await manager.save(Order, order);

      await this.auditService.record({
        restaurantId: order.restaurantId,
        entityType: 'ORDER',
        entityId: order.id,
        action: AuditAction.ORDER_ITEMS_EDITED,
        staffId: staffUser?.id || null,
        staffName: staffUser?.name || null,
        staffRole: staffUser?.role || null,
        reason: 'Items and quantities updated by staff during RECEIVED stage',
        metadata: {
          previousSubtotal,
          newSubtotal: subtotal,
          previousTotal,
          newTotal: totalAmount,
          previousItemsCount,
          newItemsCount: newItems.length,
        },
      });

      this.eventsGateway.emitOrderUpdated(order.id, updatedOrder, updatedOrder.restaurant?.slug);

      return updatedOrder;
    });
  }

  async processRefund(
    id: string,
    dto: ProcessRefundDto,
    authorizedRestaurantId?: string,
    staffUser?: any,
  ): Promise<Order> {
    const order = await this.findOne(id);
    if (authorizedRestaurantId && order.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Order does not belong to authorized restaurant');
    }

    // Idempotency check: verify if this idempotency key was already processed
    const existingAudit = await this.auditService.findByEntity('ORDER', order.id, order.restaurantId);
    const duplicateRefund = existingAudit.find(
      (a) => a.action === AuditAction.ORDER_REFUND_SETTLED && a.metadata?.idempotencyKey === dto.idempotencyKey,
    );
    if (duplicateRefund) {
      return order; // Idempotent success without duplicate deductions
    }

    if (order.paymentStatus === PaymentStatus.REFUNDED) {
      throw new BadRequestException('Order is already fully refunded.');
    }
    if (order.paymentStatus !== PaymentStatus.REFUND_PENDING && order.paymentStatus !== PaymentStatus.PARTIALLY_REFUNDED) {
      throw new BadRequestException(
        `Cannot process refund for order with payment status ${order.paymentStatus}. Order must be in REFUND_PENDING or PARTIALLY_REFUNDED.`,
      );
    }

    const currentRefunded = Number(order.refundAmount || 0);
    const maxRefundable = Math.max(0, Number(order.totalAmount) - currentRefunded);
    const refundAmount = dto.amount !== undefined ? Number(dto.amount) : maxRefundable;

    if (refundAmount <= 0) {
      throw new BadRequestException('Refund amount must be greater than zero.');
    }
    if (refundAmount > maxRefundable) {
      throw new BadRequestException(
        `Requested refund amount ₹${refundAmount.toFixed(2)} exceeds maximum refundable amount of ₹${maxRefundable.toFixed(2)}.`,
      );
    }

    const nextTotalRefunded = currentRefunded + refundAmount;
    order.refundAmount = nextTotalRefunded;
    order.refundReason = dto.reason;
    order.refundedAt = new Date();
    order.refundedByStaffId = staffUser?.id || null;

    if (nextTotalRefunded >= Number(order.totalAmount)) {
      order.paymentStatus = PaymentStatus.REFUNDED;
    } else {
      order.paymentStatus = PaymentStatus.PARTIALLY_REFUNDED;
    }

    const saved = await this.orderRepo.save(order);

    await this.auditService.record({
      restaurantId: order.restaurantId,
      entityType: 'ORDER',
      entityId: order.id,
      action: AuditAction.ORDER_REFUND_SETTLED,
      staffId: staffUser?.id || null,
      staffName: staffUser?.name || null,
      staffRole: staffUser?.role || null,
      reason: dto.reason,
      metadata: {
        idempotencyKey: dto.idempotencyKey,
        refundMethod: dto.refundMethod,
        refundAmount,
        totalRefunded: nextTotalRefunded,
        providerReference: dto.providerReference || null,
        finalPaymentStatus: saved.paymentStatus,
      },
    });

    return saved;
  }

  async markPaid(id: string, authorizedRestaurantId?: string): Promise<Order> {
    const order = await this.findOne(id);
    if (authorizedRestaurantId && order.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Order does not belong to authorized restaurant');
    }

    if (order.orderStatus === OrderStatus.CANCELLED) {
      throw new BadRequestException('Cannot mark a CANCELLED order as paid.');
    }

    let restaurantSlug: string | undefined = order.restaurant?.slug;
    if (!restaurantSlug && order.restaurantId) {
      const rest = await this.restaurantRepo.findOne({ where: { id: order.restaurantId } });
      restaurantSlug = rest?.slug;
    }

    order.paymentStatus = PaymentStatus.PAID;
    order.settledAt = new Date();
    const saved = await this.orderRepo.save(order);

    await this.syncTableStatus(order, restaurantSlug);

    this.eventsGateway.emitOrderPaid(id, { ...saved, restaurant: { slug: restaurantSlug } }, restaurantSlug);

    return saved;
  }

  private async syncTableStatus(order: Order, restaurantSlug?: string): Promise<void> {
    // If orderType is specified and not DINE_IN, it does not affect physical tables
    if (order.orderType && order.orderType !== OrderType.DINE_IN) return;
    if (!order.tableNumber) return;

    const table = await this.tableRepo.findOne({
      where: {
        restaurantId: order.restaurantId,
        tableNumber: order.tableNumber,
      },
    });

    if (!table) return;

    const allTableOrders = await this.orderRepo.find({
      where: {
        restaurantId: order.restaurantId,
        tableNumber: order.tableNumber,
      },
    });

    const activeOrders = allTableOrders.filter(
      (o) => o.orderStatus !== OrderStatus.COMPLETED && o.orderStatus !== OrderStatus.CANCELLED,
    );

    if (activeOrders.length === 0) {
      table.status = TableStatus.VACANT;
    } else if (activeOrders.some((o) => o.orderStatus === OrderStatus.READY)) {
      const allReadyPaid = activeOrders.every((o) => o.paymentStatus === PaymentStatus.PAID);
      table.status = allReadyPaid ? TableStatus.SERVED : TableStatus.OCCUPIED;
    } else {
      table.status = TableStatus.PREPPING;
    }

    await this.tableRepo.save(table);
    if (restaurantSlug) {
      this.eventsGateway.emitTableStatus(restaurantSlug, table);
    }
  }
}
