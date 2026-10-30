import {
  IsArray,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { OrderType, PaymentMethod } from '../../common/enums/index.js';

export class SelectedModifierDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price: number;
}

export class CreateOrderItemDto {
  @IsString()
  @IsNotEmpty()
  menuItemId: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SelectedModifierDto)
  selectedModifiers?: SelectedModifierDto[];

  @IsOptional()
  @IsString()
  notes?: string;
}

export class CreateOrderDto {
  @IsString()
  @IsNotEmpty()
  restaurantSlug: string;

  @IsOptional()
  @IsEnum(OrderType)
  orderType?: OrderType;

  /** tableNumber is mandatory only for DINE_IN orders */
  @ValidateIf((o) => !o.orderType || o.orderType === OrderType.DINE_IN)
  @IsString()
  @IsNotEmpty()
  tableNumber?: string;

  /** customerName for takeaway pickup or delivery */
  @ValidateIf((o) => o.orderType === OrderType.TAKEAWAY || o.orderType === OrderType.DELIVERY)
  @IsString()
  @IsNotEmpty()
  customerName?: string;

  /** Delivery specific requirements */
  @ValidateIf((o) => o.orderType === OrderType.DELIVERY)
  @IsString()
  @IsNotEmpty()
  deliveryAddress?: string;

  @IsOptional()
  @IsString()
  deliveryInstructions?: string;

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @ValidateIf((o) => o.orderType === OrderType.DELIVERY)
  @IsString()
  @IsNotEmpty()
  customerPhone?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];
}
