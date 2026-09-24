import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks } from 'node:module'

// UX-17: the setup aliases must explain themselves on arrival. These are
// real pages with only the navigation primitives scripted — a mistyped
// destination or a dropped param redirects wrong at runtime where tsc
// stays silent.
const NAV_MOCK = `
  export function redirect(url) { throw new Error('REDIRECT:' + url) }
  export function notFound() { throw new Error('NOT_FOUND') }
`
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,' + encodeURIComponent(NAV_MOCK) }
    }
    return nextResolve(specifier, context)
  },
})

const SettingsPage = (await import('../settings/page.tsx')).default as (props: unknown) => Promise<never>
const SetupIndexPage = (await import('./page.tsx')).default as (props: unknown) => Promise<never>
const RootPage = (await import('../../page.tsx')).default as () => never
hooks.deregister()

const sp = (params: Record<string, string | string[] | undefined>) => ({ searchParams: Promise.resolve(params) })

test('/admin/settings lands on Company Setup named as a move', async () => {
  await assert.rejects(SettingsPage(sp({})), /REDIRECT:\/admin\/setup\/company\?movedFrom=settings/)
})

test('/admin/settings keeps the reader context across the move', async () => {
  await assert.rejects(
    SettingsPage(sp({ tab: 'tax' })),
    /REDIRECT:\/admin\/setup\/company\?tab=tax&movedFrom=settings/,
  )
})

test('/admin/setup lands on the readiness guide named as a move', async () => {
  await assert.rejects(SetupIndexPage(sp({})), /REDIRECT:\/admin\/setup\/readiness\?movedFrom=setup-index/)
})

test('/ is a bookmark alias for the one canonical home', () => {
  assert.throws(() => RootPage(), /REDIRECT:\/dashboard/)
})

// The Online-payments-off gate must send readers to Features with the
// movedFrom source the notice reads — a bare '/admin/setup/features'
// redirect lands silently. Loaded for real with only authz, features and
// server-only scripted.
const gateHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier.endsWith('/lib/authz')) {
      return { shortCircuit: true, format: 'module', url: 'mock:alias-gate-authz' }
    }
    if (specifier.endsWith('/lib/features')) {
      return { shortCircuit: true, format: 'module', url: 'mock:alias-gate-features' }
    }
    if (specifier === 'next/navigation') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,' + encodeURIComponent(NAV_MOCK) }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url === 'mock:alias-gate-authz') {
      return {
        format: 'module',
        source: `export async function requirePermission() { return { user: { orgId: 'o1' } }; }`,
        shortCircuit: true,
      }
    }
    if (url === 'mock:alias-gate-features') {
      return {
        format: 'module',
        source: `export async function resolvedFeatureState() { return globalThis.__aliasOnlinePayments ? { onlinePayments: true } : {}; }
          export function featureEnabled(features, key) { return features?.[key] === true; }`,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

const { loadPaymentProviders } = (await import('./payment-providers/view.ts')) as typeof import(
  './payment-providers/view.ts'
)
gateHooks.deregister()

test('the payment-providers gate names its destination and reason', async () => {
  ;(globalThis as Record<string, unknown>).__aliasOnlinePayments = false
  try {
    await assert.rejects(
      loadPaymentProviders(),
      /REDIRECT:\/admin\/setup\/features\?movedFrom=payment-providers/,
    )
  } finally {
    ;(globalThis as Record<string, unknown>).__aliasOnlinePayments = false
  }
})

test('the payment-providers gate stays home while Online payments is on', async () => {
  ;(globalThis as Record<string, unknown>).__aliasOnlinePayments = true
  try {
    assert.deepEqual(await loadPaymentProviders(), {})
  } finally {
    ;(globalThis as Record<string, unknown>).__aliasOnlinePayments = false
  }
})
