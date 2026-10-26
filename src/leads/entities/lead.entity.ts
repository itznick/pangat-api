import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { LeadStatus } from '../../common/enums/index.js';

@Entity('leads')
export class Lead {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 150 })
  name: string;

  @Column({ name: 'restaurant_name', length: 180 })
  restaurantName: string;

  @Column({ length: 40 })
  phone: string;

  @Column({ length: 100 })
  city: string;

  @Column({ name: 'table_count', type: 'varchar', length: 50, default: '10' })
  tableCount: string;

  @Column({
    type: 'varchar',
    length: 30,
    default: LeadStatus.NEW,
  })
  status: LeadStatus;

  @Column({ type: 'text', nullable: true })
  notes: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
