// ─────────────────────────────────────────────────────────────────────────────
// src/audit/entities/audit-log.entity.ts
// Immutable operational audit ledger for sensitive restaurant mutations
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
import { Restaurant } from '../../restaurants/entities/restaurant.entity.js';
import { AuditAction } from '../../common/enums/index.js';

@Entity('audit_logs')
@Index('idx_audit_logs_restaurant_entity', ['restaurantId', 'entityType', 'entityId', 'createdAt'])
export class AuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Empty for account-level events that belong to no single outlet (sign-in changes, outlet creation) */
  @Column({ name: 'restaurant_id', type: 'uuid', nullable: true })
  restaurantId: string | null;

  @ManyToOne(() => Restaurant, { onDelete: 'RESTRICT', nullable: true })
  @JoinColumn({ name: 'restaurant_id' })
  restaurant: Restaurant;

  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @Column({ name: 'actor_email', type: 'varchar', length: 180, nullable: true })
  actorEmail: string | null;

  @Column({ name: 'ip', type: 'varchar', length: 64, nullable: true })
  ip: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 255, nullable: true })
  userAgent: string | null;

  @Column({ name: 'request_id', type: 'varchar', length: 64, nullable: true })
  requestId: string | null;

  @Column({ name: 'entity_type', length: 50 })
  entityType: string;

  @Column({ name: 'entity_id', length: 100 })
  entityId: string;

  @Column({
    name: 'action',
    type: 'varchar',
    length: 50,
  })
  action: AuditAction | string;

  @Column({ name: 'staff_id', type: 'uuid', nullable: true })
  staffId: string | null;

  @Column({ name: 'staff_name', type: 'varchar', length: 100, nullable: true })
  staffName: string | null;

  @Column({ name: 'staff_role', type: 'varchar', length: 50, nullable: true })
  staffRole: string | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;
}
