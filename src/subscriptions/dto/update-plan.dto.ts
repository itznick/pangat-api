// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/dto/update-plan.dto.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { BillingInterval } from '../../common/enums/index.js';

export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsEnum(BillingInterval)
  billingInterval?: BillingInterval;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  basePrice?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taxPercentage?: number;

  @IsOptional()
  @IsInt()
  maxOutlets?: number;

  @IsOptional()
  @IsInt()
  maxTablesPerOutlet?: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];

  @IsOptional()
  @IsString()
  razorpayPlanId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
