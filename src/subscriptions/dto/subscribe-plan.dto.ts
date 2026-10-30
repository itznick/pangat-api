// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/dto/subscribe-plan.dto.ts
// ─────────────────────────────────────────────────────────────────────────────

import { IsOptional, IsString, IsUUID } from 'class-validator';

export class SubscribePlanDto {
  @IsUUID()
  planId: string;

  @IsOptional()
  @IsString()
  razorpaySubscriptionId?: string;

  @IsOptional()
  @IsString()
  razorpayCustomerId?: string;
}
