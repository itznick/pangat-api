// ─────────────────────────────────────────────────────────────────────────────
// src/tables/entities/table.entity.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { TableStatus } from '../../common/enums/index.js';
import { Restaurant } from '../../restaurants/entities/restaurant.entity.js';

@Entity('tables')
export class Table {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'restaurant_id' })
  restaurantId: string;

  @ManyToOne(() => Restaurant, (r) => r.tables, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'restaurant_id' })
  restaurant: Restaurant;

  /** Two-digit zero-padded number: '01' … '12' */
  @Column({ name: 'table_number', length: 10 })
  tableNumber: string;

  @Column({ name: 'qr_code_url', type: 'varchar', nullable: true, length: 255 })
  qrCodeUrl: string | null;

  @Column({
    type: 'enum',
    enum: TableStatus,
    default: TableStatus.VACANT,
  })
  status: TableStatus;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
