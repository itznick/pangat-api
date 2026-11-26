/**
 * TLS settings for the PostgreSQL connection.
 *
 * Verification (rejectUnauthorized) is decided like this, first match wins:
 *   1. DATABASE_SSL_REJECT_UNAUTHORIZED=true|false  (explicit operator choice)
 *   2. DATABASE_CA is set (PEM, "\n" escapes allowed)  -> verify against that CA (certificate pinning)
 *   3. the host is a provider with a publicly trusted certificate (neon.tech)  -> verify
 *   4. otherwise unverified, and `warning` explains how to turn verification on.
 * TLS itself is on in production, for neon.tech and for sslmode=require URLs; off for plain local databases.
 *
 * One explicit exception: DATABASE_SSL=false turns TLS off even in production. It exists only so a disposable database that offers no TLS (a CI service
 * container) can be used to prove the production boot path. It is IGNORED for neon.tech and sslmode=require URLs, and it logs a loud warning.
 */
export interface DbSslEnv {
  NODE_ENV?: string;
  DATABASE_URL?: string;
  DATABASE_CA?: string;
  DATABASE_SSL_REJECT_UNAUTHORIZED?: string;
  /** 'false' = explicit operator opt-out of TLS (disposable databases only) */
  DATABASE_SSL?: string;
}

export function resolveDbSsl(env: DbSslEnv): { ssl: false | { rejectUnauthorized: boolean; ca?: string }; warning?: string } {
  const url = env.DATABASE_URL ?? '';
  const useTls = env.NODE_ENV === 'production' || url.includes('neon.tech') || url.includes('sslmode=require');
  if (!useTls) return { ssl: false };
  const hostedOrRequired = url.includes('neon.tech') || url.includes('sslmode=require');
  if (env.DATABASE_SSL?.trim().toLowerCase() === 'false' && !hostedOrRequired) {
    return { ssl: false, warning: 'Database TLS is OFF because DATABASE_SSL=false. Use this only with a disposable database; never in production.' };
  }

  const ca = env.DATABASE_CA?.trim() ? env.DATABASE_CA.replace(/\\n/g, '\n') : undefined;
  const flag = env.DATABASE_SSL_REJECT_UNAUTHORIZED?.trim().toLowerCase();
  let verify: boolean;
  if (flag === 'true' || flag === 'false') verify = flag === 'true';
  else if (ca) verify = true;
  else verify = url.includes('neon.tech');

  return {
    ssl: { rejectUnauthorized: verify, ...(ca ? { ca } : {}) },
    warning: verify
      ? undefined
      : 'Database TLS certificate is NOT verified. Set DATABASE_CA (PEM of your provider CA) or DATABASE_SSL_REJECT_UNAUTHORIZED=true.',
  };
}
