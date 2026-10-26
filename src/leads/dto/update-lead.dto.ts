import { IsEnum, IsOptional, IsString } from 'class-validator';
import { LeadStatus } from '../../common/enums/index.js';

export class UpdateLeadDto {
  @IsEnum(LeadStatus)
  @IsOptional()
  status?: LeadStatus;

  @IsString()
  @IsOptional()
  notes?: string;
}
