/**
 * Version of the privacy notice shown to people. Bump it whenever the privacy policy text changes in a way that affects what
 * people agreed to; every consent we store records the version, so we can show exactly which text a person accepted.
 */
export const PRIVACY_POLICY_VERSION = '2026-11-22';

export const PRIVACY_REQUEST_KINDS = ['ACCESS', 'CORRECTION', 'ERASURE', 'WITHDRAW_CONSENT', 'GRIEVANCE', 'NOMINATE'] as const;
export type PrivacyRequestKind = (typeof PRIVACY_REQUEST_KINDS)[number];

export const PRIVACY_REQUEST_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'REJECTED'] as const;

/** Last 10 digits of a phone number: how people write the same number differently (+91, spaces, dashes) must not hide their data. */
export function phoneKey(raw: string): string {
  return String(raw || '').replace(/\D/g, '').slice(-10);
}

export function maskPhone(raw: string): string {
  const k = phoneKey(raw);
  return k.length < 4 ? '****' : `******${k.slice(-4)}`;
}
