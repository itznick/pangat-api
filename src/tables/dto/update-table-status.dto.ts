import { IsEnum, IsNotEmpty } from 'class-validator';
import { TableStatus } from '../../common/enums/index.js';

export class UpdateTableStatusDto {
  @IsNotEmpty()
  @IsEnum(TableStatus, {
    message: 'Status must be one of: VACANT, OCCUPIED, PREPPING, SERVED',
  })
  status: TableStatus;
}
