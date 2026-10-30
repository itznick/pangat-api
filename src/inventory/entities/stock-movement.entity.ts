// ─────────────────────────────────────────────────────────────────────────────
// src/inventory/entities/stock-movement.entity.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { StockMovementType } from '../../common/enums/index.js';
import { Restaurant } from '../../restaurants/entities/restaurant.entity.js';
import { Staff } from '../../auth/entities/staff.entity.js';
import { Ingredient } from './ingredient.entity.js';
import { decimalTransformer } from '../../common/transformers/decimal.transformer.js';

@Entity('stock_movements')
@Index(['restaurantId', 'createdAt'])
@Index(['ingredientId', 'createdAt'])
export class StockMovement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'restaurant_id', type: 'uuid' })
  restaurantId: string;

  @ManyToOne(() => Restaurant, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'restaurant_id' })
  restaurant: Restaurant;

  @Column({ name: 'ingredient_id', type: 'uuid' })
  ingredientId: string;

  @ManyToOne(() => Ingredient, (ing) => ing.movements, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'ingredient_id' })
  ingredient: Ingredient;

  @Column({
    type: 'enum',
    enum: StockMovementType,
  })
  type: StockMovementType;

  /** Signed quantity: positive for inflow, negative for outflow */
  @Column({
    type: 'decimal',
    precision: 12,
    scale: 3,
    transformer: decimalTransformer,
  })
  quantity: number;

  @Column({
    name: 'balance_after',
    type: 'decimal',
    precision: 12,
    scale: 3,
    transformer: decimalTransformer,
  })
  balanceAfter: number;

  @Column({ type: 'varchar', length: 255 })
  reason: string;

  @Column({ name: 'reference_order_id', type: 'varchar', length: 50, nullable: true })
  referenceOrderId: string | null;

  @Column({ name: 'actor_staff_id', type: 'uuid', nullable: true })
  actorStaffId: string | null;

  @ManyToOne(() => Staff, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'actor_staff_id' })
  actor: Staff | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 100, unique: true })
  idempotencyKey: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;
}
