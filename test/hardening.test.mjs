import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildCorsPolicy } from '../dist/common/security/cors.js'
import { resolveJwtSecret, resolveSettingsKey } from '../dist/common/security/secrets.js'
import { HttpExceptionFilter } from '../dist/common/filters/http-exception.filter.js'

describe('CORS policy (S-4)', () => {
  const prod = (extra = {}) => buildCorsPolicy({ NODE_ENV: 'production', FRONTEND_URL: 'https://app.example.com/', ...extra })
  it('allows exactly the configured origin (trailing slash / case ignored) and non-browser callers', () => {
    const p = prod()
    assert.equal(p.isAllowed('https://app.example.com'), true)
    assert.equal(p.isAllowed('HTTPS://APP.EXAMPLE.COM'), true)
    assert.equal(p.isAllowed(undefined), true)
  })
  it('blocks look-alike, wildcard-host and hosted-platform origins by default', () => {
    const p = prod()
    for (const o of ['https://evil.example', 'https://attacker.netlify.app', 'https://x.vercel.app', 'https://x.onrender.com', 'https://app.example.com.evil.io', 'null', 'http://localhost:5173']) assert.equal(p.isAllowed(o), false, o)
  })
  it('opt-in suffixes work for https only and respect dot boundaries', () => {
    const p = prod({ CORS_ALLOWED_SUFFIXES: '.netlify.app' })
    assert.equal(p.isAllowed('https://deploy-preview-1--pangat.netlify.app'), true)
    assert.equal(p.isAllowed('http://pangat.netlify.app'), false)
    assert.equal(p.isAllowed('https://evilnetlify.app'), false)
    assert.equal(p.isAllowed('https://attacker.com'), false)
  })
  it('production without FRONTEND_URL blocks browsers; development stays open', () => {
    assert.equal(buildCorsPolicy({ NODE_ENV: 'production' }).isAllowed('https://anything.example'), false)
    assert.equal(buildCorsPolicy({ NODE_ENV: 'development' }).isAllowed('http://localhost:5173'), true)
    assert.equal(buildCorsPolicy({ NODE_ENV: 'production' }).isAllowed(undefined), true)
  })
})

describe('Secret resolution (S-6)', () => {
  const withEnv = (env, fn) => { const keep = { ...process.env }; for (const k of ['NODE_ENV', 'JWT_SECRET', 'PLATFORM_SETTINGS_KEY', 'ALLOW_INSECURE_DEV_SECRET']) delete process.env[k]; Object.assign(process.env, env); try { return fn() } finally { for (const k of ['NODE_ENV', 'JWT_SECRET', 'PLATFORM_SETTINGS_KEY', 'ALLOW_INSECURE_DEV_SECRET']) delete process.env[k]; Object.assign(process.env, Object.fromEntries(Object.entries(keep).filter(([k]) => ['NODE_ENV', 'JWT_SECRET', 'PLATFORM_SETTINGS_KEY', 'ALLOW_INSECURE_DEV_SECRET'].includes(k)))) } }
  const GOOD = 'x'.repeat(40)
  it('a strong secret is accepted in any environment', () => { for (const NODE_ENV of ['production', 'staging', undefined, 'development']) assert.equal(withEnv({ ...(NODE_ENV ? { NODE_ENV } : {}), JWT_SECRET: GOOD }, () => resolveJwtSecret()), GOOD) })
  it('missing NODE_ENV or a non-dev NODE_ENV never falls back to the public dev secret', () => { for (const NODE_ENV of [undefined, 'production', 'staging', 'prod']) assert.throws(() => withEnv(NODE_ENV ? { NODE_ENV } : {}, () => resolveJwtSecret()), /JWT_SECRET/) })
  it('the dev fallback is only for NODE_ENV=development|test', () => { for (const NODE_ENV of ['development', 'test']) assert.match(withEnv({ NODE_ENV }, () => resolveJwtSecret()), /dev_only/) })
  it('settings encryption key follows PLATFORM_SETTINGS_KEY, then the JWT secret, never a constant in production', () => {
    assert.equal(withEnv({ NODE_ENV: 'production', PLATFORM_SETTINGS_KEY: 'k'.repeat(32), JWT_SECRET: GOOD }, () => resolveSettingsKey()), 'k'.repeat(32))
    assert.equal(withEnv({ NODE_ENV: 'production', JWT_SECRET: GOOD }, () => resolveSettingsKey()), GOOD)
    assert.throws(() => withEnv({ NODE_ENV: 'production' }, () => resolveSettingsKey()))
  })
})

