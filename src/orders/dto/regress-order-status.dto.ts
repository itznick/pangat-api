import { IsEnum, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { OrderStatus } from '../../common/enums/index.js';

export class RegressOrderStatusDto {
  @IsNotEmpty()
  @IsEnum(OrderStatus, {
    message: 'targetStatus must be a valid OrderStatus (e.g. PREPARING or RECEIVED)',
  })
  targetStatus: OrderStatus;

  @IsNotEmpty({ message: 'A regression reason is required to return a ticket to an earlier stage' })
  @IsString()
  @MinLength(3, { message: 'Reason must be at least 3 characters long' })
  reason: string;
}
