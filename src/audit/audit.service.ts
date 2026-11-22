// ─────────────────────────────────────────────────────────────────────────────
// src/audit/audit.service.ts
// ─────────────────────────────────────────────────────────────────────────────

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, Repository } from 'typeorm';
import { currentRequest } from '../common/request-context.js';
import { AuditLog } from './entities/audit-log.entity.js';
import { AuditAction } from '../common/enums/index.js';

export interface RecordAuditDto {
  /** Omit for account-level events that belong to no single outlet; give organizationId instead */
  restaurantId?: string | null;
  organizationId?: string | null;
  entityType: string;
  entityId: string;
  action: AuditAction | string;
  staffId?: string | null;
  staffName?: string | null;
  staffRole?: string | null;
  staffEmail?: string | null;
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

  /**
   * Append one audit entry. Pass the transaction's EntityManager to write it in the SAME transaction as the change it
   * describes: either both are saved or neither is. Throws on failure so a money-affecting action is never left without its record.
   * Who/where/which-request are taken from the current request automatically.
   */
  async record(dto: RecordAuditDto, manager?: EntityManager): Promise<AuditLog> {
    const repo = manager ? manager.getRepository(AuditLog) : this.auditRepo;
    const ctx = currentRequest();
    try {
      const entry = repo.create({
        restaurantId: dto.restaurantId || null,
        organizationId: dto.organizationId || null,
        entityType: dto.entityType,
        entityId: dto.entityId,
        action: dto.action,
        staffId: dto.staffId || null,
        staffName: dto.staffName || null,
        staffRole: dto.staffRole || null,
        actorEmail: dto.staffEmail || null,
        reason: dto.reason || null,
        metadata: dto.metadata || null,
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
        requestId: ctx?.requestId ?? null,
      });
      const saved = await repo.save(entry);
      // No names or emails in application logs: ids only (the audit table itself holds the identity)
      this.logger.log(`Audit [${dto.action}] ${dto.entityType}:${dto.entityId} by ${dto.staffRole || 'System'}:${dto.staffId || '-'} req=${ctx?.requestId ?? '-'}`);
      return saved;
    } catch (err: any) {
      this.logger.error(`AUDIT WRITE FAILED [${dto.action}] ${dto.entityType}:${dto.entityId}: ${err.message}`, err.stack);
      throw err;
    }
  }

  /** An outlet's history, plus (when organizationId is given) the account-level events of its organization. */
  async list(restaurantId: string, q: { entityType?: string; action?: string; page: number; limit: number }, organizationId?: string | null) {
    const limit = Math.min(100, Math.max(1, q.limit || 50));
    const page = Math.max(1, q.page || 1);
    const extra: any = {};
    if (q.entityType) extra.entityType = q.entityType;
    if (q.action) extra.action = q.action;
    const where: any[] = [{ restaurantId, ...extra }];
    if (organizationId) where.push({ organizationId, restaurantId: IsNull(), ...extra });
    const [items, total] = await this.auditRepo.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      take: limit,
      skip: (page - 1) * limit,
    });
    return { items, total, page, limit };
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
