import { IsNotEmpty, IsNumber, Min } from 'class-validator';

export class UpdatePriceDto {
  @IsNotEmpty()
  @IsNumber()
  @Min(0, { message: 'Price cannot be negative' })
  price: number;
}
