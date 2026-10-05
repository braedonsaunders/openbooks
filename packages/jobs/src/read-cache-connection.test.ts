import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
const state = { connections: 0, fail: false, options: {} as Record<string, unknown> }
Object.assign(globalThis, { __readCacheConnectionTest: state })
registerHooks({ resolve(specifier, context, next) {
  if (specifier !== 'ioredis') return next(specifier, context)
  return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent(`
    export class Redis {
      status = 'wait';
      constructor(url, options) { globalThis.__readCacheConnectionTest.options = options; }
      on() {}
      async connect() {
        const state = globalThis.__readCacheConnectionTest;
        state.connections += 1; this.status = 'connecting';
        await new Promise(resolve => setTimeout(resolve, 5));
        if (state.fail) { this.status = 'reconnecting'; throw new Error('Redis unavailable'); }
        this.status = 'ready';
      }
      async quit() { this.status = 'end'; }
      disconnect() { this.status = 'end'; }
    }
  `) }
} })
const { getReadCacheConnection, closeJobConnections } = await import('./connection')
const original = process.env.OPENBOOKS_REDIS_URL
process.env.OPENBOOKS_REDIS_URL = 'redis://cache.test:6379'
test.after(async () => { await closeJobConnections(); if (original === undefined) delete process.env.OPENBOOKS_REDIS_URL; else process.env.OPENBOOKS_REDIS_URL = original })

test('one thousand initial cache reads await one ready connection instead of falling back during its handshake', async () => {
  const clients = await Promise.all(Array.from({ length: 1000 }, () => getReadCacheConnection()))
  assert.equal(state.connections, 1)
  assert.ok(clients[0])
  assert.ok(clients.every((client) => client === clients[0]))
  assert.equal(clients[0]!.status, 'ready')
})

test('cache transport queues no offline commands and bounds both connect and command latency', () => {
  assert.equal(state.options.enableOfflineQueue, false)
  assert.equal(state.options.connectTimeout, 250)
  assert.equal(state.options.commandTimeout, 250)
  assert.equal(state.options.maxRetriesPerRequest, 1)
})

test('a failed handshake returns unavailability to every caller without throwing away their source read', async () => {
  await closeJobConnections(); state.fail = true
  const clients = await Promise.all(Array.from({ length: 100 }, () => getReadCacheConnection()))
  assert.ok(clients.every((client) => client === undefined))
  assert.equal(state.connections, 2)
})
