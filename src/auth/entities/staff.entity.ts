// ─────────────────────────────────────────────────────────────────────────────
// src/auth/entities/staff.entity.ts
// Multi-tenant staff & RBAC user entity
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { StaffRole } from '../../common/enums/index.js';
import { Organization } from '../../organizations/entities/organization.entity.js';
import { Restaurant } from '../../restaurants/entities/restaurant.entity.js';

export { StaffRole };

@Index('idx_staff_organization', ['organizationId'])
@Index('idx_staff_restaurant', ['restaurantId'])
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

  @Column({
    type: 'varchar',
    length: 30,
    default: StaffRole.SUPER_OWNER,
  })
  role: StaffRole;

  @Column({ name: 'is_platform_admin', type: 'boolean', default: false })
  isPlatformAdmin: boolean;

  /** Multi-tenant Organization context */
  @Column({ name: 'organization_id', type: 'uuid', nullable: true })
  organizationId: string | null;

  @ManyToOne(() => Organization, (org) => org.staff, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({ name: 'organization_id' })
  organization: Organization;

  /** Assigned outlet (null for Super Owners who manage all outlets) */
  @Column({ name: 'restaurant_id', type: 'uuid', nullable: true })
  restaurantId: string | null;

  @ManyToOne(() => Restaurant, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'restaurant_id' })
  restaurant: Restaurant;

  /** Optional 4-digit PIN for rapid tablet / station logins (e.g. kitchen chef) */
  @Column({ name: 'pin_code', type: 'varchar', length: 10, nullable: true })
  pinCode: string | null;

  @Column({ name: 'phone', type: 'varchar', length: 30, nullable: true })
  phone: string | null;

  /** bcrypt hash of the kitchen-station PIN (replaces plain-text pinCode, migrated lazily on first login) */
  @Column({ name: 'pin_hash', type: 'varchar', length: 255, nullable: true })
  pinHash: string | null;

  /** Deactivated accounts can no longer sign in or use an existing token */
  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  /** Tokens issued before this moment are rejected (set on password change / reset) */
  @Column({ name: 'password_changed_at', type: 'timestamp with time zone', nullable: true })
  passwordChangedAt: Date | null;

  @Column({ name: 'failed_login_count', type: 'int', default: 0 })
  failedLoginCount: number;

  @Column({ name: 'locked_until', type: 'timestamp with time zone', nullable: true })
  lockedUntil: Date | null;

  @Column({ name: 'last_login_at', type: 'timestamp with time zone', nullable: true })
  lastLoginAt: Date | null;

  /** Expiring single-use reset token hash for secure forgot-password flows */
  @Column({ name: 'reset_token_hash', type: 'varchar', length: 255, nullable: true })
  resetTokenHash: string | null;

  @Column({ name: 'reset_token_expires_at', type: 'timestamp with time zone', nullable: true })
  resetTokenExpiresAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt: Date;
}
