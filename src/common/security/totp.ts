import * as crypto from 'crypto';

/**
 * Time-based one-time passwords (RFC 6238, HMAC-SHA1, 6 digits, 30-second steps): the standard used by Google Authenticator,
 * Microsoft Authenticator, Authy and 1Password. No third-party code.
 */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 160 random bits, the size RFC 4226 recommends. */
export const generateTotpSecret = (): string => base32Encode(crypto.randomBytes(20));

export const totpStep = (atMs = Date.now()): number => Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);

export function totpCode(secretBase32: string, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', base32Decode(secretBase32)).update(counter).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/**
 * Checks a code against the current step and one step either side (clock drift). `lastUsedStep` makes a code single-use:
 * a code that was already accepted (or an older one) is refused, so a shoulder-surfed or intercepted code cannot be replayed.
 */
export function verifyTotp(secretBase32: string, code: string, lastUsedStep?: number | null, atMs = Date.now()): { ok: boolean; step?: number } {
  const clean = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return { ok: false };
  const now = totpStep(atMs);
  for (const step of [now, now - 1, now + 1]) {
    if (lastUsedStep != null && step <= lastUsedStep) continue;
    const expected = Buffer.from(totpCode(secretBase32, step));
    const given = Buffer.from(clean);
    if (expected.length === given.length && crypto.timingSafeEqual(expected, given)) return { ok: true, step };
  }
  return { ok: false };
}

export const otpauthUrl = (accountLabel: string, issuer: string, secretBase32: string): string =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(accountLabel)}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;

/** One-time recovery codes, shown once at setup: for when the phone is lost. 10 codes like "K7QD-93MZ". */
export function generateRecoveryCodes(n = 10): string[] {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: n }, () => {
    const b = crypto.randomBytes(8);
    const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export const normalizeRecoveryCode = (c: string): string => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
