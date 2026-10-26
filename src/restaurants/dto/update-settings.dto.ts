import { IsBoolean, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdateSettingsDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  upiVpa?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  gstin?: string;

  @IsOptional()
  @IsString()
  hsnSac?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(28)
  gstPercentage?: number;

  @IsOptional()
  @IsBoolean()
  isVegOnly?: boolean;

  @IsOptional()
  @IsBoolean()
  kdsNewOrderAlert?: boolean;

  @IsOptional()
  @IsBoolean()
  orderReadyChime?: boolean;

  @IsOptional()
  @IsBoolean()
  outOfStockNotification?: boolean;
}
