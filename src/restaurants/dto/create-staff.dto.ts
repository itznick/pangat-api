// ─────────────────────────────────────────────────────────────────────────────
// src/restaurants/dto/create-staff.dto.ts
// ─────────────────────────────────────────────────────────────────────────────
import {
  IsString,
  IsNotEmpty,
  IsEmail,
  IsIn,
  IsOptional,
  IsBoolean,
  MinLength,
  MaxLength,
  Matches,
} from 'class-validator';
import { StaffRole } from '../../common/enums/index.js';

/** Roles an outlet owner may hand out. Owners and platform admins are never creatable through this API. */
export const ASSIGNABLE_STAFF_ROLES = [
  StaffRole.STORE_MANAGER,
  StaffRole.CHEF,
  StaffRole.STEWARD,
  StaffRole.CASHIER,
] as const;

export class CreateStaffDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  @MaxLength(128)
  password: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsIn(ASSIGNABLE_STAFF_ROLES as unknown as string[], {
    message: `role must be one of ${ASSIGNABLE_STAFF_ROLES.join(', ')}`,
  })
  role: StaffRole;
}

export class UpdateStaffDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @IsOptional()
  @IsIn(ASSIGNABLE_STAFF_ROLES as unknown as string[])
  role?: StaffRole;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SetKitchenPinDto {
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'Kitchen PIN must be 4 to 6 digits' })
  pin: string;
}
