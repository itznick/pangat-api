import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
process.env.JWT_SECRET = 'x'.repeat(40)
const { OtpService, hashOtp, generateOtp, OTP_MAX_ATTEMPTS } = await import('../dist/common/services/otp.service.js')
const { resolveEmailProvider, isEmailConfigured, EmailDeliveryService } = await import('../dist/common/services/email-delivery.service.js')

/** Minimal in-memory stand-in for the otp_codes table, interpreting only the queries OtpService issues. */
function fakeDb() {
  const rows = []
  return {
    rows,
    async query(sql, p = []) {
      if (sql.includes('COUNT(*) FILTER')) {
        const mine = rows.filter((r) => r.purpose === p[0] && r.identifier === p[1])
        const hour = mine.filter((r) => Date.now() - r.created_at < 3600_000)
        return [{ per_hour: hour.length, last_at: mine.length ? new Date(Math.max(...mine.map((r) => r.created_at))) : null }]
      }
      if (sql.startsWith('UPDATE otp_codes SET consumed_at = now() WHERE purpose')) {
        rows.filter((r) => r.purpose === p[0] && r.identifier === p[1] && !r.consumed_at).forEach((r) => (r.consumed_at = 1))
        return []
      }
      if (sql.startsWith('INSERT INTO otp_codes')) {
        rows.push({ id: rows.length + 1, purpose: p[0], identifier: p[1], code_hash: p[2], expires_at: +p[3], attempts: 0, consumed_at: null, created_at: Date.now() })
        return []
      }
      if (sql.includes('SELECT id, code_hash, attempts')) {
        const r = rows.filter((x) => x.purpose === p[0] && x.identifier === p[1] && !x.consumed_at && x.expires_at > Date.now()).sort((a, b) => b.id - a.id)[0]
        return r ? [r] : []
      }
      if (sql.includes('attempts = attempts + 1')) { rows.find((r) => r.id === p[0]).attempts++; return [] }
      if (sql.includes('RETURNING id')) {
        const r = rows.find((x) => x.id === p[0] && !x.consumed_at)
        if (!r) return [[], 0]
        r.consumed_at = 1
        return [[{ id: r.id }], 1]
      }
      throw new Error('unexpected query: ' + sql)
    },
  }
}
let sent
const mailer = { async sendTransactionalEmail(o) { sent.push(o); return { delivered: true, provider: 'brevo' } } }
const codeFromMail = () => /Code: (\d{6})/.exec(sent.at(-1).textContent)[1]

describe('OtpService', () => {
  let db, otp
  beforeEach(() => { sent = []; db = fakeDb(); otp = new OtpService(db, mailer) })

  it('emails a 6-digit code, stores only its HMAC, and accepts it exactly once', async () => {
    assert.equal(await otp.issue('LOGIN', 'Owner@Example.com'), true)
    const code = codeFromMail()
    assert.match(code, /^\d{6}$/)
    assert.equal(sent[0].to, 'owner@example.com')
    assert.ok(!JSON.stringify(db.rows).includes(code), 'plaintext code must not be stored')
    assert.equal(await otp.verify('LOGIN', 'owner@example.com', code), true)
    assert.equal(await otp.verify('LOGIN', 'owner@example.com', code), false, 'single use')
  })
  it('rejects wrong codes, wrong purpose and wrong address, and kills the code after too many guesses', async () => {
    await otp.issue('LOGIN', 'a@b.com'); const code = codeFromMail()
    const wrong = code === '000000' ? '111111' : '000000'
    assert.equal(await otp.verify('SIGNUP', 'a@b.com', code), false)
    assert.equal(await otp.verify('LOGIN', 'c@d.com', code), false)
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) assert.equal(await otp.verify('LOGIN', 'a@b.com', wrong), false)
    assert.equal(await otp.verify('LOGIN', 'a@b.com', code), false, 'locked even with the right code')
  })
  it('rejects malformed input and expired codes', async () => {
    await otp.issue('SIGNUP', 'a@b.com'); const code = codeFromMail()
    assert.equal(await otp.verify('SIGNUP', 'a@b.com', 'abcdef'), false)
    assert.equal(await otp.verify('SIGNUP', 'a@b.com', ''), false)
    db.rows[0].expires_at = Date.now() - 1
    assert.equal(await otp.verify('SIGNUP', 'a@b.com', code), false)
  })
  it('enforces the resend cooldown and the hourly cap, and a new code replaces the old one', async () => {
    await otp.issue('LOGIN', 'a@b.com'); const first = codeFromMail()
    await assert.rejects(() => otp.issue('LOGIN', 'a@b.com'), (e) => e.getStatus() === 429)
    db.rows[0].created_at -= 120_000
    await otp.issue('LOGIN', 'a@b.com')
    assert.equal(await otp.verify('LOGIN', 'a@b.com', first), first === codeFromMail())
    for (const r of db.rows) r.created_at -= 120_000
    for (let i = 0; i < 5; i++) { await otp.issue('LOGIN', 'x@y.com').catch(() => {}); db.rows.forEach((r) => (r.created_at -= 120_000)) }
    await assert.rejects(() => otp.issue('LOGIN', 'x@y.com'), (e) => e.getStatus() === 429)
  })
  it('reports a failed delivery instead of pretending', async () => {
    const bad = new OtpService(db, { async sendTransactionalEmail() { return { delivered: false, provider: 'none' } } })
    assert.equal(await bad.issue('LOGIN', 'a@b.com'), false)
  })
  it('generateOtp is always 6 digits and hashes are bound to purpose + address', () => {
    for (let i = 0; i < 200; i++) assert.match(generateOtp(), /^\d{6}$/)
    assert.notEqual(hashOtp('LOGIN', 'a@b.com', '123456'), hashOtp('SIGNUP', 'a@b.com', '123456'))
    assert.notEqual(hashOtp('LOGIN', 'a@b.com', '123456'), hashOtp('LOGIN', 'c@b.com', '123456'))
  })
})

