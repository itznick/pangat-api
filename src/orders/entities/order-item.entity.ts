// ─────────────────────────────────────────────────────────────────────────────
// src/orders/entities/order-item.entity.ts
// Snapshot of each line item at the time of order placement.
// Modifier selections are stored as JSONB for immutability.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Order } from './order.entity.js';

export interface SelectedModifierSnapshot {
  name: string;
  price: number;
}

@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'order_id', length: 20 })
  orderId: string;

  @ManyToOne(() => Order, (o) => o.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  /** Snapshot of MenuItem.id at time of order — not a FK to allow future menu edits */
  @Column({ name: 'menu_item_id', type: 'varchar', length: 50, nullable: true })
  menuItemId: string | null;

  /** Price-locked name at order time */
  @Column({ length: 200 })
  name: string;

  /** Base price snapshot */
  @Column({ type: 'decimal', precision: 10, scale: 2 })
  price: number;

  @Column({ type: 'int', default: 1 })
  quantity: number;

  /** Locked modifier selections with their prices */
  @Column({ name: 'selected_modifiers', type: 'jsonb', default: '[]' })
  selectedModifiers: SelectedModifierSnapshot[];

  @Column({ type: 'text', nullable: true })
  notes: string | null;
}
