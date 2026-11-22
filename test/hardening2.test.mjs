import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
process.env.JWT_SECRET = 'x'.repeat(40)
const { passwordProblem, assertPasswordAllowed } = await import('../dist/common/security/password-policy.js')
const { JwtAuthGuard } = await import('../dist/auth/jwt-auth.guard.js')
const { requestContextMiddleware } = await import('../dist/common/request-context.js')
const { HttpExceptionFilter } = await import('../dist/common/filters/http-exception.filter.js')
const { BadRequestException } = await import('@nestjs/common')
const { AuthService } = await import('../dist/auth/auth.service.js')
const { validate } = await import('class-validator')
const { plainToInstance } = await import('class-transformer')
const { SetupSuperAdminDto } = await import('../dist/auth/dto/setup-super-admin.dto.js')
const { ResetPasswordDto } = await import('../dist/auth/dto/password-reset.dto.js')

describe('password policy', () => {
  it('needs 10+ characters and rejects common, repeated and sequential passwords', () => {
    assert.match(passwordProblem('Short1!'), /at least 10/)
    for (const bad of ['password123', 'Password1234', 'qwertyuiop', '1234567890', 'aaaaaaaaaaaa', 'abcdefghijkl', 'Pangat@123', 'Welcome123', 'iloveyou']) assert.ok(passwordProblem(bad), bad)
    for (const good of ['correct horse battery', 'Tulsi-Wada-Pune-42', 'mY$tr0ng&uniqueP4ss']) assert.equal(passwordProblem(good), null, good)
    assert.match(passwordProblem('x'.repeat(129)), /at most 128/)
  })
  it('refuses passwords built from the person\'s own email or name', () => {
    assert.match(passwordProblem('nikhil-bhamare-2026', { name: 'Nikhil Bhamare' }), /name/)
    assert.match(passwordProblem('myasha.sharma99!', { email: 'asha.sharma@cafe.in' }), /email/)
    assert.equal(passwordProblem('Tulsi-Wada-Pune-42', { email: 'asha.sharma@cafe.in', name: 'Asha Sharma' }), null)
  })
  it('assertPasswordAllowed throws a readable 400', () => {
    assert.throws(() => assertPasswordAllowed('password123'), (e) => e instanceof BadRequestException && /common/.test(e.message))
    assert.doesNotThrow(() => assertPasswordAllowed('Tulsi-Wada-Pune-42'))
  })
  it('applies to the public DTOs (admin set-up used to accept 6 characters)', async () => {
    assert.ok((await validate(plainToInstance(SetupSuperAdminDto, { name: 'A', email: 'a@b.com', password: 'abc123' }))).length > 0)
    assert.equal((await validate(plainToInstance(SetupSuperAdminDto, { name: 'A', email: 'a@b.com', password: 'Tulsi-Wada-Pune-42' }))).length, 0)
    assert.ok((await validate(plainToInstance(ResetPasswordDto, { token: 't', newPassword: 'password1234' }))).length > 0)
  })
})

describe('temporary passwords must be replaced', () => {
  const guard = new JwtAuthGuard()
  const ctx = (url) => ({ switchToHttp: () => ({ getRequest: () => ({ originalUrl: url }) }) })
  // handleRequest of passport's AuthGuard returns the user when there is no error
  it('blocks every call except me / change-password / logout-all until the password is changed', () => {
    const u = { id: 's', mustChangePassword: true }
    for (const url of ['/api/v1/orders', '/api/v1/menu/items', '/api/v1/admin/restaurants', '/api/v1/auth/me/../orders']) {
      assert.throws(() => guard.handleRequest(null, u, null, ctx(url)), (e) => e.getResponse().code === 'PASSWORD_CHANGE_REQUIRED', url)
    }
    for (const url of ['/api/v1/auth/me', '/api/v1/auth/change-password', '/api/v1/auth/logout-all?x=1']) assert.strictEqual(guard.handleRequest(null, u, null, ctx(url)), u, url)
  })
  it('does nothing for normal accounts', () => {
    const u = { id: 's', mustChangePassword: false }
    assert.strictEqual(guard.handleRequest(null, u, null, ctx('/api/v1/orders')), u)
  })
  it('changing the password clears the flag and applies the policy', async () => {
    const bcrypt = (await import('bcrypt')).default
    const staff = { id: 's', name: 'Asha', email: 'asha@cafe.in', passwordHash: bcrypt.hashSync('Old-Password-Is-Fine-1', 4), role: 'STEWARD', mustChangePassword: true, restaurantId: 'r1' }
    const repo = { findOne: async () => staff, manager: { transaction: async (cb) => cb({ getRepository: () => ({ save: async (x) => x }) }) } }
    const svc = new AuthService(repo, { sign: () => 'jwt' }, {}, {}, { get: () => undefined }, {}, { record: async () => {} })
    await assert.rejects(() => svc.changePassword('s', 'Old-Password-Is-Fine-1', 'password1234'), /common/)
    assert.equal(staff.mustChangePassword, true)
    await svc.changePassword('s', 'Old-Password-Is-Fine-1', 'Tulsi-Wada-Pune-42')
    assert.equal(staff.mustChangePassword, false)
  })
})

