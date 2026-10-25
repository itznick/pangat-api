// ─────────────────────────────────────────────────────────────────────────────
// src/menu/entities/modifier.entity.ts
// Modifier group (e.g. "Spice Level") with nested options stored as JSONB
// ─────────────────────────────────────────────────────────────────────────────

import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ModifierType } from '../../common/enums/index.js';
import { MenuItem } from './menu-item.entity.js';

export interface ModifierOption {
  name: string;
  price: number;
}

@Entity('modifiers')
export class Modifier {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'menu_item_id' })
  menuItemId: string;

  @ManyToOne(() => MenuItem, (item) => item.modifiers, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'menu_item_id' })
  menuItem: MenuItem;

  @Column({ length: 100 })
  name: string;

  /** SINGLE = radio (mandatory pick-one), MULTIPLE = checkbox (optional multi-select) */
  @Column({ type: 'enum', enum: ModifierType, default: ModifierType.SINGLE })
  type: ModifierType;

  @Column({ name: 'is_required', default: false })
  isRequired: boolean;

  /** Array of { name, price } option objects — stored as JSONB for flexibility */
  @Column({ type: 'jsonb', default: '[]' })
  options: ModifierOption[];
}
