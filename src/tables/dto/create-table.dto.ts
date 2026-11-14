import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class CreateTableDto {
  @IsString()
  @IsNotEmpty()
  restaurantId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(10)
  @Matches(/^[A-Za-z0-9-]+$/, { message: 'Table identifier may only contain letters, numbers and hyphens' })
  tableNumber: string;
}
