// ─────────────────────────────────────────────────────────────────────────────
// src/inventory/dto/adjust-stock.dto.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  NotEquals,
} from 'class-validator';
import { Type } from 'class-transformer';
import { StockMovementType } from '../../common/enums/index.js';

export class AdjustStockDto {
  /** Signed change in stock: e.g. -5.2 for spoilage/breakage or +10.0 for correction */
  @Type(() => Number)
  @IsNumber()
  @NotEquals(0, { message: 'Stock adjustment delta cannot be zero' })
  quantityDelta: number;

  @IsString()
  @IsNotEmpty({ message: 'A mandatory reason is required for any manual stock adjustment' })
  reason: string;

  @IsOptional()
  @IsEnum(StockMovementType)
  type?: StockMovementType;
}
