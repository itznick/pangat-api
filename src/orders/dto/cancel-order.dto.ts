import { IsNotEmpty, IsOptional, IsString, MinLength } from 'class-validator';

export class CancelOrderDto {
  @IsNotEmpty({ message: 'A cancellation reason is required' })
  @IsString()
  @MinLength(3, { message: 'Cancellation reason must be at least 3 characters long' })
  reason: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
