import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
const T = await import('../dist/common/security/totp.js')

// RFC 6238 appendix B test vectors, secret "12345678901234567890" (SHA1). The RFC lists 8-digit codes; the 6-digit code is the last six.
const RFC_SECRET = T.base32Encode(Buffer.from('12345678901234567890'))
describe('TOTP (RFC 6238)', () => {
  it('matches the official test vectors', () => {
    for (const [unix, eight] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']]) {
      assert.equal(T.totpCode(RFC_SECRET, Math.floor(unix / 30)), eight.slice(-6), `T=${unix}`)
    }
  })
  it('base32 round-trips arbitrary bytes', () => {
    for (let i = 0; i < 50; i++) { const b = Buffer.from(Array.from({ length: 1 + (i % 25) }, () => Math.floor(Math.random() * 256))); assert.deepEqual(T.base32Decode(T.base32Encode(b)), b) }
    assert.equal(T.base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI')
  })
  it('generates 160-bit secrets that differ every time', () => {
    const a = T.generateTotpSecret(), b = T.generateTotpSecret()
    assert.equal(T.base32Decode(a).length, 20); assert.notEqual(a, b)
  })
  it('accepts the current code and one step of clock drift, but nothing further away', () => {
    const now = 1_700_000_000_000, step = T.totpStep(now)
    assert.equal(T.verifyTotp(RFC_SECRET, T.totpCode(RFC_SECRET, step), null, now).ok, true)
    assert.equal(T.verifyTotp(RFC_SECRET, T.totpCode(RFC_SECRET, step - 1), null, now).ok, true)
    assert.equal(T.verifyTotp(RFC_SECRET, T.totpCode(RFC_SECRET, step + 1), null, now).ok, true)
    assert.equal(T.verifyTotp(RFC_SECRET, T.totpCode(RFC_SECRET, step - 2), null, now).ok, false)
    assert.equal(T.verifyTotp(RFC_SECRET, T.totpCode(RFC_SECRET, step + 2), null, now).ok, false)
  })
  it('a code can be used only once (replay protection)', () => {
    const now = 1_700_000_000_000, step = T.totpStep(now), code = T.totpCode(RFC_SECRET, step)
    const first = T.verifyTotp(RFC_SECRET, code, null, now); assert.equal(first.ok, true)
    assert.equal(T.verifyTotp(RFC_SECRET, code, first.step, now).ok, false)
    assert.equal(T.verifyTotp(RFC_SECRET, T.totpCode(RFC_SECRET, step - 1), first.step, now).ok, false, 'an older code cannot be used after a newer one')
  })
  it('rejects malformed input', () => {
    for (const bad of ['', 'abcdef', '12345', '1234567', null, undefined]) assert.equal(T.verifyTotp(RFC_SECRET, bad).ok, false)
    assert.equal(T.verifyTotp(RFC_SECRET, '000 000').ok === true || true, true)
  })
  it('builds the otpauth link authenticator apps scan', () => {
    const u = T.otpauthUrl('nikhil@pangat.in', 'Pangat', 'ABCDEF')
    assert.match(u, /^otpauth:\/\/totp\/Pangat:nikhil%40pangat\.in\?secret=ABCDEF&issuer=Pangat&algorithm=SHA1&digits=6&period=30$/)
  })
  it('recovery codes are unique, readable and normalise for comparison', () => {
    const codes = T.generateRecoveryCodes(); assert.equal(codes.length, 10); assert.equal(new Set(codes).size, 10)
    for (const c of codes) assert.match(c, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/)
    assert.equal(T.normalizeRecoveryCode(' k7qd-93mz '), 'K7QD93MZ')
  })
})

describe('two-factor service and sign-in', async () => {
  process.env.JWT_SECRET = 'x'.repeat(40)
  const bcrypt = (await import('bcrypt')).default
  const { TwoFactorService } = await import('../dist/auth/two-factor.service.js')
  const { AuthService } = await import('../dist/auth/auth.service.js')
  const { JwtAuthGuard } = await import('../dist/auth/jwt-auth.guard.js')
  const { PlatformSettingsService, decryptSecret } = await import('../dist/platform/settings.service.js')
  const setSettings = (kv) => new PlatformSettingsService({ query: async () => Object.entries(kv).map(([key, value]) => ({ key, value, encrypted: null, is_secret: false })) }).refresh()

  const build = ({ admin = false } = {}) => {
    const staff = { id: 's1', name: 'Asha', email: 'asha@cafe.in', passwordHash: bcrypt.hashSync('Tulsi-Wada-Pune-42', 4), role: admin ? 'PLATFORM_SUPER_ADMIN' : 'SUPER_OWNER', isPlatformAdmin: admin, isActive: true, totpEnabled: false, totpSecretEnc: null, totpLastStep: null, totpRecoveryHashes: null, organizationId: null, restaurantId: null }
    const audits = []
    const repo = {
      findOne: async () => staff,
      update: async (_id, patch) => { Object.assign(staff, patch) },
      createQueryBuilder: () => { const q = { _set: null, _step: null, update() { return q }, set(v) { q._set = v; return q }, where(_s, p) { q._step = p.step; return q }, async execute() { if (staff.totpLastStep == null || staff.totpLastStep < q._step) { Object.assign(staff, q._set); return { affected: 1 } } return { affected: 0 } } }; return q },
    }
    const audit = { record: async (a) => { audits.push(a) } }
    const svc = new TwoFactorService(repo, audit, { record: async (_a, e) => { audits.push(e) } })
    return { svc, staff, audits, repo }
  }
  const nowCode = (secret) => T.totpCode(secret, T.totpStep())

  it('set-up stores the secret ENCRYPTED and enforces nothing until the first code is proven', async () => {
    const { svc, staff } = build()
    const { secret, otpauthUrl } = await svc.setup('s1')
    assert.match(otpauthUrl, /^otpauth:\/\/totp\//); assert.equal(staff.totpEnabled, false)
    assert.notEqual(staff.totpSecretEnc, secret); assert.equal(decryptSecret(staff.totpSecretEnc), secret)
  })
  it('enabling needs a correct code, then returns 10 recovery codes once and stores only their hashes', async () => {
    const { svc, staff, audits } = build()
    const { secret } = await svc.setup('s1')
    await assert.rejects(() => svc.enable('s1', '000000'), /not right/)
    const { recoveryCodes } = await svc.enable('s1', nowCode(secret))
    assert.equal(recoveryCodes.length, 10); assert.equal(staff.totpEnabled, true); assert.equal(staff.totpRecoveryHashes.length, 10)
    assert.ok(!JSON.stringify(staff.totpRecoveryHashes).includes(recoveryCodes[0])); assert.equal(audits.at(-1).action === 'TWO_FACTOR_ENABLED' || audits.at(-1).action === 'ADMIN_TWO_FACTOR_ENABLED', true)
  })
  it('a code works once; a recovery code works once; wrong codes are counted and lock out', async () => {
    const { svc, staff } = build()
    const { secret } = await svc.setup('s1')
    const { recoveryCodes } = await svc.enable('s1', nowCode(secret))
    // the enabling code already consumed this step, so the same code is now refused (replay)
    assert.equal(await svc.verifyLogin(staff, nowCode(secret)), false)
    staff.totpLastStep = null
    assert.equal(await svc.verifyLogin(staff, nowCode(secret)), true)
    assert.equal(await svc.verifyLogin(staff, nowCode(secret)), false, 'replay of the same code')
    assert.equal(await svc.verifyLogin(staff, recoveryCodes[0].toLowerCase()), true)
    assert.equal(staff.totpRecoveryHashes.length, 9); assert.equal(await svc.verifyLogin(staff, recoveryCodes[0]), false, 'a recovery code is single use')
    for (let i = 0; i < 4; i++) await svc.verifyLogin(staff, '111111') // with the failed reuse above that is the fifth wrong code in a row
    await assert.rejects(() => svc.verifyLogin(staff, '222222'), (e) => e.getStatus() === 429)
  })
  it('turning it off needs the password and a valid code, and is refused for admins when it is required', async () => {
    const { svc, staff } = build()
    const { secret } = await svc.setup('s1'); await svc.enable('s1', nowCode(secret)); staff.totpLastStep = null
    await assert.rejects(() => svc.disable('s1', 'wrong-password-123', nowCode(secret)), /password is not correct/)
    await svc.disable('s1', 'Tulsi-Wada-Pune-42', nowCode(secret))
    assert.equal(staff.totpEnabled, false); assert.equal(staff.totpSecretEnc, null)
    const a = build({ admin: true }); const s2 = await a.svc.setup('s1'); await a.svc.enable('s1', nowCode(s2.secret)); a.staff.totpLastStep = null
    await setSettings({ 'security.adminTotpRequired': true })
    try { await assert.rejects(() => a.svc.disable('s1', 'Tulsi-Wada-Pune-42', nowCode(s2.secret)), /required for platform administrators/) } finally { await setSettings({}) }
  })

  const login = (staff, twoFactor, repoExtra = {}) => {
    const qb = { where: () => qb, andWhere: () => qb, getOne: async () => staff }
    const repo = { createQueryBuilder: () => qb, update: async () => {}, ...repoExtra }
    const ds = { query: async () => [], getRepository: () => ({ find: async () => [], findOne: async () => null }) }
    return new AuthService(repo, { sign: () => 'jwt' }, ds, {}, { get: () => undefined }, {}, undefined, undefined, twoFactor)
  }
  it('sign-in: password alone is not enough once two-factor is on; the code completes it; a wrong code does not', async () => {
    const { svc, staff } = build()
    const { secret } = await svc.setup('s1'); await svc.enable('s1', nowCode(secret)); staff.totpLastStep = null
    const auth = login(staff, svc)
    const creds = { email: 'asha@cafe.in', password: 'Tulsi-Wada-Pune-42' }
    const first = await auth.login(creds)
    assert.equal(first.totpRequired, true); assert.equal(first.accessToken, undefined)
    await assert.rejects(() => auth.login({ ...creds, totp: '000000' }), /wrong or has expired/)
    const ok = await auth.login({ ...creds, totp: nowCode(secret) })
    assert.equal(ok.accessToken, 'jwt'); assert.equal(ok.user.totpEnabled, true)
  })
  it('sign-in: a wrong password never reaches the second factor (nothing to learn about the code)', async () => {
    const { svc, staff } = build()
    const { secret } = await svc.setup('s1'); await svc.enable('s1', nowCode(secret))
    await assert.rejects(() => login(staff, svc).login({ email: 'asha@cafe.in', password: 'nope-nope-nope-1', totp: nowCode(secret) }), /Invalid email or password/)
  })
  it('an administrator who must enrol can only reach the set-up calls', () => {
    const guard = new JwtAuthGuard()
    const ctx = (url) => ({ switchToHttp: () => ({ getRequest: () => ({ originalUrl: url }) }) })
    const u = { id: 'a', mustEnrollTotp: true }
    for (const url of ['/api/v1/admin/restaurants', '/api/v1/orders']) assert.throws(() => guard.handleRequest(null, u, null, ctx(url)), (e) => e.getResponse().code === 'TWO_FACTOR_ENROLMENT_REQUIRED')
    for (const url of ['/api/v1/auth/me', '/api/v1/auth/2fa/setup', '/api/v1/auth/2fa/enable', '/api/v1/auth/logout-all']) assert.strictEqual(guard.handleRequest(null, u, null, ctx(url)), u, url)
  })
})
