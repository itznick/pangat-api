import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { StaffRole } from '../../common/enums/index.js';

@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new UnauthorizedException('Authentication required');
    }

    const isPlatformAdmin =
      user.isPlatformAdmin === true ||
      user.role === StaffRole.PLATFORM_SUPER_ADMIN;

    if (!isPlatformAdmin) {
      throw new ForbiddenException(
        'Access denied: Platform Operations Super-Admin permission required',
      );
    }

    return true;
  }
}
