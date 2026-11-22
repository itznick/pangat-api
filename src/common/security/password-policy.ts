import { BadRequestException } from '@nestjs/common';
import { registerDecorator, ValidationOptions } from 'class-validator';

/**
 * Password rules (modern guidance: length and "not guessable" matter more than symbols and capital letters).
 *  - at least 10 characters, at most 128
 *  - not a well-known password, not one character repeated, not a keyboard run
 *  - not built from the person's own email or name
 */
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

const COMMON = new Set(
  `password passw0rd p@ssw0rd p@ssword password1 password12 password123 password1234 123456 1234567 12345678 123456789 1234567890 12345678910 0123456789
   qwerty qwerty123 qwertyuiop qwerty1234 asdfghjkl asdfghjkl1 zxcvbnm 1q2w3e4r 1q2w3e4r5t 1qaz2wsx abc123 abcd1234 abcdefgh abcdefghij iloveyou welcome welcome1 welcome123
   admin admin123 admin1234 administrator letmein letmein123 monkey dragon master login login123 changeme changeme123 default guest test1234 testing123 secret secret123
   india123 india@123 pune123 pune@123 mumbai123 delhi123 bharat123 krishna123 ganesh123 shiv123 sairam123 jaishreeram
   pangat pangat123 pangat1234 pangat@123 pangat#123 pangat@1234 restaurant restaurant1 restaurant123 cafe123 kitchen123 kitchen1234 chef1234 steward123 cashier123
   football cricket cricket123 sachin123 virat123 dhoni123 iloveindia`
    .split(/\s+/)
    .filter(Boolean),
);

const RUNS = ['0123456789', '1234567890', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiopasdfghjklzxcvbnm', '9876543210'];

/** Returns a friendly problem description, or null when the password is acceptable. */
export function passwordProblem(pw: unknown, who: { email?: string | null; name?: string | null } = {}): string | null {
  if (typeof pw !== 'string') return 'Enter a password';
  if (pw.length < MIN_PASSWORD_LENGTH) return `Use at least ${MIN_PASSWORD_LENGTH} characters`;
  if (pw.length > MAX_PASSWORD_LENGTH) return `Use at most ${MAX_PASSWORD_LENGTH} characters`;
  const lower = pw.toLowerCase();
  const bare = lower.replace(/[^a-z0-9]/g, '');
  if (COMMON.has(lower) || COMMON.has(bare) || COMMON.has(lower.replace(/[0-9!@#$%^&*]+$/, ''))) return 'That password is too common. Choose something harder to guess';
  if (/^(.)\1+$/.test(pw)) return 'Do not repeat one character';
  if (bare.length >= 6 && RUNS.some((r) => r.includes(bare) || r.split('').reverse().join('').includes(bare))) return 'Do not use a keyboard or number sequence';
  const local = (who.email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (local.length >= 4 && bare.includes(local)) return 'Do not build your password from your email address';
  for (const part of String(who.name || '').toLowerCase().split(/\s+/)) {
    const p = part.replace(/[^a-z0-9]/g, '');
    if (p.length >= 4 && bare.includes(p)) return 'Do not build your password from your name';
  }
  return null;
}

/** Decorator for DTOs: applies the length and common-password rules (name/email rules are applied in the services, where they are known). */
export function IsAcceptablePassword(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isAcceptablePassword',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate: (v: unknown) => passwordProblem(v) === null,
        defaultMessage: (a) => passwordProblem(a?.value) ?? 'Choose a stronger password',
      },
    });
}

/** Service-level check that also knows who the password is for. Throws a 400 with the reason. */
export function assertPasswordAllowed(pw: unknown, who: { email?: string | null; name?: string | null } = {}): void {
  const problem = passwordProblem(pw, who);
  if (problem) throw new BadRequestException(problem);
}
