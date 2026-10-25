// ─────────────────────────────────────────────────────────────────────────────
// src/menu/entities/menu-category.entity.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  Entity,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  JoinColumn,
} from 'typeorm';
import { Restaurant } from '../../restaurants/entities/restaurant.entity.js';
import { MenuItem } from './menu-item.entity.js';

@Entity('menu_categories')
export class MenuCategory {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'restaurant_id' })
  restaurantId: string;

  @ManyToOne(() => Restaurant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'restaurant_id' })
  restaurant: Restaurant;

  /** Exact display names shown in CategoryNav pill tabs */
  @Column({ length: 100 })
  name: string;

  @Column({ name: 'sort_order', default: 0 })
  sortOrder: number;

  @OneToMany(() => MenuItem, (item) => item.category)
  items: MenuItem[];
}