describe('email provider selection and transport', () => {
  const KEYS = ['SMTP_HOST', 'OTP_SMTP_HOST', 'OTP_SMTP_PORT', 'OTP_SMTP_USER', 'OTP_SMTP_PASS', 'BREVO_API_KEY', 'RESEND_API_KEY', 'SENDGRID_API_KEY', 'EMAIL_PROVIDER']
  beforeEach(() => KEYS.forEach((k) => delete process.env[k]))

  it('is unconfigured with no keys, prefers a free provider in auto mode, and honours EMAIL_PROVIDER', () => {
    assert.equal(isEmailConfigured(), false)
    process.env.SENDGRID_API_KEY = 's'; assert.equal(resolveEmailProvider().provider, 'sendgrid')
    process.env.RESEND_API_KEY = 'r'; assert.equal(resolveEmailProvider().provider, 'resend')
    process.env.BREVO_API_KEY = 'b'; assert.equal(resolveEmailProvider().provider, 'brevo')
    process.env.EMAIL_PROVIDER = 'sendgrid'; assert.equal(resolveEmailProvider().provider, 'sendgrid')
    process.env.EMAIL_PROVIDER = 'resend'; delete process.env.RESEND_API_KEY
    assert.equal(resolveEmailProvider(), null)
  })
  it('calls Brevo and Resend with the right shape and reports provider rejection', async () => {
    const calls = []; const realFetch = globalThis.fetch
    globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ messageId: 'm1', id: 'r1' }), { status: calls.length === 3 ? 401 : 201 }) }
    try {
      const svc = new EmailDeliveryService({ get: () => undefined })
      const mail = { to: 'a@b.com', subject: 'S', htmlContent: '<p>x</p>', textContent: 'x' }
      process.env.BREVO_API_KEY = 'bk'
      const a = await svc.sendTransactionalEmail(mail)
      assert.deepEqual([a.delivered, a.provider, a.messageId], [true, 'brevo', 'm1'])
      assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email'); assert.equal(calls[0].init.headers['api-key'], 'bk')
      assert.equal(JSON.parse(calls[0].init.body).to[0].email, 'a@b.com')
      delete process.env.BREVO_API_KEY; process.env.RESEND_API_KEY = 'rk'
      const b = await svc.sendTransactionalEmail(mail)
      assert.deepEqual([b.delivered, b.provider, b.messageId], [true, 'resend', 'r1'])
      assert.equal(calls[1].init.headers.Authorization, 'Bearer rk')
      const c = await svc.sendTransactionalEmail(mail)
      assert.equal(c.delivered, false); assert.match(c.error, /Resend HTTP 401/)
      delete process.env.RESEND_API_KEY
      assert.equal((await svc.sendTransactionalEmail(mail)).provider, 'none')
    } finally { globalThis.fetch = realFetch }
  })
})

