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
  MaxLength,
  Matches, ValidateIf } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateOutletDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'slug may only contain lowercase letters, numbers and hyphens' })
  slug: string;

  @IsString()
  @IsOptional()
  branchArea?: string;

  // Optional at creation: the owner adds and CONFIRMS their own UPI ID later; we never invent one.
  @ValidateIf((o) => o.upiVpa !== undefined && o.upiVpa !== null && o.upiVpa !== '') // blank = not provided
  @IsString()
  @Matches(/^[a-zA-Z0-9._-]{2,64}@[a-zA-Z0-9]{2,32}$/, { message: 'Enter a valid UPI ID such as name@bank' })
  upiVpa?: string;

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
