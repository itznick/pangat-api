/**
 * Keeps credentials out of logs, error records and error responses.
 *
 * Order tracking tokens, reset/OTP codes, PINs, passwords and API keys must never be written anywhere that outlives the request: not to the
 * process log (which hosting dashboards retain), not to the error log table, not echoed back in an error body. A bearer credential in a URL
 * is the easiest one to leak, because `GET /orders/:id?token=...` is a normal request and a stack trace or an access line quotes the URL.
 */

/** Query/body keys whose VALUE is a credential or personal secret. Matched case-insensitively, ignoring `_`/`-`. */
const SENSITIVE_KEYS = new Set([
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'trackingtoken', 'auth', 'authorization', 'bearer',
  'password', 'currentpassword', 'newpassword', 'passwd', 'pwd',
  'pin', 'pincode', 'kitchenpin', 'otp', 'code', 'emailotp', 'totp', 'totpcode', 'recoverycode',
  'secret', 'clientsecret', 'apikey', 'key', 'signature', 'sig', 'reset', 'resettoken', 'invite',
]);
const norm = (k: string) => k.toLowerCase().replace(/[_-]/g, '');
const MASK = '[redacted]';

/** `/orders/abc?token=SECRET&x=1` -> `/orders/abc?token=[redacted]&x=1`. Safe on anything: never throws. */
export function redactUrl(url: unknown): string {
  const s = String(url ?? '');
  const q = s.indexOf('?');
  if (q < 0) return s.slice(0, 500);
  const base = s.slice(0, q);
  const hashAt = s.indexOf('#', q);
  const query = s.slice(q + 1, hashAt < 0 ? undefined : hashAt);
  const out = query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      let decoded = key;
      try { decoded = decodeURIComponent(key); } catch { /* keep raw */ }
      return SENSITIVE_KEYS.has(norm(decoded)) ? `${key}=${MASK}` : pair;
    })
    .join('&');
  return `${base}?${out}`.slice(0, 500);
}

/** Free text (error messages, stacks): masks the common credential shapes wherever they appear. */
export function redactText(text: unknown): string {
  return String(text ?? '')
    .replace(/Bearer\s+[\w.~+/=-]+/gi, `Bearer ${MASK}`)
    .replace(/([?&;\s,"'{]|^)(token|access_token|refresh_token|trackingToken|password|passwd|pin|pinCode|otp|code|secret|api_?key|signature|authorization)(["']?\s*[=:]\s*["']?)([^&\s"',}]+)/gi, `$1$2$3${MASK}`);
}

/** A copy of a JSON-like value with credential fields masked (for any structured logging). Depth-limited; never mutates the input. */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return typeof value === 'string' ? redactText(value) : value;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = SENSITIVE_KEYS.has(norm(k)) ? MASK : redactObject(v, depth + 1);
  return out;
}
