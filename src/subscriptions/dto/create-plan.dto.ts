// ─────────────────────────────────────────────────────────────────────────────
// src/subscriptions/dto/create-plan.dto.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { BillingInterval } from '../../common/enums/index.js';

export class CreatePlanDto {
  @IsString()
  code: string;

  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsEnum(BillingInterval)
  billingInterval: BillingInterval;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  basePrice: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  basePricePaise?: number;

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
  @IsInt()
  maxStaffPerOutlet?: number;

  @IsOptional()
  @IsString()
  sacCode?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  features?: string[];

  @IsOptional()
  @IsString()
  razorpayPlanId?: string;
}
