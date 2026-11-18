/**
 * bcrypt work factor for every password / PIN hash. 12 is the current OWASP minimum recommendation.
 * Override with BCRYPT_COST (clamped to 10-15). Existing hashes keep verifying at their own cost.
 */
const raw = Number(process.env.BCRYPT_COST);
export const BCRYPT_COST = Number.isInteger(raw) ? Math.min(15, Math.max(10, raw)) : 12;
