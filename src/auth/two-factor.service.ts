import { BadRequestException, HttpException, HttpStatus, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { Staff } from './entities/staff.entity.js';
import { StaffRole } from '../common/enums/index.js';
import { AuditService } from '../audit/audit.service.js';
import { PlatformAuditService } from '../platform/audit.service.js';
import { decryptSecret, encryptSecret, getSetting } from '../platform/settings.service.js';
import { currentRequest } from '../common/request-context.js';
import { AttemptLimiter } from '../common/security/attempt-limiter.js';
import { BCRYPT_COST } from '../common/security/passwords.js';
import { generateRecoveryCodes, generateTotpSecret, normalizeRecoveryCode, otpauthUrl, verifyTotp } from '../common/security/totp.js';

/** Two-factor sign-in with an authenticator app (TOTP) plus one-time recovery codes. */
@Injectable()
export class TwoFactorService {
  /** 5 wrong codes per person per 15 minutes: 6 digits alone could otherwise be guessed by a patient attacker who knows the password */
  private readonly limiter = new AttemptLimiter(5, 15 * 60_000, 15 * 60_000);

  constructor(
    @InjectRepository(Staff) private readonly staffRepo: Repository<Staff>,
    @Optional() private readonly auditService?: AuditService,
    @Optional() private readonly platformAudit?: PlatformAuditService,
  ) {}

  private isAdmin = (s: Staff) => Boolean(s.isPlatformAdmin || s.role === StaffRole.PLATFORM_SUPER_ADMIN);

  /** Whether platform administrators must have two-factor on (Super Admin → Settings → Security). */
  adminTotpRequired = () => getSetting<boolean>('security.adminTotpRequired') === true;

  private async record(staff: Staff, action: string, summary: string) {
    const ctx = currentRequest();
    if (this.isAdmin(staff)) {
      await this.platformAudit?.record(
        { id: staff.id, name: staff.name, email: staff.email, role: staff.platformRole || staff.role, ip: ctx?.ip ?? null, userAgent: ctx?.userAgent ?? null },
        { action: `ADMIN_${action}`, category: 'SECURITY', entityType: 'platform_admin', entityId: staff.id, entityLabel: staff.email, summary },
      );
      return;
    }
    await this.auditService?.record({
      restaurantId: staff.restaurantId, organizationId: staff.organizationId, entityType: 'ACCOUNT', entityId: staff.id, action,
      staffId: staff.id, staffName: staff.name, staffRole: staff.role, staffEmail: staff.email, metadata: { summary },
    });
  }

  private async load(id: string): Promise<Staff> {
    const s = await this.staffRepo.findOne({ where: { id } });
    if (!s) throw new UnauthorizedException('User account no longer exists');
    return s;
  }

  private throttle(staffId: string) {
    const wait = this.limiter.retryAfterSeconds(staffId);
    if (wait > 0) throw new HttpException(`Too many wrong codes. Try again in ${Math.ceil(wait / 60)} minute(s).`, HttpStatus.TOO_MANY_REQUESTS);
  }

  /** Step 1: create a secret for the person's authenticator app. Nothing is enforced until they prove it works (step 2). */
  async setup(staffId: string) {
    const staff = await this.load(staffId);
    if (staff.totpEnabled) throw new BadRequestException('Two-factor sign-in is already on. Turn it off first if you want to set it up again.');
    const secret = generateTotpSecret();
    await this.staffRepo.update(staffId, { totpSecretEnc: encryptSecret(secret), totpEnabled: false, totpLastStep: null, totpRecoveryHashes: null });
    return { secret, otpauthUrl: otpauthUrl(staff.email, String(getSetting<string>('branding.platformName') || 'Pangat'), secret) };
  }

  /** Step 2: the person types the first code their app shows. On success two-factor is on and recovery codes are returned once. */
  async enable(staffId: string, code: string) {
    this.throttle(staffId);
    const staff = await this.load(staffId);
    if (staff.totpEnabled) throw new BadRequestException('Two-factor sign-in is already on.');
    const secret = staff.totpSecretEnc ? decryptSecret(staff.totpSecretEnc) : null;
    if (!secret) throw new BadRequestException('Start the set-up again to get a new secret.');
    const r = verifyTotp(secret, code, null);
    if (!r.ok) {
      this.limiter.fail(staffId);
      throw new BadRequestException('That code is not right. Check the time on your phone and try the next code.');
    }
    this.limiter.succeed(staffId);
    const codes = generateRecoveryCodes();
    const hashes = await Promise.all(codes.map((c) => bcrypt.hash(normalizeRecoveryCode(c), BCRYPT_COST)));
    await this.staffRepo.update(staffId, { totpEnabled: true, totpEnabledAt: new Date(), totpLastStep: r.step ?? null, totpRecoveryHashes: hashes });
    await this.record(staff, 'TWO_FACTOR_ENABLED', 'Turned on two-factor sign-in');
    return { recoveryCodes: codes };
  }

  /** Turning it off needs the password AND a current code (or recovery code), so a stolen session cannot quietly remove it. */
  async disable(staffId: string, password: string, code: string) {
    const staff = await this.load(staffId);
    if (!staff.totpEnabled) throw new BadRequestException('Two-factor sign-in is not on.');
    if (this.isAdmin(staff) && this.adminTotpRequired()) throw new BadRequestException('Two-factor sign-in is required for platform administrators and cannot be turned off.');
    if (!(await bcrypt.compare(password || '', staff.passwordHash))) throw new BadRequestException('Your password is not correct.');
    if (!(await this.verifyLogin(staff, code))) throw new BadRequestException('That code is not right.');
    await this.staffRepo.update(staffId, { totpEnabled: false, totpSecretEnc: null, totpLastStep: null, totpRecoveryHashes: null, totpEnabledAt: null });
    await this.record(staff, 'TWO_FACTOR_DISABLED', 'Turned off two-factor sign-in');
    return { enabled: false };
  }

  /** Check the second factor at sign-in: an authenticator code, or one unused recovery code. Never throws on a wrong code. */
  async verifyLogin(staff: Staff, code: string): Promise<boolean> {
    this.throttle(staff.id);
    const raw = String(code || '').trim();
    const secret = staff.totpSecretEnc ? decryptSecret(staff.totpSecretEnc) : null;
    if (secret && /^\d{3}\s?\d{3}$/.test(raw)) {
      const r = verifyTotp(secret, raw, staff.totpLastStep == null ? null : Number(staff.totpLastStep));
      if (r.ok) {
        // Atomic: only the request that moves the step forward wins, so two parallel uses of the same code cannot both pass
        const res = await this.staffRepo
          .createQueryBuilder()
          .update(Staff)
          .set({ totpLastStep: r.step })
          .where('id = :id AND (totp_last_step IS NULL OR totp_last_step < :step)', { id: staff.id, step: r.step })
          .execute();
        if ((res.affected ?? 0) > 0) { this.limiter.succeed(staff.id); return true; }
      }
    } else if (raw) {
      const n = normalizeRecoveryCode(raw);
      const hashes = Array.isArray(staff.totpRecoveryHashes) ? [...staff.totpRecoveryHashes] : [];
      for (let i = 0; i < hashes.length; i++) {
        if (await bcrypt.compare(n, hashes[i])) {
          hashes.splice(i, 1); // single use
          await this.staffRepo.update(staff.id, { totpRecoveryHashes: hashes });
          await this.record(staff, 'TWO_FACTOR_RECOVERY_CODE_USED', `Signed in with a recovery code (${hashes.length} left)`);
          this.limiter.succeed(staff.id);
          return true;
        }
      }
    }
    this.limiter.fail(staff.id);
    return false;
  }
}
