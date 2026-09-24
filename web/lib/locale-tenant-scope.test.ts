import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.locale-tenant-scope-test')
const state = { orgReads: 0, activeUser: null as { id: string; orgId: string } | null, locale: null as string | null, timeZone: null as string | null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

const mocks = new Map([
  ['mock:headers', `export async function cookies() { throw new Error('no request context') }`],
  ['mock:auth', `export const SESSION_COOKIE='session'; export async function validateSessionToken(){return null}; export async function currentUser(){return globalThis[Symbol.for('openbooks.locale-tenant-scope-test')].activeUser}`],
  ['mock:db', `const state=globalThis[Symbol.for('openbooks.locale-tenant-scope-test')]; export async function withBypassContext(work){return work()}; export const db={async execute(){state.orgReads++;return{rows:[{user_locale:state.locale,org_default:'fr',time_zone:state.timeZone}]}}}`],
])

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === 'next/headers') return { shortCircuit: true, url: 'mock:headers' }
    if (specifier === './auth' && context.parentURL?.includes('/web/lib/locale.ts')) return { shortCircuit: true, url: 'mock:auth' }
    if (specifier === '@openbooks/engine/src/platform/db.ts' && context.parentURL?.includes('/web/lib/locale.ts')) return { shortCircuit: true, url: 'mock:db' }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mocks.get(url)
    return source === undefined ? nextLoad(url, context) : { format: 'module', source, shortCircuit: true }
  },
})

const { resolveLocale, resolveTimeZone } = await import('./locale.ts')
const { DEFAULT_LOCALE } = await import('../i18n/config')

test('locale resolution without an authenticated tenant never reads an arbitrary org setting', async () => {
  assert.equal(await resolveLocale(), DEFAULT_LOCALE)
  assert.equal(await resolveTimeZone(), 'UTC')
  assert.equal(state.orgReads, 0)
})

test('locale and time zone follow the verified active tenant', async () => {
  state.activeUser = { id: 'acting-user', orgId: 'switched-tenant' }
  state.locale = null; state.timeZone = 'Asia/Tokyo'
  assert.equal(await resolveLocale(), 'fr')
  assert.equal(await resolveTimeZone(), 'Asia/Tokyo')
  assert.equal(state.orgReads, 2)
})
