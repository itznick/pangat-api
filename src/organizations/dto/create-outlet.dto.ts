// ─────────────────────────────────────────────────────────────────────────────
// src/organizations/dto/create-outlet.dto.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateOutletDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  slug: string;

  @IsString()
  @IsOptional()
  branchArea?: string;

  @IsString()
  @IsNotEmpty()
  upiVpa: string;

  @IsString()
  @IsOptional()
  gstin?: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsString()
  @IsOptional()
  email?: string;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  @Min(0)
  @Max(28)
  gstPercentage?: number;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(100)
  tableCount?: number;
}
