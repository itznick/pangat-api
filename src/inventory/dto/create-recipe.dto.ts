// ─────────────────────────────────────────────────────────────────────────────
// src/inventory/dto/create-recipe.dto.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UnitOfMeasure } from '../../common/enums/index.js';

export class RecipeIngredientDto {
  @IsUUID()
  ingredientId: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0.001)
  quantity: number;

  @IsEnum(UnitOfMeasure)
  unit: UnitOfMeasure;
}

export class CreateRecipeDto {
  @IsUUID()
  menuItemId: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RecipeIngredientDto)
  ingredients: RecipeIngredientDto[];
}
