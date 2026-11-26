import { SlidingWindowLimiter } from '../common/security/sliding-window.js';
import { issueBillNumber, issueCreditNote } from '../billing/document-numbers.js';
import { PRIVACY_POLICY_VERSION } from '../platform/compliance.js';
import { assertPlatformMerchantAccess } from '../common/guards/platform-merchant-access.js';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Optional,
} from '@nestjs/common';
import { getOrderingStatus, resolveOperations, upiOffered } from '../restaurants/operations.js';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import * as crypto from 'crypto';
import { getSetting } from '../platform/settings.service.js';
import { decideFeature, getOrgAccess } from '../subscriptions/subscription-access.js';
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

/** Public ordering needs no sign-in, so a flood from one place must not drown an outlet's kitchen. Real service never comes near these. */
const outletOrderLimiter = new SlidingWindowLimiter(Number(process.env.PUBLIC_ORDER_BURST_PER_OUTLET) || 60, 5 * 60_000);
const tableOrderLimiter = new SlidingWindowLimiter(Number(process.env.PUBLIC_ORDER_BURST_PER_TABLE) || 6, 5 * 60_000);

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

  /**
   * What the guest asked for, reduced to what matters and hashed: the same idempotency key with the same request is a retry
   * (the original order is returned); the same key with a DIFFERENT request is a conflict. Prices and names sent by the client
   * are ignored (the server recomputes them), so they never affect the hash.
   */
  static requestHashOf(dto: CreateOrderDto): string {
    const norm = {
      r: String(dto.restaurantSlug || '').trim().toLowerCase(),
      t: dto.orderType || OrderType.DINE_IN,
      tb: String(dto.tableNumber || '').trim().toUpperCase(),
      n: String(dto.customerName || '').trim(),
      p: String(dto.customerPhone || '').trim(),
      a: String(dto.deliveryAddress || '').trim(),
      i: String(dto.deliveryInstructions || '').trim(),
      pm: dto.paymentMethod || null,
      items: (dto.items || []).map((i) => ({
        m: i.menuItemId,
        q: i.quantity,
        mods: (i.selectedModifiers || []).map((x) => String(x.name || '').trim().toLowerCase()).sort(),
        n: String(i.notes || '').trim(),
      })),
    };
    return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex');
  }

  private async replayOrConflict(already: Order, dto: CreateOrderDto, hash: string): Promise<Order> {
    const outlet = await this.restaurantRepo.findOne({ where: { id: already.restaurantId } });
    const sameOutlet = Boolean(outlet && outlet.slug === dto.restaurantSlug.trim().toLowerCase());
    const sameRequest = !already.requestHash || already.requestHash === hash; // orders from before request hashing have none
    if (sameOutlet && sameRequest) return already;
    throw new ConflictException({
      message: 'This idempotency key was already used for a different request. Start a new order to send different items.',
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  }

  async create(dto: CreateOrderDto, idempotencyKey: string): Promise<Order> {
    const requestHash = OrdersService.requestHashOf(dto);
    // Retried request (flaky network, double tap): hand back the order that was already created
    const already = await this.orderRepo.findOne({ where: { idempotencyKey }, relations: { items: true } });
    if (already) return this.replayOrConflict(already, dto, requestHash);
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

    // Flood protection (see limiter definitions above)
    const tooBusy = () => new HttpException('This outlet is receiving a very high number of orders right now. Please ask a staff member to take your order.', HttpStatus.TOO_MANY_REQUESTS);
    if (!outletOrderLimiter.allow(restaurant.id)) throw tooBusy();
    if (dto.tableNumber && !tableOrderLimiter.allow(`${restaurant.id}:${String(dto.tableNumber).trim().toUpperCase()}`)) throw tooBusy();

    // Platform-wide switch (incident response) and per-restaurant feature access
    if (getSetting<boolean>('general.publicOrderingEnabled') === false) {
      throw new BadRequestException('Ordering is temporarily unavailable. Please ask the staff for help.');
    }
    // Platform feature switch for QR ordering (global kill switch or a per-restaurant override)
    if (restaurant.organizationId) {
      // QR ordering is a plan feature (plan + platform kill switch + per-restaurant override), decided by the shared resolver
      const q = await decideFeature(this.dataSource, restaurant.organizationId, 'QR_ORDERING');
      if (!q.allowed) throw new BadRequestException('This outlet is not taking orders right now. Please ask the staff for help.');
    }
    // A lapsed subscription closes the outlet to new guest orders until the owner renews
    if (restaurant.organizationId) {
      const access = await getOrgAccess(this.dataSource, restaurant.organizationId);
      if (access.blocked) {
        throw new BadRequestException('This outlet is not taking orders right now. Please ask the staff for help.');
      }
    }

    // Operating rules: pause switch, opening hours, and which order types / payments are offered
    const ordering = getOrderingStatus(restaurant.operations);
    if (!ordering.accepting) {
      throw new BadRequestException(ordering.message || 'This outlet is not taking orders right now');
    }
    const ops = resolveOperations(restaurant.operations);

    const orderType = dto.orderType || OrderType.DINE_IN;
    if (
      (orderType === OrderType.DINE_IN && !ops.orderTypes.dineIn) ||
      (orderType === OrderType.TAKEAWAY && !ops.orderTypes.takeaway) ||
      (orderType === OrderType.DELIVERY && !ops.orderTypes.delivery)
    ) {
      throw new BadRequestException('This order type is not available at this outlet right now');
    }
    // UPI needs the outlet's setting ON *and* an owner-confirmed UPI ID: without either, there is nowhere safe to send the guest's money
    if (dto.paymentMethod === PaymentMethod.UPI_INSTANT && !upiOffered(restaurant)) {
      throw new BadRequestException('UPI payment is not available at this outlet right now. Please choose another payment method.');
    }
    if (
      (dto.paymentMethod === PaymentMethod.UPI_INSTANT && !ops.payments.upi) ||
      (dto.paymentMethod === PaymentMethod.PAY_AT_COUNTER && !ops.payments.payAtCounter) ||
      (dto.paymentMethod === PaymentMethod.COD && !ops.payments.cod)
    ) {
      throw new BadRequestException('This payment method is not accepted at this outlet');
    }
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
    // DPDP: personal details are only collected from someone who has accepted the privacy notice, and we keep the proof
    const hasPersonalData = Boolean(dto.customerName?.trim() || dto.customerPhone?.trim() || dto.deliveryAddress?.trim());
    if (hasPersonalData && dto.consentAccepted !== true) {
      throw new BadRequestException('Please accept the Privacy Notice to continue. We use your name and phone only to prepare and deliver your order.');
    }
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
      if (dto.paymentMethod === PaymentMethod.PAY_AT_COUNTER) {
        throw new BadRequestException('Pay at counter is not available for delivery orders. Please select UPI or Cash on Delivery (COD).');
      }
    } else {
      if (dto.paymentMethod === PaymentMethod.COD) {
        throw new BadRequestException('Cash on Delivery (COD) is only available for delivery orders.');
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

    // 0% GST is a legitimate setting (e.g. unregistered outlets): only fall back when the value is missing
    const gstPct = Number(restaurant.gstPercentage ?? 5);
    const gstAmount = Math.round(subtotal * (gstPct / 100) * 100) / 100;
    const serviceChargePct = Number(restaurant.serviceChargePercentage ?? 0);
    const serviceChargeAmount = Math.round(subtotal * (serviceChargePct / 100) * 100) / 100;

    // Server-Authoritative Delivery Fee (standard flat delivery fee if delivery order, ₹30 or configured)
    const serverDeliveryFee = orderType === OrderType.DELIVERY ? 30.00 : 0.00;
    const totalAmount = Math.round((subtotal + gstAmount + serviceChargeAmount + serverDeliveryFee) * 100) / 100;

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
      consentVersion: hasPersonalData ? PRIVACY_POLICY_VERSION : null,
      consentAt: hasPersonalData ? new Date() : null,
      customerName: dto.customerName ? dto.customerName.trim() : null,
      customerPhone: dto.customerPhone ? dto.customerPhone.trim() : null,
      deliveryAddress: dto.deliveryAddress ? dto.deliveryAddress.trim() : null,
      deliveryInstructions: dto.deliveryInstructions ? dto.deliveryInstructions.trim() : null,
      deliveryFee: serverDeliveryFee,
      orderStatus: OrderStatus.RECEIVED,
      paymentStatus,
      paymentMethod: dto.paymentMethod || (orderType === OrderType.DELIVERY ? PaymentMethod.COD : PaymentMethod.PAY_AT_COUNTER),
      subtotal,
      gstAmount,
      serviceChargeAmount,
      totalAmount,
      refundAmount: 0.00,
      idempotencyKey,
      requestHash,
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
      // A concurrent duplicate of the same request lost the race on the UNIQUE key: return the winner
      if ((err as any)?.code === '23505' && String((err as any)?.detail || '').includes('idempotency_key')) {
        const winner = await this.orderRepo.findOne({ where: { idempotencyKey }, relations: { items: true } });
        if (winner) return this.replayOrConflict(winner, dto, requestHash);
      }
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

  /**
   * The printable tax invoice for one order, computed from the stored amounts (never recomputed from today's menu or rates).
   * Same access rules as the order itself: staff of the outlet, or the diner holding the tracking token. The kitchen role never gets bills.
   */
  async getBill(idOrToken: string, token: string | undefined, user?: any) {
    if (user && user.role === StaffRole.CHEF && !user.isPlatformAdmin) {
      throw new ForbiddenException('Bills are not available to the kitchen role');
    }
    const order: any = await this.findOrderForCaller(idOrToken, token, user);
    const r = order.restaurant ?? (await this.restaurantRepo.findOne({ where: { id: order.restaurantId } }));
    const money = (n: unknown) => Math.round(Number(n || 0) * 100) / 100;
    const taxable = money(order.subtotal);
    const gst = money(order.gstAmount);
    const cgst = money(gst / 2); // intra-state supply: the GST is split equally between CGST and SGST
    const creditNotes = await this.orderRepo.manager.query(
      `SELECT number, amount, reason, issued_at AS "issuedAt" FROM tax_documents WHERE order_id = $1 AND kind = 'CREDIT_NOTE' ORDER BY issued_at ASC`,
      [order.id],
    );
    return {
      status: order.billNumber ? 'ISSUED' : 'PROVISIONAL',
      billNumber: order.billNumber ?? null,
      issuedAt: order.billIssuedAt ?? null,
      restaurant: {
        name: r?.name, branchArea: r?.branchArea ?? null, phone: r?.phone ?? null,
        gstin: r?.gstin ?? null, fssaiLicense: r?.fssaiLicense ?? null, hsnSac: r?.hsnSac || '9963',
      },
      order: { id: order.id, type: order.orderType, table: order.tableNumber ?? null, createdAt: order.createdAt, customerName: order.customerName ?? null },
      items: (order.items || []).map((i: any) => {
        const mods = Array.isArray(i.selectedModifiers) ? i.selectedModifiers : [];
        const unit = money(Number(i.price) + mods.reduce((a: number, m: any) => a + Number(m.price || 0), 0));
        return { name: i.name, quantity: Number(i.quantity), unitPrice: unit, amount: money(unit * Number(i.quantity)), modifiers: mods.map((m: any) => m.name) };
      }),
      taxableValue: taxable,
      gst: { ratePercent: taxable > 0 ? Math.round((gst / taxable) * 10000) / 100 : 0, cgst, sgst: money(gst - cgst), total: gst },
      serviceCharge: money(order.serviceChargeAmount),
      deliveryFee: money(order.deliveryFee),
      total: money(order.totalAmount),
      payment: { method: order.paymentMethod, status: order.paymentStatus, settledAt: order.settledAt ?? null },
      refundedAmount: money(order.refundAmount),
      creditNotes: creditNotes.map((c: any) => ({ number: c.number, amount: money(c.amount), reason: c.reason, issuedAt: c.issuedAt })),
    };
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
        assertPlatformMerchantAccess(user, 'GET');
        return order;
      }
      if (user.restaurantId && user.restaurantId === order.restaurantId) {
        return order;
      }
      if (user.role === StaffRole.SUPER_OWNER && user.organizationId) {
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
    return this.getPublicTrackingProjection(order, order.restaurant);
  }

  getPublicTrackingProjection(order: Order, outlet?: Restaurant | null) {
    return {
      /**
       * Where a guest may pay by UPI: THIS outlet's own owner-confirmed ID, or null. There is no default and no fallback, so a screen
       * that gets null must show no UPI payment option at all. The guest paying does NOT make the order paid: staff confirm receipt.
       */
      payee: outlet && upiOffered(outlet) && order.paymentStatus === PaymentStatus.PENDING && order.orderStatus !== OrderStatus.CANCELLED
        ? { vpa: outlet.upiVpa, name: outlet.name }
        : null,
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
      serviceChargeAmount: order.serviceChargeAmount,
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

  /** Diner review. The caller must present the order's private tracking token (the same secret that opens the tracker). */
  async submitFeedback(
    id: string,
    dto: { rating: number; tags?: string[]; comment?: string },
    token?: string,
    expectedRestaurantId?: string,
  ): Promise<Order> {
    const order = await this.findOne(id);
    const given = (token || '').trim();
    const ok =
      Boolean(order.trackingToken) &&
      given.length === order.trackingToken!.length &&
      crypto.timingSafeEqual(Buffer.from(given), Buffer.from(order.trackingToken!));
    if (!ok || (expectedRestaurantId && order.restaurantId !== expectedRestaurantId)) {
      throw new NotFoundException('Order not found'); // non-disclosing
    }
    if (order.orderStatus === OrderStatus.CANCELLED) {
      throw new BadRequestException('Cancelled orders cannot be reviewed');
    }
    const rating = Number(dto.rating);
    if (!Number.isFinite(rating)) throw new BadRequestException('A rating from 1 to 5 is required');
    order.feedback = {
      rating: Math.min(5, Math.max(1, Math.round(rating))),
      tags: Array.isArray(dto.tags) ? dto.tags.slice(0, 8).map((t) => String(t).slice(0, 40)) : [],
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

    const fullReason = dto.notes ? `${dto.reason.trim()} - ${dto.notes.trim()}` : dto.reason.trim();
    let previousStatus = order.orderStatus;

    // The order change and its audit records are ONE transaction decided on the LOCKED row: a cancellation racing a payment
    // (or a second cancel) sees the other's result, and can never exist without its record.
    const saved = await this.orderRepo.manager.transaction(async (em) => {
      const locked = await this.lockOrder(em, order.id);
      if (locked.orderStatus === OrderStatus.COMPLETED) {
        throw new BadRequestException('COMPLETED orders cannot be cancelled. Use the refund workflow for post-service corrections.');
      }
      if (locked.orderStatus === OrderStatus.CANCELLED) {
        throw new BadRequestException('Order is already cancelled.');
      }
      // Rule 4: Cancelling in PREPARING or READY requires manager/owner authorization
      if (locked.orderStatus === OrderStatus.PREPARING || locked.orderStatus === OrderStatus.READY) {
        if (staffUser?.role && ![StaffRole.STORE_MANAGER, StaffRole.SUPER_OWNER, StaffRole.PLATFORM_SUPER_ADMIN].includes(staffUser.role)) {
          throw new ForbiddenException('Cancelling an order in PREPARING or READY stage requires manager or owner authorization.');
        }
      }
      previousStatus = locked.orderStatus;
      const previousPaymentStatus = locked.paymentStatus;

      locked.orderStatus = OrderStatus.CANCELLED;
      locked.cancellationReason = fullReason;
      locked.cancelledAt = new Date();
      locked.cancelledByStaffId = staffUser?.id || null;
      // Rule 2: Paid order cancellation creates a refund request (REFUND_PENDING)
      if (locked.paymentStatus === PaymentStatus.PAID) {
        locked.paymentStatus = PaymentStatus.REFUND_PENDING;
      } else if (locked.paymentStatus === PaymentStatus.PENDING) {
        locked.paymentStatus = PaymentStatus.FAILED;
      }

      const persisted = await em.getRepository(Order).save(locked);
      await this.auditService.record({
        restaurantId: locked.restaurantId,
        entityType: 'ORDER',
        entityId: locked.id,
        action: AuditAction.ORDER_CANCELLED,
        staffId: staffUser?.id || null,
        staffName: staffUser?.name || null,
        staffRole: staffUser?.role || null,
        staffEmail: staffUser?.email || null,
        reason: fullReason,
        metadata: {
          previousStatus,
          newStatus: OrderStatus.CANCELLED,
          previousPaymentStatus,
          newPaymentStatus: persisted.paymentStatus,
          totalAmount: persisted.totalAmount,
        },
      }, em);
      if (previousPaymentStatus === PaymentStatus.PAID) {
        await this.auditService.record({
          restaurantId: locked.restaurantId,
          entityType: 'ORDER',
          entityId: locked.id,
          action: AuditAction.ORDER_REFUND_REQUESTED,
          staffId: staffUser?.id || null,
          staffName: staffUser?.name || null,
          staffRole: staffUser?.role || null,
          staffEmail: staffUser?.email || null,
          reason: `Auto refund request generated from order cancellation: ${fullReason}`,
          metadata: { refundableAmount: persisted.totalAmount },
        }, em);
      }
      return persisted;
    });

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

    // A paid bill has a legal number and a tax amount: it must not change. Cancel it (which starts a refund and a credit note)
    // and place a new order, or add the extra items as a separate order.
    if (order.paymentStatus === PaymentStatus.PAID || order.billNumber) {
      throw new BadRequestException('This bill is already paid and numbered, so its items cannot be changed. Cancel it for a refund and place a new order, or add the extra items as a separate order.');
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

      // Snapshot previous items for exact delta inventory adjustment
      const previousOrderItems = (order.items || []).map((i) => ({
        menuItemId: i.menuItemId || '',
        quantity: i.quantity,
        name: i.name,
      }));

      // Server-Authoritative Tax Calculation from Restaurant Configuration
      const restaurant = await manager.findOne(Restaurant, { where: { id: order.restaurantId } });
      const gstPct = Number(restaurant?.gstPercentage ?? 5);
      const gstAmount = Math.round(subtotal * (gstPct / 100) * 100) / 100;

      // Preserve Server Delivery Fee for delivery orders
      const deliveryFee = Number(order.deliveryFee || 0);
      // Keep the service charge the order was priced with at creation (rate changes do not re-price open orders)
      const serviceChargeRate = Number(order.serviceChargeAmount || 0) > 0 && Number(order.subtotal) > 0
        ? Number(order.serviceChargeAmount) / Number(order.subtotal)
        : 0;
      const serviceChargeAmount = Math.round(subtotal * serviceChargeRate * 100) / 100;
      const totalAmount = Math.round((subtotal + gstAmount + serviceChargeAmount + deliveryFee) * 100) / 100;

      const previousSubtotal = order.subtotal;
      const previousTotal = order.totalAmount;
      const previousItemsCount = order.items?.length || 0;

      // Adjust inventory by quantity difference only (no duplicate deductions or ghost balances)
      if (this.inventoryService) {
        await this.inventoryService.adjustInventoryForOrderEdit(
          order.restaurantId,
          order.id,
          previousOrderItems,
          newItems.map((i) => ({ menuItemId: i.menuItemId!, quantity: i.quantity, name: i.name })),
          staffUser,
        );
      }

      await manager.delete(OrderItem, { orderId: order.id });
      await manager.save(OrderItem, newItems);

      order.subtotal = subtotal;
      order.gstAmount = gstAmount;
      order.serviceChargeAmount = serviceChargeAmount;
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
    const requestHash = crypto
      .createHash('sha256')
      .update(JSON.stringify({ m: dto.refundMethod, a: dto.amount ?? null, r: String(dto.reason || '').trim(), p: String(dto.providerReference || '').trim() }))
      .digest('hex');

    // ONE transaction: lock the order, claim the idempotency key in the database, re-check the refundable amount on the locked row,
    // issue the credit note, update the order and write the audit record. Two simultaneous requests are serialised by the lock, and the
    // UNIQUE (order_id, idempotency_key) constraint makes "one refund per key" a database fact. A rolled-back request leaves no credit note
    // number, no refund row and no audit record behind.
    return this.orderRepo.manager.transaction(async (em) => {
      const locked = await this.lockOrder(em, order.id);

      // Idempotent replay: the key was already used on this order
      const prior = (await em.query('SELECT request_hash FROM order_refunds WHERE order_id = $1 AND idempotency_key = $2', [locked.id, dto.idempotencyKey]))[0];
      if (prior) {
        if (prior.request_hash !== requestHash) {
          throw new ConflictException({
            message: 'This refund key was already used for a different refund (amount, method or reason). Use a new request to refund again.',
            code: 'IDEMPOTENCY_KEY_REUSED',
          });
        }
        return locked; // same key, same refund: the original result, nothing new happens
      }

      if (locked.paymentStatus === PaymentStatus.REFUNDED) {
        throw new BadRequestException('Order is already fully refunded.');
      }
      if (locked.paymentStatus !== PaymentStatus.REFUND_PENDING && locked.paymentStatus !== PaymentStatus.PARTIALLY_REFUNDED) {
        throw new BadRequestException(
          `Cannot process refund for order with payment status ${locked.paymentStatus}. Order must be in REFUND_PENDING or PARTIALLY_REFUNDED.`,
        );
      }

      const currentRefunded = Number(locked.refundAmount || 0);
      const maxRefundable = Math.max(0, Math.round((Number(locked.totalAmount) - currentRefunded) * 100) / 100);
      const refundAmount = dto.amount !== undefined ? Math.round(Number(dto.amount) * 100) / 100 : maxRefundable;
      if (refundAmount <= 0) {
        throw new BadRequestException('Refund amount must be greater than zero.');
      }
      if (refundAmount > maxRefundable) {
        throw new BadRequestException(
          `Requested refund amount ₹${refundAmount.toFixed(2)} exceeds maximum refundable amount of ₹${maxRefundable.toFixed(2)}.`,
        );
      }

      // Claim the key (a concurrent duplicate cannot get past the lock above, and the constraint is the second line of defence)
      const claimed = await em.query(
        `INSERT INTO order_refunds (order_id, restaurant_id, idempotency_key, request_hash, method, amount, reason, provider_reference, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (order_id, idempotency_key) DO NOTHING RETURNING id`,
        [locked.id, locked.restaurantId, dto.idempotencyKey, requestHash, dto.refundMethod, refundAmount, dto.reason, dto.providerReference || null, staffUser?.id || null],
      );
      if (!claimed.length) return locked; // lost a race that the lock should have prevented: the winner's result stands

      const nextTotalRefunded = Math.round((currentRefunded + refundAmount) * 100) / 100;
      locked.refundAmount = nextTotalRefunded;
      locked.refundReason = dto.reason;
      locked.refundedAt = new Date();
      locked.refundedByStaffId = staffUser?.id || null;
      locked.paymentStatus = nextTotalRefunded >= Number(locked.totalAmount) ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED;

      // Money going back needs a credit note that refers to the original bill (CGST Rule 53), numbered in its own series
      const creditNoteNumber = await issueCreditNote(em, locked, refundAmount, dto.reason, staffUser);
      await em.query('UPDATE order_refunds SET credit_note_number = $1 WHERE id = $2', [creditNoteNumber, claimed[0].id]);
      const persisted = await em.getRepository(Order).save(locked);
      await this.auditService.record({
        restaurantId: locked.restaurantId,
        entityType: 'ORDER',
        entityId: locked.id,
        action: AuditAction.ORDER_REFUND_SETTLED,
        staffId: staffUser?.id || null,
        staffName: staffUser?.name || null,
        staffRole: staffUser?.role || null,
        staffEmail: staffUser?.email || null,
        reason: dto.reason,
        metadata: {
          idempotencyKey: dto.idempotencyKey,
          creditNoteNumber,
          billNumber: locked.billNumber,
          refundMethod: dto.refundMethod,
          refundAmount,
          totalRefunded: nextTotalRefunded,
          providerReference: dto.providerReference || null,
          finalPaymentStatus: persisted.paymentStatus,
        },
      }, em);
      return persisted;
    });
  }

  /**
   * Take a row lock on the order for the rest of the transaction and return its CURRENT committed state (with items and outlet).
   * Every money or lifecycle decision is made on this row, after the lock, so two simultaneous requests (two cashiers, a double tap,
   * a retry) are serialised and the second one sees what the first did. FOR NO KEY UPDATE is the same mode Phase 1 uses elsewhere:
   * it does not block foreign-key checks from related inserts. (TypeORM's version column does not reject a stale save by itself.)
   */
  private async lockOrder(em: EntityManager, id: string): Promise<Order> {
    await em.query('SELECT 1 FROM orders WHERE id = $1 FOR NO KEY UPDATE', [id]);
    const locked = await em.getRepository(Order).findOne({ where: { id }, relations: { items: true, restaurant: true } });
    if (!locked) throw new NotFoundException(`Order '${id}' not found`);
    return locked;
  }

  async markPaid(id: string, authorizedRestaurantId?: string, actor?: any): Promise<Order> {
    const order = await this.findOne(id);
    if (authorizedRestaurantId && order.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Order does not belong to authorized restaurant');
    }

    if (order.orderStatus === OrderStatus.CANCELLED) {
      throw new BadRequestException('Cannot mark a CANCELLED order as paid.');
    }
    // Separation of duties: a steward takes orders; settling money is the cashier's, manager's or owner's job
    // unless this outlet has deliberately allowed it (Settings → Operations).
    if (actor?.role === StaffRole.STEWARD) {
      const outlet = await this.restaurantRepo.findOne({ where: { id: order.restaurantId } });
      if (!resolveOperations(outlet?.operations).stewardCanSettle) {
        throw new ForbiddenException('Settling a bill is limited to the cashier, manager or owner at this outlet.');
      }
    }
    // Everything below is decided on the order row AFTER taking its lock (see lockOrder): payment state, bill number and audit are one atomic unit
    let replay = false;
    let restaurantSlug: string | undefined = order.restaurant?.slug;
    const saved = await this.orderRepo.manager.transaction(async (em) => {
      const locked = await this.lockOrder(em, order.id);
      restaurantSlug = locked.restaurant?.slug ?? restaurantSlug;
      if (locked.orderStatus === OrderStatus.CANCELLED) {
        throw new BadRequestException('Cannot mark a CANCELLED order as paid.');
      }
      // Idempotent: a second tap, a retry or another cashier arriving second gets the first result: no new bill, no new event
      if (locked.paymentStatus === PaymentStatus.PAID) {
        replay = true;
        return locked;
      }
      if (
        locked.paymentStatus === PaymentStatus.REFUNDED ||
        locked.paymentStatus === PaymentStatus.PARTIALLY_REFUNDED ||
        locked.paymentStatus === PaymentStatus.REFUND_PENDING
      ) {
        throw new BadRequestException('This order has already been refunded and cannot be marked as paid.');
      }
      const previous = locked.paymentStatus;
      locked.paymentStatus = PaymentStatus.PAID;
      locked.settledAt = new Date();
      // The legal bill number is issued with the payment, in the same transaction (see billing/document-numbers.ts)
      await issueBillNumber(em, locked, actor, locked.settledAt);
      const persisted = await em.getRepository(Order).save(locked);
      await this.auditService.record({
        restaurantId: locked.restaurantId,
        entityType: 'ORDER',
        entityId: locked.id,
        action: 'PAYMENT_MARKED_PAID',
        staffId: actor?.id,
        staffName: actor?.name,
        staffRole: actor?.role,
        staffEmail: actor?.email,
        metadata: { from: previous, method: locked.paymentMethod, amount: locked.totalAmount, billNumber: locked.billNumber },
      }, em);
      return persisted;
    });
    if (replay) return saved;

    if (!restaurantSlug && order.restaurantId) {
      const rest = await this.restaurantRepo.findOne({ where: { id: order.restaurantId } });
      restaurantSlug = rest?.slug;
    }
    await this.syncTableStatus(saved, restaurantSlug);

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
