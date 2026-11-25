import { BadRequestException, CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;

/**
 * Rejects malformed identifiers with HTTP 400 before anything touches the database.
 * Without it a malformed id reaches a uuid column and surfaces as an HTTP 500 (and, inside TenantGuard, as an unhandled error).
 * Checks `:id` and `?restaurantId` as UUIDs and `?restaurantSlug` as a slug, each only when present.
 * Place it AFTER the authentication guards (so anonymous callers get 401, not a validation hint) and BEFORE TenantGuard.
 */
@Injectable()
export class UuidInputGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const bad = (what: string) => new BadRequestException({ message: `${what} is not valid`, code: 'INVALID_IDENTIFIER' });
    const one = (v: unknown) => (Array.isArray(v) ? (v.length === 1 ? v[0] : Symbol.for('invalid')) : v);
    const id = req.params?.id;
    if (id !== undefined && !UUID.test(String(id))) throw bad('The id');
    const rid = one(req.query?.restaurantId);
    if (rid !== undefined && (typeof rid !== 'string' || !UUID.test(rid))) throw bad('restaurantId');
    const slug = one(req.query?.restaurantSlug);
    if (slug !== undefined && (typeof slug !== 'string' || slug.length > 80 || !SLUG.test(slug))) throw bad('restaurantSlug');
    return true;
  }
}
