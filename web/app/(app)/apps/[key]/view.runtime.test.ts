import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

// F4-7: the installed-app runtime notices ("App not found", "This app is
// not installed...", "This app is currently disabled.", "Back to apps")
// were hardcoded English literals in the loader, so a non-English operator
// read English on the missing/disabled branches. The loader now resolves
// all four through the apps.runtime catalog keys in the request locale,
// like the sibling library loader.

// The platform seams (auth gate, app store, request locale) are stubbed;
// the MESSAGE resolution is real: getTranslations answers from the actual
// fr catalog file, so hardcoded English would fail and keyed lookups pass.
const frApps = JSON.parse(
  readFileSync(new URL('../../../../messages/fr/apps.json', import.meta.url), 'utf8'),
) as Record<string, unknown>
const enApps = JSON.parse(
  readFileSync(new URL('../../../../messages/en/apps.json', import.meta.url), 'utf8'),
) as Record<string, unknown>

function lookup(tree: Record<string, unknown>, key: string): string {
  const value = key.split('.').reduce<unknown>((node, part) => {
    if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
      return (node as Record<string, unknown>)[part]
    }
    return undefined
  }, tree)
  assert.equal(typeof value, 'string', `fr catalog must carry apps.${key}`)
  return value as string
}

const state = { app: null as null | { key: string; name: string; status: string; activeVersionId: string } }

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === 'next-intl/server') return { shortCircuit: true, url: 'mock:apps-runtime-intl' }
    if (specifier === '@/lib/authz') return { shortCircuit: true, url: 'mock:apps-runtime-authz' }
    if (specifier === '@/lib/apps/store') return { shortCircuit: true, url: 'mock:apps-runtime-store' }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:apps-runtime-intl') {
      return {
        format: 'module',
        source: `export async function getTranslations(namespace) {
          const state = globalThis[Symbol.for('openbooks.apps-runtime-test')];
          return (key) => state.lookup(state.catalog, key);
        }`,
        shortCircuit: true,
      }
    }
    if (url === 'mock:apps-runtime-authz') {
      return {
        format: 'module',
        source: `export async function requirePermission() {
          return { user: { id: 'u1', orgId: 'o1', name: 'Op', roles: [] } };
        }`,
        shortCircuit: true,
      }
    }
    if (url === 'mock:apps-runtime-store') {
      return {
        format: 'module',
        source: `export async function getAppByKey() {
          return globalThis[Symbol.for('openbooks.apps-runtime-test')].app;
        }`,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

;(globalThis as Record<symbol, unknown>)[Symbol.for('openbooks.apps-runtime-test')] = {
  catalog: frApps,
  lookup: (tree: Record<string, unknown>, key: string) => lookup(tree, key),
  get app() {
    return state.app
  },
}

const viewSpecifier: string = './view.ts?apps-runtime-test'
const { loadAppRuntime } = (await import(viewSpecifier)) as typeof import('./view')
hooks.deregister()

test('a missing app resolves French notice copy from the catalog', async () => {
  state.app = null
  const data = await loadAppRuntime('ghost')
  assert.equal(data.notFound, true)
  assert.equal(data.noticeTitle, lookup(frApps, 'runtime.notFoundTitle'))
  assert.equal(data.noticeDescription, lookup(frApps, 'runtime.notInstalled'))
  assert.equal(data.backLabel, `← ${lookup(frApps, 'runtime.backToApps')}`)
  assert.equal(data.appsLabel, lookup(frApps, 'title'))
  const en = enApps.runtime as Record<string, string>
  assert.notEqual(data.noticeTitle, en.notFoundTitle, 'no English notice title may leak into the French branch')
  assert.notEqual(
    data.noticeDescription,
    en.notInstalled,
    'no English notice description may leak into the French branch',
  )
})

test('a disabled app resolves the French disabled notice', async () => {
  state.app = { key: 'billing', name: 'Facturation', status: 'disabled', activeVersionId: 'v3' }
  const data = await loadAppRuntime('billing')
  assert.equal(data.disabled, true)
  assert.equal(data.noticeTitle, 'Facturation')
  assert.equal(data.noticeDescription, lookup(frApps, 'runtime.disabled'))
  assert.notEqual(
    data.noticeDescription,
    (enApps.runtime as Record<string, string>).disabled,
    'no English disabled notice may leak into the French branch',
  )
})
