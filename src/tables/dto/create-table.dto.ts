import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class CreateTableDto {
  @IsString()
  @IsNotEmpty()
  restaurantId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  @Matches(/^[A-Za-z0-9-]+$/, { message: 'Table identifier may only contain letters, numbers and hyphens' })
  tableNumber: string;

  /**
   * Platform administrators only (permission "subscriptions.manage"): a recorded reason lets one table past the plan limit.
   * Anyone else sending it is refused; it is never ignored silently.
   */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  limitOverrideReason?: string;
}
