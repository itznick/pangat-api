import {
  IsEmail,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class ProvisionRestaurantDto {
  // Step 1: Owner Details
  @IsString()
  @IsNotEmpty()
  brandName: string;

  @IsString()
  @IsNotEmpty()
  ownerFullName: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;

  @IsString()
  @IsNotEmpty()
  mobileNumber: string;

  @IsString()
  @IsOptional()
  password?: string; // Optional: auto-generated if omitted

  // Step 2: Outlet Setup
  @IsString()
  @IsNotEmpty()
  outletName: string;

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

  @IsNumber()
  @IsOptional()
  @Min(0)
  gstPercentage?: number;

  // Step 3: Table Batch Ingestion
  @IsNumber()
  @IsOptional()
  @Min(1)
  indoorTableCount?: number;

  @IsNumber()
  @IsOptional()
  @Min(0)
  outdoorTableCount?: number;

  // Step 4: Menu Preset Selection
  @IsString()
  @IsOptional()
  menuPreset?: 'pune_cafe' | 'south_indian' | 'blank';

  // Lead linkage (optional)
  @IsString()
  @IsOptional()
  leadId?: string;
}
