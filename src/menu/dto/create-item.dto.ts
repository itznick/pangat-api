import { IsBoolean, IsNumber, IsOptional, IsString, Min } from 'class-validator';

export class CreateItemDto {
  @IsString()
  name: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsNumber()
  @Min(0)
  price: number;

  @IsString()
  categoryId: string;

  @IsOptional()
  @IsBoolean()
  isVeg?: boolean;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsString()
  restaurantSlug?: string;

  @IsOptional()
  @IsString()
  restaurantId?: string;

  @IsOptional()
  modifiers?: any[];
}

export class UpdateItemDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  price?: number;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsBoolean()
  isVeg?: boolean;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @IsOptional()
  modifiers?: any[];
}

export class ImportMenuDto {
  @IsOptional()
  @IsString()
  restaurantId?: string;

  @IsOptional()
  @IsString()
  restaurantSlug?: string;

  /** The CSV text itself (the browser reads the chosen file and sends its contents) */
  @IsString()
  csv: string;

  /** true = validate and preview only: nothing is written */
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  /** also update the price of dishes that already exist (same category and name) */
  @IsOptional()
  @IsBoolean()
  updatePrices?: boolean;
}
