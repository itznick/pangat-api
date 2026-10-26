import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Not } from 'typeorm';
import { Order } from './entities/order.entity.js';
import { OrderItem } from './entities/order-item.entity.js';
import { Restaurant } from '../restaurants/entities/restaurant.entity.js';
import { Table } from '../tables/entities/table.entity.js';
import { CreateOrderDto } from './dto/create-order.dto.js';
import { OrderStatus, PaymentMethod, PaymentStatus, TableStatus } from '../common/enums/index.js';
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

    // Compute bill values
    let subtotal = 0;
    const orderItems: OrderItem[] = [];

    for (const itemDto of dto.items) {
      const modTotal = (itemDto.selectedModifiers || []).reduce(
        (sum, m) => sum + Number(m.price),
        0,
      );
      const lineTotal = (Number(itemDto.price) + modTotal) * itemDto.quantity;
      subtotal += lineTotal;

      const orderItem = this.orderItemRepo.create({
        menuItemId: itemDto.menuItemId,
        name: itemDto.name,
        price: Number(itemDto.price),
        quantity: itemDto.quantity,
        selectedModifiers: itemDto.selectedModifiers || [],
        notes: itemDto.notes || null,
      });
      orderItems.push(orderItem);
    }

    const gstPct = Number(restaurant.gstPercentage || 5);
    const gstAmount = Math.round(subtotal * (gstPct / 100) * 100) / 100;
    const totalAmount = Math.round((subtotal + gstAmount) * 100) / 100;

    const orderId = `ORD-${Math.floor(1000 + Math.random() * 9000)}`;

    const isCounter = dto.paymentMethod === PaymentMethod.PAY_AT_COUNTER;
    const paymentStatus = isCounter ? PaymentStatus.PENDING : PaymentStatus.PAID;

    const order = this.orderRepo.create({
      id: orderId,
      restaurantId: restaurant.id,
      tableNumber: finalTableNumber,
      orderStatus: OrderStatus.RECEIVED,
      paymentStatus,
      paymentMethod: dto.paymentMethod || PaymentMethod.UPI_INSTANT,
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

  async findAll(restaurantSlug?: string): Promise<Order[]> {
    if (!restaurantSlug) {
      return [];
    }

    const query = this.orderRepo
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'items')
      .leftJoinAndSelect('order.restaurant', 'restaurant')
      .where('restaurant.slug = :restaurantSlug', { restaurantSlug })
      .orderBy('order.createdAt', 'DESC');

    return query.getMany();
  }

  async findOne(id: string): Promise<Order> {
    const order = await this.orderRepo.findOne({
      where: { id },
      relations: { items: true, restaurant: true },
    });

    if (!order) {
      throw new NotFoundException(`Order '${id}' not found`);
    }

    return order;
  }

  async updateStatus(id: string, status: OrderStatus): Promise<Order> {
    const order = await this.findOne(id);
    let restaurantSlug: string | undefined = order.restaurant?.slug;
    if (!restaurantSlug && order.restaurantId) {
      const rest = await this.restaurantRepo.findOne({ where: { id: order.restaurantId } });
      restaurantSlug = rest?.slug;
    }

    order.orderStatus = status;
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

  async markPaid(id: string): Promise<Order> {
    const order = await this.findOne(id);
    let restaurantSlug: string | undefined = order.restaurant?.slug;
    if (!restaurantSlug && order.restaurantId) {
      const rest = await this.restaurantRepo.findOne({ where: { id: order.restaurantId } });
      restaurantSlug = rest?.slug;
    }

    order.paymentStatus = PaymentStatus.PAID;
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
