import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../../testing/jsdom-env.ts'

const { registerHooks } = await import('node:module')
await bootJsdomEnvironment({ url: 'http://localhost:4800/migrate' })
stubModules({ navigation: { source: 'export function useRouter(){return{push(){},refresh(){},replace(){},prefetch(){}}}export function usePathname(){return \'/migrate\'}export function useSearchParams(){return new URLSearchParams()}' }, intl: false, authz: false, features: false })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'next/link') {
      return { shortCircuit: true, url: "data:text/javascript,export default function Link(p){return globalThis.React.createElement('a',{href:p.href,className:p.className},p.children)}" }
    }
    return next(specifier, context)
  },
})

const React = await import('react')
Object.assign(globalThis, { React })
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { NextIntlClientProvider } = await import('next-intl')
const english = (await import('../../messages/en')).default
const french = (await import('../../messages/fr')).default
const { MigrationCutover } = await import('./migration-cutover')
const { emptyMigrationPlan } = await import('../../lib/migration/plan-model')
const { deriveCutoverChecks, deriveJourney } = await import('../../lib/migration/journey-model')
type JourneyFacts = import('../../lib/migration/journey-model').JourneyFacts
type MigrationJourney = import('../../lib/migration/journey').MigrationJourney

globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.startsWith('/api/data/transfers')) {
    return new Response(JSON.stringify({ jobs: [] }), { headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify({ journey: null }), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch

function journey(): MigrationJourney {
  const plan = { ...emptyMigrationPlan(), path: 'spreadsheet' as const, sourceSystem: 'spreadsheet', sourceLabel: 'Manual books', cutoverDate: '2026-11-01' }
  const facts: JourneyFacts = {
    plan, sourceName: 'Manual books', bookStart: 'migrate', profileReady: true, foundationReady: true,
    counts: { accounts: 42, postedEntries: 0, bankAccounts: 1, parties: 6, items: 0 },
    connection: null, connections: [],
    runs: { preflight: null, migration: null, mirror: null },
    imports: [{ resource: 'txn:customer_invoice', label: 'customer invoices', committedJobs: 1, created: 9, updated: 0, lastAt: '2026-10-01T00:00:00Z' }],
    openingJournal: null,
  }
  const checks = deriveCutoverChecks(facts, { receivablesResidual: null, payablesResidual: null, clearingBalance: null, unlockedPrecutoverPeriods: null, precutoverPeriods: null, unavailable: {} })
  return { plan, facts, stages: deriveJourney(facts, checks), checks: null, measuredAt: '2026-10-07T12:00:00Z' }
}

async function mount(messages: Record<string, unknown>, locale: string, aiEnabled = true) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    /* eslint-disable react/no-children-prop */
    root.render(React.createElement(NextIntlClientProvider, {
      locale, messages, timeZone: 'UTC',
      children: React.createElement(MigrationCutover, {
        journey: journey(), accounts: [], canDraftOpening: true, canImport: true, aiEnabled,
      }),
    }))
    /* eslint-enable react/no-children-prop */
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

test('the guided cutover works without the assistant: checklist, opening draft, and checks, no dead end', async () => {
  const { host, unmount } = await mount(english, 'en', false)
  try {
    const text = host.textContent ?? ''
    assert.match(text, /Move your books/)
    assert.match(text, /Cutover checklist/)
    assert.match(text, /Post the opening trial balance/)
    assert.match(text, /Import open customer invoices/)
    assert.match(text, /Import open vendor bills/)
    assert.match(text, /Import fixed assets/)
    assert.match(text, /Set bank starting points/)
    assert.match(text, /Run the final checks and go live/)
    assert.match(text, /Opening trial balance/)
    assert.match(text, /Final checks/)
    // A committed invoice import is progress, not proof.
    assert.match(text, /1 list imported/)
    // No dead end: the assistant upsell and its not-configured copy never render.
    assert.doesNotMatch(text, /Assistant not set up yet/)
    assert.doesNotMatch(text, /migration assistant/i)
    assert.doesNotMatch(text, /sync\.migrationAssistant\./, 'every label resolves to copy, never a message key')
    // Steps link at native screens, never at a dead end.
    const hrefs = [...host.querySelectorAll('a')].map((link) => link.getAttribute('href') ?? '')
    assert.ok(hrefs.includes('/data/import'), 'import steps link at the native import')
    assert.ok(hrefs.includes('/banking'), 'the bank step links at banking')
  } finally { await unmount() }
})

test('the assistant is an optional helper card only when configured', async () => {
  const { host, unmount } = await mount(english, 'en', true)
  try {
    const card = [...host.querySelectorAll('a')].find((link) => link.getAttribute('href') === '/migrate/assistant')
    assert.ok(card, 'the helper card links at the assistant conversation')
    assert.match(card!.textContent ?? '', /Open the migration assistant/)
  } finally { await unmount() }
})

test('the cutover reads French end to end', async () => {
  const { host, unmount } = await mount(french, 'fr', false)
  try {
    const text = host.textContent ?? ''
    assert.doesNotMatch(text, /Move your books|Cutover checklist|Opening trial balance/)
    assert.doesNotMatch(text, /sync\.migrationAssistant\./)
  } finally { await unmount() }
})
