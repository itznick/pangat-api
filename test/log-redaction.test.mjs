import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Logger, HttpException } from '@nestjs/common';
import { redactUrl, redactText, redactObject } from '../dist/common/log-redaction.js';
import { HttpExceptionFilter } from '../dist/common/filters/http-exception.filter.js';
import { redact } from '../dist/platform/monitoring.service.js';

const SECRET = 'tok_9f8e7d6c5b4a39281706f5e4d3c2b1a0';

describe('URL redaction', () => {
  it('masks credential query values and keeps everything else', () => {
    assert.equal(redactUrl(`/api/v1/orders/abc?token=${SECRET}&limit=5`), '/api/v1/orders/abc?token=[redacted]&limit=5');
    assert.equal(redactUrl('/x?pin=1234&pinCode=9&otp=111111&code=abc&password=hunter2&api_key=k&signature=s&reset=r'), '/x?pin=[redacted]&pinCode=[redacted]&otp=[redacted]&code=[redacted]&password=[redacted]&api_key=[redacted]&signature=[redacted]&reset=[redacted]');
    assert.equal(redactUrl('/menu/public/cafe?restaurantSlug=cafe'), '/menu/public/cafe?restaurantSlug=cafe');
    assert.equal(redactUrl('/no-query'), '/no-query');
  });
  it('is case-insensitive, handles encoded keys and repeated or empty parameters, and never throws', () => {
    assert.equal(redactUrl('/x?TOKEN=a&Tracking_Token=b&%74oken=c&token='), '/x?TOKEN=[redacted]&Tracking_Token=[redacted]&%74oken=[redacted]&token=[redacted]');
    for (const weird of [undefined, null, 5, '?', '/x?&&=&', '/x?%E0%A4%A=1', {}]) assert.doesNotThrow(() => redactUrl(weird));
  });
  it('limits the length of what is kept', () => assert.ok(redactUrl('/x?a=' + 'b'.repeat(5000)).length <= 500));
});

describe('text and object redaction', () => {
  it('masks bearer tokens and key=value / JSON credential shapes inside messages and stacks', () => {
    const t = redactText(`failed for Bearer eyJhbGciOi.abc.def and ?token=${SECRET}&x=1 {"password":"hunter2","pinCode":"2468"} password=hunter2`);
    for (const leak of ['eyJhbGciOi', SECRET, 'hunter2', '2468']) assert.ok(!t.includes(leak), `leaked ${leak}: ${t}`);
    assert.ok(t.includes('x=1'));
  });
  it('the error-log redactor also masks them (and still masks emails)', () => {
    const t = redact(`bad request /orders?token=${SECRET} for owner@cafe.in`, 400);
    assert.ok(!t.includes(SECRET)); assert.ok(!t.includes('owner@cafe.in'));
  });
  it('redactObject masks credential fields at any depth without changing the input', () => {
    const input = { user: 'a', password: 'p', nested: { token: 't', list: [{ pin: '1234', ok: 1 }] } };
    const out = redactObject(input);
    assert.deepEqual(out, { user: 'a', password: '[redacted]', nested: { token: '[redacted]', list: [{ pin: '[redacted]', ok: 1 }] } });
    assert.equal(input.password, 'p');
  });
});

describe('the global error filter never writes a credential to the log or the response', () => {
  const run = (exception, url) => {
    const lines = [];
    const orig = [Logger.prototype.error, Logger.prototype.warn];
    Logger.prototype.error = function (...a) { lines.push(a.map(String).join(' ')); };
    Logger.prototype.warn = function (...a) { lines.push(a.map(String).join(' ')); };
    let body; let status;
    const res = { status(s) { status = s; return this; }, json(b) { body = b; } };
    const req = { method: 'GET', url, originalUrl: url, user: null };
    try { new HttpExceptionFilter().catch(exception, { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) }); }
    finally { [Logger.prototype.error, Logger.prototype.warn] = orig; }
    return { lines: lines.join('\n'), body, status };
  };
  it('a server error on a tracking URL: the log line and the error body carry no token', () => {
    const e = new Error(`relation failed at /api/v1/orders/1?token=${SECRET}`);
    e.stack = `Error: ${e.message}\n    at x (file.js:1:1)`;
    const r = run(e, `/api/v1/orders/1?token=${SECRET}`);
    assert.equal(r.status, 500);
    assert.ok(!r.lines.includes(SECRET), `log leaked the token: ${r.lines}`);
    assert.ok(r.lines.includes('[redacted]'));
    assert.ok(!JSON.stringify(r.body).includes(SECRET), 'the response echoed the token');
  });
  it('a client error also keeps the token out of the echoed path', () => {
    const r = run(new HttpException('nope', 403), `/api/v1/orders/1/bill?token=${SECRET}`);
    assert.ok(!JSON.stringify(r.body).includes(SECRET));
    assert.equal(r.body.path, '/api/v1/orders/1/bill?token=[redacted]');
  });
});

import { hasNullByte, NoNullBytesGuard } from '../dist/common/guards/no-null-bytes.guard.js';
describe('NUL bytes are refused before they reach the database', () => {
  it('finds them in strings, nested objects and arrays, and in keys', () => {
    assert.equal(hasNullByte('a\u0000b'), true);
    assert.equal(hasNullByte({ a: { b: ['ok', 'x\u0000'] } }), true);
    assert.equal(hasNullByte({ 'k\u0000': 1 }), true);
    assert.equal(hasNullByte({ a: ['fine', 1, null, { b: 'c' }] }), false);
    assert.equal(hasNullByte(undefined), false);
  });
  it('the guard answers 400 for a NUL in the path (encoded), the query or the body, and passes clean requests', () => {
    const ctx = (req) => ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => req }) });
    const g = new NoNullBytesGuard();
    assert.equal(g.canActivate(ctx({ url: '/api/v1/menu/public/cafe', query: {}, body: {}, params: {} })), true);
    for (const bad of [{ url: '/menu/public/%00' }, { url: '/x', query: { a: 'b\u0000' } }, { url: '/x', body: { name: 'a\u0000' } }]) {
      assert.throws(() => g.canActivate(ctx({ query: {}, body: {}, params: {}, ...bad })), (e) => e.getStatus() === 400);
    }
  });
});
