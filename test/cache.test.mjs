import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TtlCache } from '../dist/common/cache/ttl-cache.js'

describe('TtlCache (public menu cache)', () => {
  it('coalesces concurrent loads and reuses the value within the TTL', async () => {
    const c = new TtlCache(1000); let calls = 0
    const load = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { n: calls } }
    const [a, b, d] = await Promise.all([c.wrap('k', load), c.wrap('k', load), c.wrap('k', load)])
    assert.equal(calls, 1); assert.equal(a, b); assert.equal(b, d)
    await c.wrap('k', load); assert.equal(calls, 1)
  })
  it('reloads after the TTL and keeps keys separate', async () => {
    const c = new TtlCache(30); let n = 0
    await c.wrap('a', async () => ++n); await c.wrap('b', async () => ++n); assert.equal(n, 2)
    await new Promise((r) => setTimeout(r, 50)); await c.wrap('a', async () => ++n); assert.equal(n, 3)
  })
  it('clear() drops cached values and a load that started before the write is not cached', async () => {
    const c = new TtlCache(10_000); let v = 1
    await c.wrap('k', async () => v); v = 2; c.clear()
    assert.equal(await c.wrap('k', async () => v), 2)
    let release; const gate = new Promise((r) => (release = r))
    const slow = c.wrap('s', async () => { await gate; return 'old' }); c.clear(); release()
    assert.equal(await slow, 'old')
    assert.equal(await c.wrap('s', async () => 'new'), 'new')
  })
  it('does not cache failures', async () => {
    const c = new TtlCache(10_000); let n = 0
    await assert.rejects(() => c.wrap('e', async () => { n++; throw new Error('boom') }))
    assert.equal(await c.wrap('e', async () => 'ok'), 'ok'); assert.equal(n, 1)
  })
  it('evicts the oldest entries past the cap', async () => {
    const c = new TtlCache(10_000, 2); let n = 0
    for (const k of ['a', 'b', 'c']) await c.wrap(k, async () => ++n)
    await c.wrap('a', async () => ++n); assert.equal(n, 4)
  })
})
