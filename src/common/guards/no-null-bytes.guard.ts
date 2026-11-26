import { BadRequestException, CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/** True when a string, or any string nested in an object/array (depth-limited), contains a NUL byte. */
export function hasNullByte(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') return value.includes('\u0000');
  if (depth > 8 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => hasNullByte(v, depth + 1));
  return Object.entries(value as Record<string, unknown>).some(([k, v]) => k.includes('\u0000') || hasNullByte(v, depth + 1));
}

/**
 * PostgreSQL cannot store a NUL character, and fails the query with a server error. Nothing legitimate contains one, so a request that does
 * (in the path, the query string or the JSON body) is refused up front as a plain 400 instead of becoming a 500 and an error-log entry.
 */
@Injectable()
export class NoNullBytesGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest();
    let path = String(req?.url ?? '');
    try { path = decodeURIComponent(path); } catch { /* malformed escapes are handled by the framework */ }
    if (hasNullByte(path) || hasNullByte(req?.query) || hasNullByte(req?.body) || hasNullByte(req?.params)) {
      throw new BadRequestException('The request contains characters that are not allowed.');
    }
    return true;
  }
}
