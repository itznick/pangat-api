import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import * as crypto from 'crypto';
import { Order } from './entities/order.entity.js';
import { OrderItem, SelectedModifierSnapshot } from './entities/order-item.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { Table } from '../tables/entities/table.entity.js';
import { MenuItem } from '../menu/entities/menu-item.entity.js';
import { Modifier } from '../menu/entities/modifier.entity.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  TableStatus,
  StaffRole,
} from '../common/enums/index.js';
import { EventsGateway } from '../events/events.gateway.js';

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

    // Robust table lookup supporting 'T01', '01', '1', etc.
    const rawTable = dto.tableNumber.trim().toUpperCase();
    const numOnly = rawTable.replace(/\D/g, '');
    const padded = numOnly ? `T${numOnly.padStart(2, '0')}` : rawTable;

    let table = await this.tableRepo.findOne({
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

    const finalTableNumber = table ? table.tableNumber : rawTable;

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
    const totalAmount = Math.round((subtotal + gstAmount) * 100) / 100;

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
      tableNumber: finalTableNumber,
      orderStatus: OrderStatus.RECEIVED,
      paymentStatus,
      paymentMethod: dto.paymentMethod || PaymentMethod.PAY_AT_COUNTER,
      customerPhone: dto.customerPhone || null,
      subtotal,
      gstAmount,
      totalAmount,
      idempotencyKey,
      items: orderItems,
    });

    const savedOrder = await this.orderRepo.save(order);

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
    const query = this.orderRepo
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'items')
      .leftJoinAndSelect('order.restaurant', 'restaurant')
      .where('LOWER(restaurant.slug) = :restaurantSlug', { restaurantSlug: cleanSlug });

    if (filters?.status) {
      const s = filters.status.toUpperCase();
      if (s === 'ARCHIVED') {
        query.andWhere('order.orderStatus = :completedStatus', {
          completedStatus: OrderStatus.COMPLETED,
        });
      } else if (s === 'ACTIVE') {
        query.andWhere('order.orderStatus != :completedStatus', {
          completedStatus: OrderStatus.COMPLETED,
        });
      } else if (Object.values(OrderStatus).includes(s as OrderStatus)) {
        query.andWhere('order.orderStatus = :orderStatus', { orderStatus: s });
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
        query.andWhere('order.createdAt >= :startDate', { startDate: start });
      }
    }

    if (filters?.endDate) {
      const end = new Date(filters.endDate);
      if (!isNaN(end.getTime())) {
        if (typeof filters.endDate === 'string' && !filters.endDate.includes('T')) {
          end.setHours(23, 59, 59, 999);
        }
        query.andWhere('order.createdAt <= :endDate', { endDate: end });
      }
    }

    query.orderBy('order.createdAt', 'DESC');

    if (filters?.limit && Number(filters.limit) > 0) {
      const limit = Number(filters.limit);
      const page = Math.max(1, Number(filters.page) || 1);
      query.take(limit);
      query.skip((page - 1) * limit);
    }

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
   * Secure Order Lookup for Caller:
   * 1. Staff with JWT can view full order details for their restaurant.
   * 2. Diners must supply the high-entropy tracking token (via path or query parameter).
   * 3. Prevents enumeration: unauthenticated requests without the valid tracking token receive a non-disclosing 404.
   * 4. Returns restricted, minimal diner-facing fields for public tracking.
   */
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
    return {
      id: order.id,
      trackingToken: order.trackingToken,
      tableNumber: order.tableNumber,
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
      paymentMethod: order.paymentMethod,
      subtotal: order.subtotal,
      gstAmount: order.gstAmount,
      totalAmount: order.totalAmount,
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
      rating: Number(dto.rating) || 5,
      tags: Array.isArray(dto.tags) ? dto.tags : [],
      comment: dto.comment?.trim() || undefined,
      submittedAt: new Date().toISOString(),
    };
    return this.orderRepo.save(order);
  }

  async updateStatus(id: string, status: OrderStatus, authorizedRestaurantId?: string): Promise<Order> {
    const order = await this.findOne(id);
    if (authorizedRestaurantId && order.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Order does not belong to authorized restaurant');
    }
    let restaurantSlug: string | undefined = order.restaurant?.slug;
    if (!restaurantSlug && order.restaurantId) {
      const rest = await this.restaurantRepo.findOne({ where: { id: order.restaurantId } });
      restaurantSlug = rest?.slug;
    }

    order.orderStatus = status;
    const now = new Date();
    if (status === OrderStatus.PREPARING && !order.preparingAt) {
      order.preparingAt = now;
    } else if (status === OrderStatus.READY && !order.readyAt) {
      order.readyAt = now;
    } else if (status === OrderStatus.COMPLETED && !order.completedAt) {
      order.completedAt = now;
    }
    const saved = await this.orderRepo.save(order);

    // Synchronize table status according to the full live orders state
    const table = await this.tableRepo.findOne({
      where: {
        restaurantId: order.restaurantId,
        tableNumber: order.tableNumber,
      },
    });

    if (table) {
      if (status === OrderStatus.COMPLETED) {
        // Check if there are other uncompleted orders for this table
        const remainingOpen = await this.orderRepo.findOne({
          where: {
            restaurantId: order.restaurantId,
            tableNumber: order.tableNumber,
            orderStatus: Not(OrderStatus.COMPLETED),
          },
        });
        if (!remainingOpen) {
          table.status = TableStatus.VACANT;
        } else if (remainingOpen.orderStatus === OrderStatus.READY) {
          table.status = remainingOpen.paymentStatus === PaymentStatus.PAID ? TableStatus.SERVED : TableStatus.OCCUPIED;
        } else {
          table.status = TableStatus.PREPPING;
        }
      } else if (status === OrderStatus.READY) {
        table.status = order.paymentStatus === PaymentStatus.PAID ? TableStatus.SERVED : TableStatus.OCCUPIED;
      } else if (status === OrderStatus.PREPARING || status === OrderStatus.RECEIVED) {
        table.status = TableStatus.PREPPING;
      }
      await this.tableRepo.save(table);
      if (restaurantSlug) {
        this.eventsGateway.emitTableStatus(restaurantSlug, table);
      }
    }

    // Notify diner live tracking screen, KDS & Admin rooms
    this.eventsGateway.emitOrderStatus(id, status, { ...saved, restaurant: { slug: restaurantSlug } }, restaurantSlug);

    return saved;
  }

  async markPaid(id: string, authorizedRestaurantId?: string): Promise<Order> {
    const order = await this.findOne(id);
    if (authorizedRestaurantId && order.restaurantId !== authorizedRestaurantId) {
      throw new ForbiddenException('Access denied: Order does not belong to authorized restaurant');
    }
    let restaurantSlug: string | undefined = order.restaurant?.slug;
    if (!restaurantSlug && order.restaurantId) {
      const rest = await this.restaurantRepo.findOne({ where: { id: order.restaurantId } });
      restaurantSlug = rest?.slug;
    }

    order.paymentStatus = PaymentStatus.PAID;
    order.settledAt = new Date();
    const saved = await this.orderRepo.save(order);

    // If order is paid and ready or completed, update table accordingly
    const table = await this.tableRepo.findOne({
      where: {
        restaurantId: order.restaurantId,
        tableNumber: order.tableNumber,
      },
    });

    if (table) {
      if (order.orderStatus === OrderStatus.COMPLETED) {
        const remainingOpen = await this.orderRepo.findOne({
          where: {
            restaurantId: order.restaurantId,
            tableNumber: order.tableNumber,
            orderStatus: Not(OrderStatus.COMPLETED),
          },
        });
        table.status = remainingOpen ? TableStatus.SERVED : TableStatus.VACANT;
      } else if (order.orderStatus === OrderStatus.READY) {
        table.status = TableStatus.SERVED;
      }
      await this.tableRepo.save(table);
      if (restaurantSlug) {
        this.eventsGateway.emitTableStatus(restaurantSlug, table);
      }
    }

    this.eventsGateway.emitOrderPaid(id, { ...saved, restaurant: { slug: restaurantSlug } }, restaurantSlug);

    return saved;
  }
}
