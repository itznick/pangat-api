import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsPositive, IsString, MinLength } from 'class-validator';
import { Type } from 'class-transformer';

export class ProcessRefundDto {
  @IsNotEmpty()
  @IsIn(['COUNTER_CASH', 'GATEWAY_VERIFIED'], {
    message: 'refundMethod must be either COUNTER_CASH or GATEWAY_VERIFIED',
  })
  refundMethod: 'COUNTER_CASH' | 'GATEWAY_VERIFIED';

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @IsPositive({ message: 'Refund amount must be greater than zero' })
  amount?: number;

  @IsNotEmpty({ message: 'A refund reason is required' })
  @IsString()
  @MinLength(3, { message: 'Reason must be at least 3 characters long' })
  reason: string;

  @IsOptional()
  @IsString()
  providerReference?: string;

  @IsNotEmpty({ message: 'idempotencyKey is required to prevent duplicate refunds' })
  @IsString()
  idempotencyKey: string;
}