describe('AuthService: admin sign-in code and sign-up verification', async () => {
  const bcrypt = (await import('bcrypt')).default
  const { AuthService } = await import('../dist/auth/auth.service.js')
  const { PlatformSettingsService } = await import('../dist/platform/settings.service.js')
  const hash = bcrypt.hashSync('Correct-horse-1', 4)
  const setSettings = (kv) => new PlatformSettingsService({ query: async () => Object.entries(kv).map(([key, value]) => ({ key, value, encrypted: null, is_secret: false })) }).refresh()

  const build = ({ isAdmin = true, deliverable = true, verifyOk = true } = {}) => {
    const log = { issued: 0, verified: [], updates: 0 }
    const staff = { id: 's1', name: 'Root', email: 'root@pangat.in', passwordHash: hash, role: isAdmin ? 'PLATFORM_SUPER_ADMIN' : 'SUPER_OWNER', isPlatformAdmin: isAdmin, isActive: true, organizationId: null, restaurantId: null }
    const qb = { where: () => qb, andWhere: () => qb, getOne: async () => staff }
    const repo = { createQueryBuilder: () => qb, update: async () => { log.updates++ } }
    const ds = { query: async () => [], getRepository: () => ({ find: async () => [], findOne: async () => null }) }
    const otp = {
      canDeliver: () => deliverable,
      issue: async () => { log.issued++; return true },
      verify: async (...a) => { log.verified.push(a); return verifyOk },
    }
    const jwt = { sign: () => 'jwt' }
    return { svc: new AuthService(repo, jwt, ds, {}, { get: () => undefined }, otp), log }
  }
  const creds = { email: 'root@pangat.in', password: 'Correct-horse-1' }

  it('with the setting off, admin login is unchanged', async () => {
    await setSettings({})
    const { svc, log } = build()
    assert.equal((await svc.login(creds)).accessToken, 'jwt'); assert.equal(log.issued, 0)
  })
  it('with the setting on, a correct password alone emails a code and issues no token', async () => {
    await setSettings({ 'security.adminLoginOtp': true })
    const { svc, log } = build()
    const r = await svc.login(creds)
    assert.equal(r.otpRequired, true); assert.equal(r.accessToken, undefined); assert.equal(log.issued, 1); assert.equal(log.updates, 0)
  })
  it('a wrong password never triggers a code (no mail bombing)', async () => {
    await setSettings({ 'security.adminLoginOtp': true })
    const { svc, log } = build()
    await assert.rejects(() => svc.login({ ...creds, password: 'nope-nope' }), /Invalid email or password/)
    assert.equal(log.issued, 0)
  })
  it('password + valid code signs in; password + wrong code is rejected', async () => {
    await setSettings({ 'security.adminLoginOtp': true })
    const ok = build({ verifyOk: true })
    assert.equal((await ok.svc.login({ ...creds, otp: '123456' })).accessToken, 'jwt')
    assert.deepEqual(ok.log.verified[0], ['LOGIN', 'root@pangat.in', '123456'])
    const bad = build({ verifyOk: false })
    await assert.rejects(() => bad.svc.login({ ...creds, otp: '000000' }), /wrong or has expired/)
  })
  it('does not lock admins out when no email provider is configured, and never applies to restaurant staff', async () => {
    await setSettings({ 'security.adminLoginOtp': true })
    assert.equal((await build({ deliverable: false }).svc.login(creds)).accessToken, 'jwt')
    const owner = build({ isAdmin: false })
    assert.equal((await owner.svc.login(creds)).accessToken, 'jwt'); assert.equal(owner.log.issued, 0)
  })
  it('break-glass env var skips the admin code so a broken mailbox cannot lock everyone out', async () => {
    await setSettings({ 'security.adminLoginOtp': true })
    process.env.ADMIN_LOGIN_OTP_DISABLED = 'true'
    try {
      const { svc, log } = build()
      assert.equal((await svc.login(creds)).accessToken, 'jwt'); assert.equal(log.issued, 0)
    } finally { delete process.env.ADMIN_LOGIN_OTP_DISABLED }
  })
  it('sign-up: requires a code only when the setting is on and mail can be delivered', async () => {
    const dto = { email: 'new@cafe.in' }
    await setSettings({ 'security.signupEmailOtp': true })
    const on = build()
    assert.equal(on.svc.signupOtpRequired(), true)
    await assert.rejects(() => on.svc.onboard({ ...dto }), (e) => e.getResponse().code === 'EMAIL_OTP_REQUIRED')
    await assert.rejects(() => build({ verifyOk: false }).svc.onboard({ ...dto, emailOtp: '111111' }), (e) => e.getResponse().code === 'EMAIL_OTP_INVALID')
    assert.equal(build({ deliverable: false }).svc.signupOtpRequired(), false)
    await setSettings({})
    assert.equal(build().svc.signupOtpRequired(), false)
  })
})

