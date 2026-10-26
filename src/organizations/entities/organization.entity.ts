// ─────────────────────────────────────────────────────────────────────────────
// src/organizations/entities/organization.entity.ts
// Multi-tenant Organization entity (Brand / Hospitality Group root)
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Restaurant } from '../../restaurants/entities/restaurant.entity.js';
import { Staff } from '../../auth/entities/staff.entity.js';

@Entity('organizations')
export class Organization {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 140 })
  name: string;

  /** Super Owner user ID who created the organization */
  @Column({ name: 'owner_id', type: 'uuid', nullable: true })
  ownerId: string | null;

  @OneToMany(() => Restaurant, (r) => r.organization)
  restaurants: Restaurant[];

  @OneToMany(() => Staff, (s) => s.organization)
  staff: Staff[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
