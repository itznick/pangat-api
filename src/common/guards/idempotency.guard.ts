// ─────────────────────────────────────────────────────────────────────────────
// src/common/guards/idempotency.guard.ts
// Requires an X-Idempotency-Key header on order creation. De-duplication itself happens in
// OrdersService.create (backed by the UNIQUE orders.idempotency_key column), so a retried request
// returns the original order instead of an error, and nothing is held in process memory.
// ─────────────────────────────────────────────────────────────────────────────
import { BadRequestException, CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';

@Injectable()
export class IdempotencyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const key = req.headers['x-idempotency-key'];
    if (typeof key !== 'string' || key.trim().length < 8 || key.length > 100) {
      throw new BadRequestException('X-Idempotency-Key header (8-100 characters) is required for order creation');
    }
    return true;
  }
}
