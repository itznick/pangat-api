// ─────────────────────────────────────────────────────────────────────────────
// src/inventory/dto/create-ingredient.dto.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UnitOfMeasure } from '../../common/enums/index.js';

export class CreateIngredientDto {
  @IsUUID()
  @IsNotEmpty()
  restaurantId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsOptional()
  @IsString()
  sku?: string;

  @IsEnum(UnitOfMeasure)
  @IsNotEmpty()
  unit: UnitOfMeasure;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  openingStock?: number;

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
}
