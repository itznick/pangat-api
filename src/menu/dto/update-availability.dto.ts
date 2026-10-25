import { IsBoolean, IsNotEmpty } from 'class-validator';

export class UpdateAvailabilityDto {
  @IsNotEmpty()
  @IsBoolean()
  isAvailable: boolean;
}