describe('SMTP provider', async () => {
  const net = await import('node:net')
  const ENV = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'OTP_SMTP_HOST', 'OTP_SMTP_PORT', 'OTP_SMTP_USER', 'OTP_SMTP_PASS', 'OTP_FROM_EMAIL', 'BREVO_API_KEY', 'EMAIL_PROVIDER']
  beforeEach(() => ENV.forEach((k) => delete process.env[k]))

  it('reads SMTP_* and the OTP_SMTP_* aliases, and wins over API-key providers in auto mode', () => {
    process.env.BREVO_API_KEY = 'b'
    process.env.OTP_SMTP_HOST = 'smtp.example.com'; process.env.OTP_SMTP_PORT = '2525'; process.env.OTP_SMTP_USER = 'u'; process.env.OTP_SMTP_PASS = 'p'
    const c = resolveEmailProvider()
    assert.equal(c.provider, 'smtp')
    assert.deepEqual(c.smtp, { host: 'smtp.example.com', port: 2525, user: 'u', pass: 'p' })
    process.env.EMAIL_PROVIDER = 'brevo'; assert.equal(resolveEmailProvider().provider, 'brevo')
    delete process.env.OTP_SMTP_HOST; process.env.EMAIL_PROVIDER = 'smtp'; assert.equal(resolveEmailProvider(), null)
  })

  it('really delivers through an SMTP server (AUTH PLAIN, From/To/Subject/body intact)', async () => {
    let transcript = ''
    const server = net.createServer((sock) => {
      let inData = false
      sock.write('220 test ESMTP\r\n')
      sock.on('data', (buf) => {
        for (const line of buf.toString().split('\r\n').filter((l) => l !== '' || inData)) {
          transcript += line + '\n'
          if (inData) { if (line === '.') { inData = false; sock.write('250 2.0.0 queued as ABC\r\n') } continue }
          const u = line.toUpperCase()
          if (u.startsWith('EHLO')) sock.write('250-test\r\n250 AUTH PLAIN LOGIN\r\n')
          else if (u.startsWith('AUTH')) sock.write('235 ok\r\n')
          else if (u === 'DATA') { inData = true; sock.write('354 go\r\n') }
          else if (u === 'QUIT') { sock.write('221 bye\r\n'); sock.end() }
          else sock.write('250 ok\r\n')
        }
      })
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    try {
      process.env.SMTP_HOST = '127.0.0.1'; process.env.SMTP_PORT = String(server.address().port)
      process.env.SMTP_USER = 'user'; process.env.SMTP_PASS = 'pass'; process.env.OTP_FROM_EMAIL = 'no-reply@pangat.test'
      const svc = new EmailDeliveryService({ get: () => undefined })
      const r = await svc.sendTransactionalEmail({ to: 'owner@cafe.in', subject: 'Your code', htmlContent: '<b>123456</b>', textContent: 'Code: 123456' })
      assert.equal(r.delivered, true); assert.equal(r.provider, 'smtp')
      assert.match(transcript, /MAIL FROM:<no-reply@pangat.test>/i)
      assert.match(transcript, /RCPT TO:<owner@cafe.in>/i)
      assert.match(transcript, /Subject: Your code/i)
    } finally { server.close() }
  })

  it('reports a clean failure when the SMTP server is unreachable', async () => {
    process.env.SMTP_HOST = '127.0.0.1'; process.env.SMTP_PORT = '1'
    const r = await new EmailDeliveryService({ get: () => undefined }).sendTransactionalEmail({ to: 'a@b.com', subject: 's', htmlContent: 'x' })
    assert.equal(r.delivered, false); assert.equal(r.provider, 'smtp'); assert.ok(r.error)
  })
})
