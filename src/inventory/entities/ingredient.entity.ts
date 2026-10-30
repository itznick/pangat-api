// ─────────────────────────────────────────────────────────────────────────────
// src/inventory/entities/ingredient.entity.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { UnitOfMeasure } from '../../common/enums/index.js';
import { Restaurant } from '../../restaurants/entities/restaurant.entity.js';
import { StockMovement } from './stock-movement.entity.js';
import { decimalTransformer } from '../../common/transformers/decimal.transformer.js';

@Entity('ingredients')
@Index(['restaurantId', 'name'], { unique: false })
export class Ingredient {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'restaurant_id', type: 'uuid' })
  restaurantId: string;

  @ManyToOne(() => Restaurant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'restaurant_id' })
  restaurant: Restaurant;

  @Column({ type: 'varchar', length: 150 })
  name: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  sku: string | null;

  @Column({
    type: 'enum',
    enum: UnitOfMeasure,
    default: UnitOfMeasure.KG,
  })
  unit: UnitOfMeasure;

  @Column({
    name: 'current_stock',
    type: 'decimal',
    precision: 12,
    scale: 3,
    default: 0.000,
    transformer: decimalTransformer,
  })
  currentStock: number;

  @Column({
    name: 'minimum_stock',
    type: 'decimal',
    precision: 12,
    scale: 3,
    default: 0.000,
    transformer: decimalTransformer,
  })
  minimumStock: number;

  @Column({
    name: 'cost_per_unit',
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0.00,
    transformer: decimalTransformer,
  })
  costPerUnit: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @VersionColumn({ default: 1 })
  version: number;

  @OneToMany(() => StockMovement, (m) => m.ingredient)
  movements: StockMovement[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt: Date;
}
