import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

class DayHoursDto {
  @IsBoolean()
  closed: boolean;

  @Matches(HHMM, { message: 'open must be HH:mm' })
  open: string;

  @Matches(HHMM, { message: 'close must be HH:mm' })
  close: string;
}

class WeekHoursDto {
  @IsOptional() @ValidateNested() @Type(() => DayHoursDto) sun?: DayHoursDto;
  @IsOptional() @ValidateNested() @Type(() => DayHoursDto) mon?: DayHoursDto;
  @IsOptional() @ValidateNested() @Type(() => DayHoursDto) tue?: DayHoursDto;
  @IsOptional() @ValidateNested() @Type(() => DayHoursDto) wed?: DayHoursDto;
  @IsOptional() @ValidateNested() @Type(() => DayHoursDto) thu?: DayHoursDto;
  @IsOptional() @ValidateNested() @Type(() => DayHoursDto) fri?: DayHoursDto;
  @IsOptional() @ValidateNested() @Type(() => DayHoursDto) sat?: DayHoursDto;
}

class OrderTypesDto {
  @IsOptional() @IsBoolean() dineIn?: boolean;
  @IsOptional() @IsBoolean() takeaway?: boolean;
  @IsOptional() @IsBoolean() delivery?: boolean;
}

class PaymentsDto {
  @IsOptional() @IsBoolean() upi?: boolean;
  @IsOptional() @IsBoolean() payAtCounter?: boolean;
  @IsOptional() @IsBoolean() cod?: boolean;
}

export class OperationsDto {
  @IsOptional() @IsBoolean() acceptingOrders?: boolean;
  @IsOptional() @IsString() @MaxLength(200) pausedMessage?: string;
  @IsOptional() @IsBoolean() enforceHours?: boolean;
  @IsOptional() @ValidateNested() @Type(() => WeekHoursDto) hours?: WeekHoursDto;
  @IsOptional() @ValidateNested() @Type(() => OrderTypesDto) orderTypes?: OrderTypesDto;
  @IsOptional() @ValidateNested() @Type(() => PaymentsDto) payments?: PaymentsDto;
  @IsOptional() @IsInt() @Min(1) @Max(180) avgPrepMinutes?: number;
  @IsOptional() @IsString() @MaxLength(240) receiptFooter?: string;
}

export class UpdateSettingsDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  branchArea?: string;

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

  @IsOptional()
  @IsBoolean()
  autoDeductInventory?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => OperationsDto)
  operations?: OperationsDto;
}
