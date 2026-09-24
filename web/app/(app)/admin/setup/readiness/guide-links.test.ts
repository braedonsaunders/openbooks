// source-pin-contract: readiness guide hrefs resolve against the route tree; subjects derived by extracting every href the guide loader emits, never hand-listed
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// F-t11-008: the readiness guide linked area 5 at /admin/setup/accounts,
// which never existed (the chart of accounts lives at /accounts). Guide
// hrefs rot silently — no type or test covers them — so every href the
// loader emits is pinned here against the route tree: a static segment, a
// registry entity served by setup/[entity], or one of that page's three
// bespoke keys. Only server-only is stubbed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    return nextResolve(specifier, context)
  },
})

const { SETUP_ENTITY_BY_KEY } = await import('../../../../../lib/setup/registry.ts')

// Mirrors the bespoke branches in setup/[entity]/view.ts (isCompany,
// isPeriodClose, isFxProvider): keys with no registry entry and no static
// segment that still render.
const BESPOKE_SETUP_KEYS = new Set(['company', 'period-close', 'fx-provider'])

const here = dirname(fileURLToPath(import.meta.url))
const appDir = join(here, '..', '..', '..')
const view = readFileSync(join(here, 'view.ts'), 'utf8')
const hrefs = [...new Set([...view.matchAll(/href: '([^']+)'/g)].map((m) => m[1]!))]

test('the readiness guide links only to routes that exist', () => {
  assert.ok(hrefs.length > 0, 'the loader emits guide hrefs')
  for (const href of hrefs) {
    if (href.startsWith('/admin/setup/')) {
      const key = href.slice('/admin/setup/'.length)
      const alive =
        existsSync(join(appDir, 'admin', 'setup', key)) ||
        BESPOKE_SETUP_KEYS.has(key) ||
        SETUP_ENTITY_BY_KEY.has(key)
      assert.ok(alive, `guide href ${href} resolves to a setup surface`)
    } else {
      assert.ok(existsSync(join(appDir, href.slice(1))), `guide href ${href} resolves to a route`)
    }
  }
})

test('the bank-accounts action lands on the chart of accounts', () => {
  assert.match(view, /href: '\/accounts'/, 'area 5 links at /accounts, not a setup subpath')
  assert.doesNotMatch(view, /admin\/setup\/accounts/, 'the dead setup/accounts target is gone')
})
