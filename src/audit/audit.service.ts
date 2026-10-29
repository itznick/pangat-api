// ─────────────────────────────────────────────────────────────────────────────
// src/audit/audit.service.ts
// ─────────────────────────────────────────────────────────────────────────────

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AuditLog } from './entities/audit-log.entity.js';
import { AuditAction } from '../common/enums/index.js';

export interface RecordAuditDto {
  restaurantId: string;
  entityType: string;
  entityId: string;
  action: AuditAction | string;
  staffId?: string | null;
  staffName?: string | null;
  staffRole?: string | null;
  reason?: string | null;
  metadata?: Record<string, any> | null;
}

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepo: Repository<AuditLog>,
  ) {}

  async record(dto: RecordAuditDto): Promise<AuditLog> {
    try {
      const entry = this.auditRepo.create({
        restaurantId: dto.restaurantId,
        entityType: dto.entityType,
        entityId: dto.entityId,
        action: dto.action,
        staffId: dto.staffId || null,
        staffName: dto.staffName || null,
        staffRole: dto.staffRole || null,
        reason: dto.reason || null,
        metadata: dto.metadata || null,
      });

      const saved = await this.auditRepo.save(entry);
      this.logger.log(
        `Audit logged: [${dto.action}] on ${dto.entityType}:${dto.entityId} by ${dto.staffRole || 'System'} (${dto.staffName || 'N/A'})`,
      );
      return saved;
    } catch (err: any) {
      this.logger.error(`Failed to record audit log: ${err.message}`, err.stack);
      throw err;
    }
  }

  async findByEntity(entityType: string, entityId: string, restaurantId?: string): Promise<AuditLog[]> {
    const where: any = { entityType, entityId };
    if (restaurantId) {
      where.restaurantId = restaurantId;
    }
    return this.auditRepo.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }
}
