// ─────────────────────────────────────────────────────────────────────────────
// src/auth/dto/onboard.dto.ts
// Multi-tenant Brand, Outlet, and Floor batch onboarding DTO
// ─────────────────────────────────────────────────────────────────────────────

import {
  IsString,
  IsNotEmpty,
  IsEmail,
  MinLength,
  IsOptional,
  IsNumber,
  Min,
  Max,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

export class StoreManagerDto {
  @IsString()
  @IsOptional()
  name?: string;

  @ValidateIf((o) => typeof o.email === 'string' && o.email.trim().length > 0)
  @IsEmail({}, { message: 'Please provide a valid store manager email' })
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  password?: string;
}

export class OnboardDto {
  // Step 1: Brand & Super Owner
  @IsString()
  @IsNotEmpty()
  brandName: string;

  @IsString()
  @IsNotEmpty()
  ownerFullName: string;

  @IsString()
  @IsNotEmpty()
  mobileNumber: string;

  @IsEmail({}, { message: 'Please provide a valid owner email' })
  email: string;

  @IsString()
  @MinLength(4)
  password: string;

  // Step 2: Outlet Details
  @IsString()
  @IsNotEmpty()
  outletName: string;

  @IsString()
  @IsOptional()
  branchArea?: string;

  @IsString()
  @IsNotEmpty()
  slug: string;

  @IsString()
  @IsNotEmpty()
  upiVpa: string;

  @IsString()
  @IsOptional()
  gstin?: string;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(28)
  gstPercentage?: number;

  // Step 3: Floor Batch Generator
  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(100)
  indoorTableCount?: number;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(50)
  outdoorTableCount?: number;

  // Step 4: Starter Menu Choice
  @IsString()
  @IsOptional()
  menuPreset?: 'pune_cafe' | 'south_indian' | 'empty';

  // Step 5: Team & Roles
  @IsString()
  @IsOptional()
  teamMode?: 'solo' | 'with_team';

  @ValidateIf((o) => o.teamMode === 'with_team' && !!o.storeManager && typeof o.storeManager.email === 'string' && o.storeManager.email.trim().length > 0)
  @ValidateNested()
  @Type(() => StoreManagerDto)
  @IsOptional()
  storeManager?: StoreManagerDto;

  @IsString()
  @IsOptional()
  kitchenPin?: string;
}
