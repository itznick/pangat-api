import { ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/** The only calls a person with a temporary password may make: see who they are, change the password, sign out. */
const ALLOWED_WHILE_PASSWORD_CHANGE_PENDING = /^\/api\/v1\/auth\/(me|change-password|logout-all)(\?|$)/;

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<T = any>(err: any, user: any, info: any, context: ExecutionContext, status?: any): T {
    const u = super.handleRequest(err, user, info, context, status);
    if (u?.mustChangePassword) {
      const req = context.switchToHttp().getRequest();
      const path = String(req.originalUrl || req.url || '');
      if (!ALLOWED_WHILE_PASSWORD_CHANGE_PENDING.test(path)) {
        throw new ForbiddenException({ message: 'Choose a new password to continue.', code: 'PASSWORD_CHANGE_REQUIRED' });
      }
    }
    return u;
  }
}
