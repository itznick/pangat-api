/**
 * CORS allow-list rules (pure, so they can be unit tested).
 *
 *  - Requests without an Origin header (curl, server-to-server, health checks) are always allowed.
 *  - Browsers are allowed only from FRONTEND_URL (comma-separated exact origins).
 *  - Local dev origins (localhost:5173 / 3000) are added outside production.
 *  - Preview hosts are opt-in: CORS_ALLOWED_SUFFIXES=".netlify.app,.vercel.app" matches https hostnames only.
 *  - FRONTEND_URL unset: open in development (convenience), closed in production (a loud warning is logged).
 *  - A literal "*" in FRONTEND_URL is honoured, but it is an explicit operator choice.
 */
export interface CorsEnv {
  FRONTEND_URL?: string;
  CORS_ALLOWED_SUFFIXES?: string;
  NODE_ENV?: string;
}

const normalise = (o: string) => o.trim().replace(/\/+$/, '').toLowerCase();
const split = (v?: string) => (v ?? '').split(',').map(normalise).filter(Boolean);

export function buildCorsPolicy(env: CorsEnv) {
  const production = env.NODE_ENV === 'production';
  const configured = split(env.FRONTEND_URL);
  const suffixes = split(env.CORS_ALLOWED_SUFFIXES).filter((s) => s.startsWith('.') && s.length > 3);
  const dev = production ? [] : ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:3000'];
  const allowed = new Set([...configured, ...dev]);
  const unconfigured = configured.length === 0;

  const isAllowed = (origin?: string): boolean => {
    if (!origin) return true;
    if (allowed.has('*')) return true;
    if (unconfigured && !production) return true;
    const o = normalise(origin);
    if (allowed.has(o)) return true;
    try {
      const u = new URL(origin);
      return u.protocol === 'https:' && suffixes.some((s) => u.hostname.toLowerCase().endsWith(s));
    } catch {
      return false;
    }
  };
  return { isAllowed, unconfigured, production };
}
