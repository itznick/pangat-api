// ─────────────────────────────────────────────────────────────────────────────
// src/common/guards/idempotency.guard.ts
// Validates X-Idempotency-Key header on order creation to prevent
// duplicate KOT fires from rapid multi-tap.
// Uses an in-memory Set for dev; swap to Redis in production.
// ─────────────────────────────────────────────────────────────────────────────

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class IdempotencyGuard implements CanActivate {
  private readonly seen = new Set<string>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const key = req.headers['x-idempotency-key'] as string | undefined;

    if (!key) {
      throw new BadRequestException(
        'X-Idempotency-Key header is required for order creation',
      );
    }

    if (this.seen.has(key)) {
      throw new ConflictException(
        `Duplicate request — idempotency key "${key}" was already processed`,
      );
    }

    this.seen.add(key);

    // Evict keys older than 24 h (simple waterfall via TTL map in production)
    // For dev, the Set simply grows — harmless under low traffic.
    return true;
  }
}
