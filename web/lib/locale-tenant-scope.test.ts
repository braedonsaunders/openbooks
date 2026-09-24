import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.locale-tenant-scope-test')
const state = { orgReads: 0 }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mocks = new Map([
  ['mock:headers', `export async function cookies() { throw new Error('no request context') }`],
  ['mock:auth', `export const SESSION_COOKIE = 'session'; export async function validateSessionToken() { return null }`],
  ['mock:db', `
    const state = globalThis[Symbol.for('openbooks.locale-tenant-scope-test')]
    export async function withBypassContext(work) { return work() }
    export const db = { async execute() { state.orgReads++; return { rows: [{ org_default: 'fr' }] } } }
  `],
])

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === 'next/headers') return { shortCircuit: true, url: 'mock:headers' }
    if (specifier === './auth' && context.parentURL?.includes('/web/lib/locale.ts')) {
      return { shortCircuit: true, url: 'mock:auth' }
    }
    if (specifier === '@openbooks/engine/src/platform/db.ts' && context.parentURL?.includes('/web/lib/locale.ts')) {
      return { shortCircuit: true, url: 'mock:db' }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mocks.get(url)
    return source === undefined ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true }
  },
})

const { resolveLocale } = await import('./locale.ts')
const { DEFAULT_LOCALE } = await import('../i18n/config')

test('locale resolution without an authenticated tenant never reads an arbitrary org setting', async () => {
  assert.equal(await resolveLocale(), DEFAULT_LOCALE)
  assert.equal(state.orgReads, 0)
})
