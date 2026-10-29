import { SetMetadata } from '@nestjs/common';
import { StaffRole } from '../enums/index.js';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: (StaffRole | string)[]) => SetMetadata(ROLES_KEY, roles);
