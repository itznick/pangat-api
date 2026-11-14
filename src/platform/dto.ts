import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength,
} from 'class-validator';

const reason = () => [IsString(), MinLength(3, { message: 'Please give a reason (at least 3 characters)' }), MaxLength(500)];
function R(): PropertyDecorator { return (t, k) => reason().forEach((d) => d(t, k)); }

export class RestaurantStatusDto {
  @IsIn(['SUSPEND', 'DEACTIVATE', 'RESTORE']) action: 'SUSPEND' | 'DEACTIVATE' | 'RESTORE';
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class VerificationDto {
  @IsIn(['VERIFIED', 'REJECTED', 'UNVERIFIED']) status: 'VERIFIED' | 'REJECTED' | 'UNVERIFIED';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class NoteDto {
  @IsString() @MinLength(2) @MaxLength(2000) body: string;
  @IsOptional() @IsBoolean() pinned?: boolean;
}
export class OutletStatusDto {
  @IsBoolean() isActive: boolean;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class FeatureOverrideDto {
  @IsString() @IsNotEmpty() feature: string;
  @IsIn(['FORCE_ON', 'FORCE_OFF', 'DEFAULT']) mode: 'FORCE_ON' | 'FORCE_OFF' | 'DEFAULT';
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
export class ChangePlanDto {
  @IsString() @IsNotEmpty() planCode: string;
  @R() reason: string;
  @IsOptional() @IsBoolean() keepPeriod?: boolean;
}
export class ExtendDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(730) days: number;
  @R() reason: string;
}
export class CancelSubDto {
  @IsOptional() @IsBoolean() immediate?: boolean;
  @R() reason: string;
}
export class ReactivateDto {
  @IsOptional() @IsString() planCode?: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(730) days: number;
  @R() reason: string;
}
export class StartTrialDto {
  @IsString() @IsNotEmpty() planCode: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(180) days: number;
  @R() reason: string;
}
export class AssignDto {
  @IsString() @IsNotEmpty() planCode: string;
  @Type(() => Number) @IsInt() @Min(1) @Max(36) months: number;
  @IsString() @MinLength(3, { message: 'A note is required: record why this plan is being granted' }) @MaxLength(300) note: string;
}
export class UserActiveDto {
  @IsBoolean() isActive: boolean;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
export class AdminCreateDto {
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsString() @MaxLength(180) email: string;
  @IsString() role: string;
  @IsOptional() @IsArray() @IsString({ each: true }) permissions?: string[];
  @IsOptional() @IsString() @MaxLength(128) password?: string;
}
export class AdminUpdateDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() role?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) permissions?: string[] | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
export class SettingsDto {
  @IsObject() changes: Record<string, unknown>;
}
export class FlagDto {
  @IsBoolean() enabled: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
export class SendNotificationDto {
  @IsString() @MinLength(2) @MaxLength(200) subject: string;
  @IsString() @MinLength(2) @MaxLength(5000) body: string;
  @IsArray() @ArrayMaxSize(2) @IsIn(['IN_APP', 'EMAIL'], { each: true }) channels: ('IN_APP' | 'EMAIL')[];
  @IsIn(['ALL_OWNERS', 'ORGANIZATIONS', 'USERS']) audience: 'ALL_OWNERS' | 'ORGANIZATIONS' | 'USERS';
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) targetIds?: string[];
  @IsOptional() @IsString() templateKey?: string;
}
export class TemplateDto {
  @IsOptional() @IsString() @MaxLength(60) key?: string;
  @IsString() @MinLength(2) @MaxLength(120) name: string;
  @IsString() channel: string;
  @IsString() @MinLength(1) @MaxLength(200) subject: string;
  @IsString() @MinLength(1) @MaxLength(5000) body: string;
  @IsOptional() @IsBoolean() isActive?: boolean;
}
export class AnnouncementDto {
  @IsString() @MinLength(2) @MaxLength(200) title: string;
  @IsString() @MinLength(2) @MaxLength(2000) body: string;
  @IsIn(['ANNOUNCEMENT', 'MAINTENANCE', 'INCIDENT']) kind: string;
  @IsIn(['INFO', 'WARNING', 'CRITICAL']) severity: string;
  @IsIn(['ALL', 'ORGANIZATIONS']) audience: string;
  @IsOptional() @IsArray() @IsUUID('all', { each: true }) organizationIds?: string[];
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() endsAt?: string | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
  @IsOptional() @IsBoolean() dismissible?: boolean;
}
export class TicketCreateDto {
  @IsOptional() @IsUUID() organizationId?: string;
  @IsString() category: string;
  @IsString() @MinLength(3) @MaxLength(200) subject: string;
  @IsString() @MinLength(3) @MaxLength(5000) description: string;
  @IsOptional() @IsString() priority?: string;
  @IsOptional() @IsString() @MaxLength(120) reporterName?: string;
}
export class MerchantTicketDto {
  @IsString() category: string;
  @IsString() @MinLength(3) @MaxLength(200) subject: string;
  @IsString() @MinLength(3) @MaxLength(5000) description: string;
  @IsOptional() @IsString() priority?: string;
}
export class TicketUpdateDto {
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() priority?: string;
  @IsOptional() @IsUUID() assigneeId?: string | null;
  @IsOptional() @IsString() @MaxLength(3000) resolution?: string;
}
export class TicketEventDto {
  @IsIn(['NOTE', 'REPLY']) kind: 'NOTE' | 'REPLY';
  @IsString() @MinLength(1) @MaxLength(5000) body: string;
}
export class TicketReplyDto {
  @IsString() @MinLength(1) @MaxLength(5000) body: string;
}
export class MarkReadDto {
  @IsOptional() @IsUUID() id?: string;
}
export class AckDto {
  @IsOptional() @IsUUID() id?: string;
}
