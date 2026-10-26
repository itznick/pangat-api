import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'Please provide a valid email address' })
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  @MinLength(4, { message: 'Password must be at least 4 characters' })
  password?: string;

  /** Optional 4-digit PIN for rapid station/chef logins */
  @IsString()
  @IsOptional()
  pinCode?: string;

  @IsString()
  @IsOptional()
  restaurantSlug?: string;
}
