// ─────────────────────────────────────────────────────────────────────────────
// src/menu/entities/menu-item.entity.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Restaurant } from '../../restaurants/entities/restaurant.entity.js';
import { MenuCategory } from './menu-category.entity.js';
import { Modifier } from './modifier.entity.js';
import { decimalTransformer } from '../../common/transformers/decimal.transformer.js';

@Entity('menu_items')
export class MenuItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'restaurant_id' })
  restaurantId: string;

  @ManyToOne(() => Restaurant, (r) => r.menuItems, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'restaurant_id' })
  restaurant: Restaurant;

  @Column({ name: 'category_id' })
  categoryId: string;

  @ManyToOne(() => MenuCategory, (c) => c.items, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'category_id' })
  category: MenuCategory;

  @Column({ length: 200 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** Base price in INR (stored as integer paise would be ideal, but keeping ₹ float for parity with frontend) */
  @Column({ type: 'decimal', precision: 10, scale: 2, transformer: decimalTransformer })
  price: number;

  @Column({ name: 'is_veg', default: true })
  isVeg: boolean;

  /** Mirrors frontend `isAvailable` — toggled via 86 Quick Toggle or /admin/menu switch */
  @Column({ name: 'is_available', default: true })
  isAvailable: boolean;

  @Column({ name: 'is_popular', default: false })
  isPopular: boolean;

  /** Emoji character or CDN URL used as the item thumbnail */
  @Column({ name: 'image_url', type: 'varchar', length: 20, nullable: true })
  imageUrl: string | null;

  @OneToMany(() => Modifier, (m) => m.menuItem, { cascade: true, eager: true })
  modifiers: Modifier[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
