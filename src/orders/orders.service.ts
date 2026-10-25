import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
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
    const restaurant = await this.restaurantRepo.findOne({
      where: { slug: dto.restaurantSlug },
    });

    if (!restaurant) {
      throw new NotFoundException(`Restaurant '${dto.restaurantSlug}' not found`);
    }

    if (!dto.items || dto.items.length === 0) {
      throw new BadRequestException('Order must contain at least one item');
    }

    // Find table
    const table = await this.tableRepo.findOne({
      where: {
        restaurantId: restaurant.id,
        tableNumber: dto.tableNumber,
      },
    });

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
      tableNumber: dto.tableNumber,
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

    // Update table status to PREPPING if currently VACANT or OCCUPIED
    if (table && table.status !== TableStatus.PREPPING) {
      table.status = TableStatus.PREPPING;
      await this.tableRepo.save(table);
    }

    // Emit live KOT event to KDS
    this.eventsGateway.emitNewOrder(restaurant.slug, {
      ...savedOrder,
      restaurant: { slug: restaurant.slug, name: restaurant.name },
    });

    return savedOrder;
  }

  async findAll(restaurantSlug?: string): Promise<Order[]> {
    const query = this.orderRepo
      .createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'items')
      .leftJoinAndSelect('order.restaurant', 'restaurant')
      .orderBy('order.createdAt', 'DESC');

    if (restaurantSlug) {
      query.where('restaurant.slug = :restaurantSlug', { restaurantSlug });
    }

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
    order.orderStatus = status;

    const saved = await this.orderRepo.save(order);

    // If order is completed, check if table can be marked SERVED
    if (status === OrderStatus.COMPLETED) {
      const table = await this.tableRepo.findOne({
        where: {
          restaurantId: order.restaurantId,
          tableNumber: order.tableNumber,
        },
      });
      if (table && table.status === TableStatus.PREPPING) {
        table.status = TableStatus.SERVED;
        await this.tableRepo.save(table);
      }
    }

    // Notify diner live tracking screen & KDS
    this.eventsGateway.emitOrderStatus(id, status, saved);

    return saved;
  }

  async markPaid(id: string): Promise<Order> {
    const order = await this.findOne(id);
    order.paymentStatus = PaymentStatus.PAID;

    const saved = await this.orderRepo.save(order);
    this.eventsGateway.emitOrderPaid(id, saved);

    return saved;
  }
}
