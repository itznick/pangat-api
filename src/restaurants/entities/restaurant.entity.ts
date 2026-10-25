// ─────────────────────────────────────────────────────────────────────────────
// src/restaurants/entities/restaurant.entity.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Table } from '../../tables/entities/table.entity.js';
import { MenuItem } from '../../menu/entities/menu-item.entity.js';
import { Order } from '../../orders/entities/order.entity.js';
import { decimalTransformer } from '../../common/transformers/decimal.transformer.js';

@Entity('restaurants')
export class Restaurant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 120 })
  name: string;

  @Column({ length: 80, unique: true })
  slug: string;

  /** UPI Virtual Payment Address */
  @Column({ name: 'upi_vpa', length: 80 })
  upiVpa: string;

  /** GST registration number */
  @Column({ name: 'gstin', type: 'varchar', length: 20, nullable: true })
  gstin: string | null;

  /** HSN / SAC code for F&B services */
  @Column({ name: 'hsn_sac', length: 10, default: '9963' })
  hsnSac: string;

  /** GST % applied at checkout — typically 5 for F&B */
  @Column({ name: 'gst_percentage', type: 'decimal', precision: 5, scale: 2, default: 5, transformer: decimalTransformer })
  gstPercentage: number;

  @Column({ name: 'is_veg_only', default: false })
  isVegOnly: boolean;

  // ── Settings flags (match /admin/settings UI) ────────────────────────────

  @Column({ name: 'kds_new_order_alert', default: true })
  kdsNewOrderAlert: boolean;

  @Column({ name: 'order_ready_chime', default: true })
  orderReadyChime: boolean;

  @Column({ name: 'out_of_stock_notification', default: true })
  outOfStockNotification: boolean;

  // ── Relations ──────────────────────────────────────────────────────────────

  @OneToMany(() => Table, (table) => table.restaurant, { cascade: true })
  tables: Table[];

  @OneToMany(() => MenuItem, (item) => item.restaurant, { cascade: true })
  menuItems: MenuItem[];

  @OneToMany(() => Order, (order) => order.restaurant)
  orders: Order[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
