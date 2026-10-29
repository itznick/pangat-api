// ─────────────────────────────────────────────────────────────────────────────
// src/orders/entities/order.entity.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
} from '../../common/enums/index.js';
import { Restaurant } from '../../restaurants/entities/restaurant.entity.js';
import { OrderItem } from './order-item.entity.js';
import { decimalTransformer } from '../../common/transformers/decimal.transformer.js';

@Entity('orders')
export class Order {
  /** Format: ORD-XXXX — set by service layer before save */
  @PrimaryColumn({ length: 20 })
  id: string;

  /** High-entropy diner tracking token for secure, non-enumerable public tracking */
  @Column({ name: 'tracking_token', type: 'varchar', length: 64, nullable: true, unique: true })
  trackingToken: string | null;

  @Column({ name: 'restaurant_id' })
  restaurantId: string;

  @ManyToOne(() => Restaurant, (r) => r.orders, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'restaurant_id' })
  restaurant: Restaurant;

  /** Two-digit table number string: '01' … '12' */
  @Column({ name: 'table_number', length: 10 })
  tableNumber: string;

  @Column({
    name: 'order_status',
    type: 'enum',
    enum: OrderStatus,
    default: OrderStatus.RECEIVED,
  })
  orderStatus: OrderStatus;

  @Column({
    name: 'payment_status',
    type: 'enum',
    enum: PaymentStatus,
    default: PaymentStatus.PENDING,
  })
  paymentStatus: PaymentStatus;

  @Column({
    name: 'payment_method',
    type: 'enum',
    enum: PaymentMethod,
    nullable: true,
  })
  paymentMethod: PaymentMethod | null;

  @Column({ name: 'customer_phone', type: 'varchar', length: 15, nullable: true })
  customerPhone: string | null;

  @Column({ name: 'subtotal', type: 'decimal', precision: 10, scale: 2, transformer: decimalTransformer })
  subtotal: number;

  @Column({ name: 'gst_amount', type: 'decimal', precision: 10, scale: 2, transformer: decimalTransformer })
  gstAmount: number;

  @Column({ name: 'total_amount', type: 'decimal', precision: 10, scale: 2, transformer: decimalTransformer })
  totalAmount: number;

  /** Customer idempotency key stored to deduplicate on replay */
  @Column({ name: 'idempotency_key', length: 100, unique: true })
  idempotencyKey: string;

  /** Timestamp when payment was settled at counter or online */
  @Column({ name: 'settled_at', type: 'timestamp with time zone', nullable: true })
  settledAt: Date | null;

  /** Stage transition timestamps for SLA and KDS duration analytics */
  @Column({ name: 'preparing_at', type: 'timestamp with time zone', nullable: true })
  preparingAt: Date | null;

  @Column({ name: 'ready_at', type: 'timestamp with time zone', nullable: true })
  readyAt: Date | null;

  @Column({ name: 'completed_at', type: 'timestamp with time zone', nullable: true })
  completedAt: Date | null;

  /** Diner feedback & rating stored as json */
  @Column({ type: 'jsonb', nullable: true })
  feedback: {
    rating: number;
    tags: string[];
    comment?: string;
    submittedAt?: Date | string;
  } | null;

  @OneToMany(() => OrderItem, (item) => item.order, {
    cascade: true,
    eager: true,
  })
  items: OrderItem[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt: Date;
}
