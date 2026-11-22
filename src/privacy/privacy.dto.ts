import { Equals, IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PRIVACY_REQUEST_KINDS, PRIVACY_REQUEST_STATUSES } from '../platform/compliance.js';

export class CreatePrivacyRequestDto {
  @IsIn(PRIVACY_REQUEST_KINDS as unknown as string[]) kind: (typeof PRIVACY_REQUEST_KINDS)[number];
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  /** Email or phone number we can reach the person on */
  @IsString() @IsNotEmpty() @MinLength(5) @MaxLength(180) contact: string;
  @IsOptional() @IsString() @MaxLength(120) restaurantRef?: string;
  @IsOptional() @IsString() @MaxLength(2000) message?: string;
  /** Honeypot: real people never fill this (hidden field); bots do */
  @IsOptional() @IsString() @MaxLength(200) website?: string;
  @IsBoolean() @Equals(true, { message: 'Please confirm that the details you gave are correct' }) confirm: boolean;
}

export class UpdatePrivacyRequestDto {
  @IsOptional() @IsIn(PRIVACY_REQUEST_STATUSES as unknown as string[]) status?: (typeof PRIVACY_REQUEST_STATUSES)[number];
  @IsOptional() @IsString() @MaxLength(2000) resolutionNote?: string;
  /** Email the person the outcome (only works when they gave an email address) */
  @IsOptional() @IsBoolean() notifyRequester?: boolean;
}

export class PhoneDto {
  @IsString() @MinLength(7) @MaxLength(20) phone: string;
}
