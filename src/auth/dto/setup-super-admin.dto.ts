import { IsEmail, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { IsAcceptablePassword } from '../../common/security/password-policy.js';

export class SetupSuperAdminDto {
  @IsString()
  @IsNotEmpty({ message: 'Full name is required' })
  name: string;

  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @IsAcceptablePassword()
  password: string;

  @IsString()
  @IsOptional()
  phone?: string;
}
