// ─────────────────────────────────────────────────────────────────────────────
// src/inventory/dto/update-ingredient.dto.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UnitOfMeasure } from '../../common/enums/index.js';

export class UpdateIngredientDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsOptional()
  @IsEnum(UnitOfMeasure)
  unit?: UnitOfMeasure;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minimumStock?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costPerUnit?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
