import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { CreateOrderItemDto } from './create-order.dto.js';

export class EditOrderItemsDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Order must contain at least 1 item' })
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];
}
