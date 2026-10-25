import { IsEnum, IsNotEmpty } from 'class-validator';
import { OrderStatus } from '../../common/enums/index.js';

export class UpdateOrderStatusDto {
  @IsNotEmpty()
  @IsEnum(OrderStatus, {
    message: 'Status must be one of: RECEIVED, PREPARING, READY, COMPLETED',
  })
  status: OrderStatus;
}
