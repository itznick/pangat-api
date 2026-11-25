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
  @IsInt()
  @Min(0)
  basePricePaise?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taxPercentage?: number;

  @IsOptional()
  @IsInt()
  @Min(-1) // -1 means unlimited
  maxOutlets?: number;

  @IsOptional()
  @IsInt()
  @Min(-1) // -1 means unlimited
  maxTablesPerOutlet?: number;

  @IsOptional()
  @IsInt()
  @Min(-1) // -1 means unlimited
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

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  trialDays?: number;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  /**
   * Required to change the price, billing interval or GST rate of a plan that any organisation is, or has ever been, subscribed to.
   * The safe route is a NEW plan row (and moving the customer by an audited plan change); this flag is the deliberate exception.
   */
  @IsOptional()
  @IsBoolean()
  acknowledgeSubscriberImpact?: boolean;
}
