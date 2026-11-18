import { Transform } from 'class-transformer';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  @MinLength(4, { message: 'Password must be at least 4 characters' })
  password?: string;

  @IsString()
  @IsOptional()
  restaurantSlug?: string;

  /** 6-digit email code; only used when platform-admin sign-in codes are switched on */
  @IsString()
  @IsOptional()
  otp?: string;
}
