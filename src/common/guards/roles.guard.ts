import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../decorators/roles.decorator.js';
import { StaffRole } from '../enums/index.js';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<(StaffRole | string)[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    if (user.isPlatformAdmin === true || user.role === StaffRole.PLATFORM_SUPER_ADMIN) {
      const m = String(context.switchToHttp().getRequest().method || 'GET').toUpperCase();
      if (m !== 'GET' && m !== 'HEAD' && m !== 'OPTIONS' && !(user.platformPermissions || []).includes('merchant.operate')) {
        throw new ForbiddenException('Access denied: your platform role is read-only inside restaurant consoles');
      }
      return true;
    }

    const hasRole = requiredRoles.includes(user.role);
    if (!hasRole) {
      throw new ForbiddenException(
        `Access denied: Required role (${requiredRoles.join(', ')}). Your role: ${user.role}`,
      );
    }

    return true;
  }
}
