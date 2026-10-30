// ─────────────────────────────────────────────────────────────────────────────
// src/inventory/dto/receive-stock.dto.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ReceivedItemDto {
  @IsUUID()
  @IsNotEmpty()
  ingredientId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.001, { message: 'Received quantity must be greater than 0' })
  quantity: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  costPerUnit?: number;

  @IsOptional()
  @IsString()
  notes?: string;
}

export class ReceiveStockDto {
  @IsUUID()
  @IsNotEmpty()
  restaurantId: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReceivedItemDto)
  items: ReceivedItemDto[];

  @IsOptional()
  @IsString()
  invoiceNumber?: string;

  @IsOptional()
  @IsString()
  supplierName?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
