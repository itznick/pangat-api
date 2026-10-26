// ─────────────────────────────────────────────────────────────────────────────
// src/restaurants/dto/create-staff.dto.ts
// ─────────────────────────────────────────────────────────────────────────────

import {
  IsString,
  IsNotEmpty,
  IsEmail,
  IsOptional,
  MinLength,
  IsEnum,
} from 'class-validator';
import { StaffRole } from '../../common/enums/index.js';

export class CreateStaffDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @IsOptional()
  @MinLength(4)
  password?: string;

  @IsString()
  @IsOptional()
  pinCode?: string;

  @IsEnum(StaffRole)
  role: StaffRole;
}
