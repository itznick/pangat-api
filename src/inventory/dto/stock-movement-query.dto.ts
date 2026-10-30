// ─────────────────────────────────────────────────────────────────────────────
// src/inventory/dto/stock-movement-query.dto.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { StockMovementType } from '../../common/enums/index.js';

export class StockMovementQueryDto {
  @IsUUID()
  @IsOptional()
  ingredientId?: string;

  @IsEnum(StockMovementType)
  @IsOptional()
  type?: StockMovementType;

  @IsOptional()
  @IsString()
  startDate?: string;

  @IsOptional()
  @IsString()
  endDate?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 50;
}
