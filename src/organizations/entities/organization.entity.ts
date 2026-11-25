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

  /** Billing profile: who Pangat's tax invoices are addressed to, and where the supply is made (place of supply). All optional. */
  @Column({ name: 'billing_legal_name', type: 'varchar', length: 200, nullable: true })
  billingLegalName: string | null;

  @Column({ name: 'billing_address', type: 'text', nullable: true })
  billingAddress: string | null;

  /** GST state code of the recipient (2 digits, e.g. 27 = Maharashtra). Drives CGST+SGST (same state as the supplier) versus IGST. */
  @Column({ name: 'billing_state_code', type: 'varchar', length: 2, nullable: true })
  billingStateCode: string | null;

  @Column({ name: 'billing_gstin', type: 'varchar', length: 15, nullable: true })
  billingGstin: string | null;

  /** Account lifecycle: ACTIVE | SUSPENDED | DEACTIVATED (set by platform admins) */
  @Column({ type: 'varchar', length: 20, default: 'ACTIVE' })
  status: string;

  @Column({ name: 'status_reason', type: 'text', nullable: true })
  statusReason: string | null;

  @Column({ name: 'status_changed_at', type: 'timestamptz', nullable: true })
  statusChangedAt: Date | null;

  @Column({ name: 'status_changed_by', type: 'varchar', length: 120, nullable: true })
  statusChangedBy: string | null;

  /** UNVERIFIED | VERIFIED | REJECTED */
  @Column({ name: 'verification_status', type: 'varchar', length: 20, default: 'UNVERIFIED' })
  verificationStatus: string;

  @Column({ name: 'verified_at', type: 'timestamptz', nullable: true })
  verifiedAt: Date | null;

  @Column({ name: 'verified_by', type: 'varchar', length: 120, nullable: true })
  verifiedBy: string | null;

  @Column({ name: 'verification_note', type: 'text', nullable: true })
  verificationNote: string | null;

  @OneToMany(() => Restaurant, (r) => r.organization)
  restaurants: Restaurant[];

  @OneToMany(() => Staff, (s) => s.organization)
  staff: Staff[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
