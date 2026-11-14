import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Populates request.user when a valid Bearer token is present, but never rejects the request.
 * Used on endpoints that serve both staff (JWT) and anonymous diners (tracking token).
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<T>(_err: unknown, user: T): T | null {
    return user || null;
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    try {
      await super.canActivate(context);
    } catch {
      /* anonymous */
    }
    return true;
  }
}
