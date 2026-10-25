// ─────────────────────────────────────────────────────────────────────────────
// src/auth/entities/staff.entity.ts
// Admin / owner login credentials
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum StaffRole {
  OWNER   = 'OWNER',
  MANAGER = 'MANAGER',
  CHEF    = 'CHEF',
}

@Entity('staff')
export class Staff {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 120 })
  name: string;

  @Column({ length: 180, unique: true })
  email: string;

  @Column({ name: 'password_hash', length: 255 })
  passwordHash: string;

  @Column({ type: 'enum', enum: StaffRole, default: StaffRole.OWNER })
  role: StaffRole;

  @Column({ name: 'restaurant_id', type: 'varchar', length: 50, nullable: true })
  restaurantId: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
