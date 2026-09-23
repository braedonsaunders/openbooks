import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { registerHooks } from 'node:module'

const dir = dirname(fileURLToPath(import.meta.url))
const root = join(dir, '..', '..', '..', '..')

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

const paymentProvidersSource = readFileSync(join(dir, 'payment-providers', 'view.ts'), 'utf8')
const wizardSource = readFileSync(join(dir, 'wizard', 'SetupWizard.tsx'), 'utf8')
const rootPageSource = readFileSync(join(dir, '..', '..', 'page.tsx'), 'utf8')
const brandLinkSource = readFileSync(join(root, 'components', 'brand-home-link.tsx'), 'utf8')

test('the payment-providers gate names its destination and reason', () => {
  // The Online-payments-off gate must send readers to Features with the
  // movedFrom source the notice reads — a bare '/admin/setup/features'
  // redirect lands silently.
  assert.match(paymentProvidersSource, /movedUrl\('\/admin\/setup\/features', 'payment-providers'/)
  assert.doesNotMatch(paymentProvidersSource, /redirect\('\/admin\/setup\/features'\)/)
})

test('first-run Skip lands on the canonical home and names the resume', () => {
  // Skip is a deferral: the wizard must not detour into Setup, and the toast
  // must say setup resumes from Company Setup.
  assert.match(wizardSource, /toast\.success\(t\('skipped'\)\)/)
  assert.match(wizardSource, /router\.push\('\/dashboard'\)/)
})

test('/ is a bookmark alias for the one canonical home', () => {
  assert.match(rootPageSource, /redirect\('\/dashboard'\)/)
  assert.match(brandLinkSource, /href="\/dashboard"/)
})
