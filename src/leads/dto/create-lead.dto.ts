import { Equals, IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateLeadDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  restaurantName: string;

  @IsString()
  @IsNotEmpty()
  phone: string;

  @IsString()
  @IsNotEmpty()
  city: string;

  @IsString()
  @IsOptional()
  tableCount?: string;

  @IsString()
  @IsOptional()
  notes?: string;

  /** Must be true: we only store contact details of people who accepted the Privacy Notice */
  @IsBoolean()
  @Equals(true, { message: 'Please accept the Privacy Notice so we can contact you' })
  consentAccepted: boolean;
}
