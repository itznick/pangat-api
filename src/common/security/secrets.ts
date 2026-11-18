import { Logger } from '@nestjs/common';

const DEV_FALLBACK = 'dev_only_insecure_jwt_secret_change_me';
let warned = false;

/** The insecure development fallback is only ever allowed when the operator says this is a dev/test process. */
const isDevLike = () => ['development', 'test'].includes(process.env.NODE_ENV ?? '') || process.env.ALLOW_INSECURE_DEV_SECRET === 'true';

/**
 * JWT signing secret. Anything that is not an explicit development/test process (NODE_ENV=development|test) must be
 * configured with a strong secret: a missing NODE_ENV can never silently fall back to a publicly known key.
 */
export function resolveJwtSecret(configured?: string | null): string {
  const secret = (configured || process.env.JWT_SECRET || '').trim();
  if (secret.length >= 32) return secret;
  if (isDevLike()) {
    if (!secret) {
      if (!warned) {
        new Logger('Security').warn('JWT_SECRET is not set: using an insecure development secret. Never do this in production.');
        warned = true;
      }
      return DEV_FALLBACK;
    }
    return secret;
  }
  throw new Error('JWT_SECRET must be set to a random string of at least 32 characters (set NODE_ENV=development to use the dev fallback locally)');
}

/** Key for encrypting secrets stored from the Settings screen: PLATFORM_SETTINGS_KEY, else the JWT secret, never a constant in production. */
export function resolveSettingsKey(): string {
  const key = (process.env.PLATFORM_SETTINGS_KEY || '').trim();
  if (key) return key;
  return resolveJwtSecret(process.env.JWT_SECRET);
}
