import { Logger } from '@nestjs/common';

const DEV_FALLBACK = 'dev_only_insecure_jwt_secret_change_me';
let warned = false;

/** JWT signing secret. In production a missing/weak secret is a startup error, never a silent default. */
export function resolveJwtSecret(configured?: string | null): string {
  const secret = (configured || process.env.JWT_SECRET || '').trim();
  if (process.env.NODE_ENV === 'production') {
    if (secret.length < 32) {
      throw new Error('JWT_SECRET must be set to a random string of at least 32 characters in production');
    }
    return secret;
  }
  if (!secret) {
    if (!warned) {
      new Logger('Security').warn('JWT_SECRET is not set: using an insecure development secret. Never do this in production.');
      warned = true;
    }
    return DEV_FALLBACK;
  }
  return secret;
}
