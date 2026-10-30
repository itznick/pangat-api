// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/entities/subscription-audit-log.entity.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('subscription_audit_logs')
@Index(['organizationId', 'createdAt'])
@Index(['idempotencyKey'], { unique: false })
export class SubscriptionAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'organization_id', type: 'uuid' })
  organizationId: string;

  @Column({ type: 'varchar', length: 100 })
  action: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  actor: string | null;

  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any> | null;

  @Column({ name: 'idempotency_key', type: 'varchar', length: 150, nullable: true })
  idempotencyKey: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
