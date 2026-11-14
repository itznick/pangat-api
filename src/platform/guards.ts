import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { StaffRole } from '../common/enums/index.js';

export const PERMISSION_KEY = 'platform_permission';
/** Every route behind PlatformAdminGuard must declare the permission it needs (undeclared routes are denied). */
export const RequirePermission = (...permissions: string[]) => SetMetadata(PERMISSION_KEY, permissions);

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const user = context.switchToHttp().getRequest().user;
    if (!user) throw new UnauthorizedException('Authentication required');
    if (!(user.isPlatformAdmin === true || user.role === StaffRole.PLATFORM_SUPER_ADMIN)) {
      throw new ForbiddenException('Access denied: Platform Operations Super-Admin permission required');
    }
    const needed = this.reflector.getAllAndOverride<string[]>(PERMISSION_KEY, [context.getHandler(), context.getClass()]);
    if (!needed || needed.length === 0) {
      throw new ForbiddenException('Access denied: this operation has no permission assigned');
    }
    const have: string[] = user.platformPermissions || [];
    if (!needed.every((p) => have.includes(p))) {
      throw new ForbiddenException(`Access denied: your platform role does not include "${needed.join('", "')}"`);
    }
    return true;
  }
}