describe('request references on errors', () => {
  it('every error body carries the request id that is also in the response header', async () => {
    const headers = {}
    let body
    await new Promise((resolve) => requestContextMiddleware({ ip: '1.1.1.1', headers: {}, socket: {} }, { setHeader: (k, v) => (headers[k] = v) }, () => {
      const res = { status: () => ({ json: (b) => (body = b) }) }
      new HttpExceptionFilter().catch(new BadRequestException('nope'), { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ method: 'GET', url: '/x', originalUrl: '/x' }) }) })
      resolve()
    }))
    assert.equal(body.requestId, headers['X-Request-Id']); assert.match(body.requestId, /^[0-9a-f-]{36}$/)
  })
})

describe('platform administrator sessions', () => {
  it('last 8 hours by default and use ADMIN_JWT_EXPIRATION when set; restaurant staff keep the configured lifetime', () => {
    const calls = []
    const svc = new AuthService({}, { sign: (p, o) => { calls.push(o); return 't' } }, {}, {}, { get: () => undefined })
    svc.signToken({}, true); assert.deepEqual(calls.pop(), { expiresIn: '8h' })
    process.env.ADMIN_JWT_EXPIRATION = '2h'; svc.signToken({}, true); assert.deepEqual(calls.pop(), { expiresIn: '2h' }); delete process.env.ADMIN_JWT_EXPIRATION
    svc.signToken({}, false); assert.equal(calls.pop(), undefined)
  })
})

describe('personal kitchen PINs', async () => {
  const bcrypt = (await import('bcrypt')).default
  const { RestaurantsService } = await import('../dist/restaurants/restaurants.service.js')
  const build = () => {
    const chefs = [
      { id: 'c1', email: 'ravi@cafe.in', name: 'Ravi', role: 'CHEF', isActive: true, restaurantId: 'r1', organizationId: 'o1', pinHash: bcrypt.hashSync('4321', 4) },
      { id: 'c2', email: 'sita@cafe.in', name: 'Sita', role: 'CHEF', isActive: true, restaurantId: 'r1', organizationId: 'o1', pinHash: null },
      { id: 'w1', email: 'asha@cafe.in', name: 'Asha', role: 'STEWARD', isActive: true, restaurantId: 'r1', organizationId: 'o1' },
    ]
    const audits = []
    const staffRepo = { findOne: async ({ where }) => chefs.find((c) => c.id === where.id && c.restaurantId === where.restaurantId) ?? null, find: async () => chefs.filter((c) => c.role === 'CHEF'), manager: { transaction: async (cb) => cb({ getRepository: () => ({ save: async (x) => x }) }) } }
    return { svc: new RestaurantsService({}, staffRepo, {}, undefined, { record: async (a) => { audits.push(a) } }), chefs, audits }
  }
  it('stores a hashed PIN for one chef, records who set it, and never logs the PIN', async () => {
    const { svc, chefs, audits } = build()
    await svc.setStaffPin('r1', 'c2', '8765', { id: 'o', name: 'Asha', role: 'SUPER_OWNER' })
    assert.ok(await bcrypt.compare('8765', chefs[1].pinHash)); assert.equal(chefs[1].pinCode, null)
    assert.equal(audits[0].action, 'STAFF_PIN_SET'); assert.ok(!JSON.stringify(audits).includes('8765'))
  })
  it('refuses a PIN another person at the outlet already uses, non-chefs and malformed PINs', async () => {
    const { svc } = build()
    await assert.rejects(() => svc.setStaffPin('r1', 'c2', '4321', {}), /already used/)
    await assert.rejects(() => svc.setStaffPin('r1', 'w1', '8765', {}), /Only kitchen/)
    await assert.rejects(() => svc.setStaffPin('r1', 'c2', '12', {}), /4 to 6 digits/)
    await assert.rejects(() => svc.setStaffPin('r1', 'c2', 'abcd', {}), /4 to 6 digits/)
  })
  it('a chef can keep or change their own PIN (it only conflicts with other people)', async () => {
    const { svc } = build()
    await svc.setStaffPin('r1', 'c1', '4321', {})
  })
})

describe('flood protection', async () => {
  const { SlidingWindowLimiter } = await import('../dist/common/security/sliding-window.js')
  it('allows the limit inside the window, refuses beyond it, and recovers as time passes; keys are independent', () => {
    const l = new SlidingWindowLimiter(3, 1000)
    assert.deepEqual([0, 100, 200, 300].map((t) => l.allow('a', t)), [true, true, true, false])
    assert.equal(l.allow('b', 300), true)
    assert.equal(l.allow('a', 1001), true) // the first hit has aged out
    assert.equal(l.allow('a', 1002), false)
  })
})
