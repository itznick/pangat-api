import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class RequestPasswordResetDto {
  @IsEmail()
  @IsNotEmpty()
  email: string;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  token: string;

  @IsString()
  @MinLength(6)
  newPassword: string;
}