describe('Error filter (S-7)', () => {
  const run = (exception) => {
    const out = {}
    const res = { status(c) { out.status = c; return this }, json(b) { out.body = b; return this } }
    const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ method: 'POST', url: '/x', originalUrl: '/x' }) }) }
    new HttpExceptionFilter().catch(exception, host)
    return out
  }
  it('oversized body -> 413 with a generic message', () => {
    const r = run(Object.assign(new Error('request entity too large'), { status: 413, statusCode: 413, type: 'entity.too.large', expose: true }))
    assert.equal(r.status, 413); assert.deepEqual(r.body.message, ['Request body is too large'])
  })
  it('malformed JSON -> 400 without echoing parser internals', () => {
    const r = run(Object.assign(new SyntaxError('Unexpected token } in JSON at position 5'), { status: 400, statusCode: 400, type: 'entity.parse.failed', expose: true }))
    assert.equal(r.status, 400); assert.deepEqual(r.body.message, ['Malformed request body'])
    assert.ok(!JSON.stringify(r.body).includes('position'))
  })
  it('unexpected errors stay 500 and are not echoed', () => {
    const r = run(new Error('relation "staff" does not exist'))
    assert.equal(r.status, 500); assert.deepEqual(r.body.message, ['Internal server error'])
  })
})

import { resolveDbSsl } from '../dist/common/security/db-ssl.js'
describe('Database TLS (S-1)', () => {
  const PEM = '-----BEGIN CERTIFICATE-----\\nABC\\n-----END CERTIFICATE-----'
  it('DATABASE_SSL=false is the only way to run production mode without TLS, and it never overrides a hosted or sslmode=require database', () => {
    const off = resolveDbSsl({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u@localhost/db', DATABASE_SSL: 'false' })
    assert.equal(off.ssl, false); assert.match(off.warning, /TLS is OFF/)
    assert.notEqual(resolveDbSsl({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u@ep-x.neon.tech/db', DATABASE_SSL: 'false' }).ssl, false)
    assert.notEqual(resolveDbSsl({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u@h/db?sslmode=require', DATABASE_SSL: 'false' }).ssl, false)
    assert.notEqual(resolveDbSsl({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u@db.internal/x' }).ssl, false) // default stays TLS-on
    assert.notEqual(resolveDbSsl({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u@db.internal/x', DATABASE_SSL: 'true' }).ssl, false)
  })
  it('local plain database: no TLS', () => assert.equal(resolveDbSsl({ NODE_ENV: 'development', DATABASE_URL: 'postgres://u@localhost/db' }).ssl, false))
  it('production without a CA keeps working but warns that the certificate is unverified', () => {
    const r = resolveDbSsl({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u@db.internal/x' })
    assert.equal(r.ssl.rejectUnauthorized, false); assert.match(r.warning, /DATABASE_CA/)
  })
  it('a provided CA turns verification on and is passed through (with \\n unescaped)', () => {
    const r = resolveDbSsl({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u@db/x', DATABASE_CA: PEM })
    assert.equal(r.ssl.rejectUnauthorized, true); assert.ok(r.ssl.ca.includes('\n')); assert.equal(r.warning, undefined)
  })
  it('publicly trusted providers (neon.tech) are verified by default', () => assert.equal(resolveDbSsl({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u@ep-1.neon.tech/x' }).ssl.rejectUnauthorized, true))
  it('the explicit flag wins either way', () => {
    assert.equal(resolveDbSsl({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u@db/x', DATABASE_SSL_REJECT_UNAUTHORIZED: 'true' }).ssl.rejectUnauthorized, true)
    assert.equal(resolveDbSsl({ NODE_ENV: 'production', DATABASE_URL: 'postgres://u@ep.neon.tech/x', DATABASE_SSL_REJECT_UNAUTHORIZED: 'false' }).ssl.rejectUnauthorized, false)
  })
})
