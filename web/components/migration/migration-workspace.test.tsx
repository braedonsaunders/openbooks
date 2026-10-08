import assert from 'node:assert/strict'
import test from 'node:test'
import { stubModules } from '../../testing/stub-modules.ts'
import { bootJsdomEnvironment } from '../../testing/jsdom-env.ts'

declare global {
  var __migrationRequests: { url: string; body: unknown }[] | undefined
}

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
const { MigrationWorkspace } = await import('./migration-workspace')
const { emptyMigrationPlan } = await import('../../lib/migration/plan-model')
const { deriveCutoverChecks, deriveJourney } = await import('../../lib/migration/journey-model')
type JourneyFacts = import('../../lib/migration/journey-model').JourneyFacts
type MigrationJourney = import('../../lib/migration/journey').MigrationJourney

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input)
  globalThis.__migrationRequests?.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
  if (url.startsWith('/api/assistant/chat')) return new Response('AI is not configured.', { status: 503 })
  return new Response(JSON.stringify({ items: [], messages: [] }), { headers: { 'content-type': 'application/json' } })
}) as typeof fetch

function journey(): MigrationJourney {
  const plan = { ...emptyMigrationPlan(), path: 'cutover' as const, sourceSystem: 'example', cutoverDate: '2026-11-01', connectionId: '0192a0b0-0000-7000-8000-000000000001' }
  const facts: JourneyFacts = {
    plan, sourceName: 'Example ledger', bookStart: 'migrate', profileReady: true, foundationReady: true,
    counts: { accounts: 212, postedEntries: 18_400, bankAccounts: 3, parties: 940, items: 120 },
    connection: { id: plan.connectionId, source: 'example', displayName: 'Example ledger production', status: 'active', mirrorEnabled: true, mirrorSchedule: 'daily', lastRunAt: null, lastError: null },
    connections: [],
    runs: {
      preflight: { id: 'p', kind: 'full_preflight', status: 'ok', startedAt: '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:10:00Z', syncedThrough: null, error: null, tbAccounts: null, tbMatches: null, openItemsChecked: null, openItemsMatches: null },
      migration: { id: 'm', kind: 'full_migration', status: 'ok', startedAt: '2026-10-02T00:00:00Z', finishedAt: '2026-10-02T02:00:00Z', syncedThrough: '2026-10-02T02:00:00Z', error: null, tbAccounts: 212, tbMatches: 212, openItemsChecked: 380, openItemsMatches: 380 },
      mirror: null,
    },
    imports: [], openingJournal: null,
  }
  const checks = deriveCutoverChecks(facts, { receivablesResidual: '0.0000', payablesResidual: '12.5000', clearingBalance: null, unlockedPrecutoverPeriods: 2, precutoverPeriods: 34, unavailable: {} })
  return { plan, facts, stages: deriveJourney(facts, checks), checks, measuredAt: '2026-10-07T12:00:00Z' }
}

async function mount(messages: Record<string, unknown>, locale: string, aiEnabled = true) {
  globalThis.__migrationRequests = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    /* eslint-disable react/no-children-prop */
    root.render(React.createElement(NextIntlClientProvider, {
      locale, messages, timeZone: 'UTC',
      children: React.createElement(MigrationWorkspace, {
        conversations: [], activeId: null, initialMessages: [], canWrite: true, canConfigureAi: true, aiEnabled, canImport: true, journey: journey(),
      }),
    }))
    /* eslint-enable react/no-children-prop */
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove() } }
}

test('the plan beside the conversation shows measured stages and the checks that block go-live', async () => {
  const { host, unmount } = await mount(english, 'en')
  try {
    const text = host.textContent ?? ''
    assert.match(text, /Connector migration and cutover/)
    assert.match(text, /Example ledger/)
    assert.match(text, /212 of 212 accounts match · 380 of 380 open items match/)
    assert.doesNotMatch(text, /Keep mirroring/, 'a cutover plan has no ongoing mirror stage')
    assert.match(text, /Final checks and cutover/)
    // The mirror is still running and the source has not been captured past the cutover date.
    assert.match(text, /Mirror stopped/)
    assert.match(text, /2 required checks are open\./)
    assert.match(text, /Periods before the cutover are locked/)
    assert.doesNotMatch(text, /sync\.migrationAssistant\./, 'every label resolves to copy, never a message key')
  } finally { await unmount() }
})

test('a path card starts a migration-scoped conversation', async () => {
  const { host, unmount } = await mount(english, 'en')
  try {
    const card = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('Bring my data from spreadsheets'))
    assert.ok(card, 'the spreadsheet path card renders')
    await act(async () => {
      card!.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const chat = globalThis.__migrationRequests!.find((request) => request.url === '/api/assistant/chat')
    assert.ok(chat, 'the card sends a turn')
    assert.equal((chat!.body as { mode?: string }).mode, 'migration')
    assert.match(String((chat!.body as { prompt?: string }).prompt), /spreadsheet/)
    // The settled turn refreshes the plan; an unusable answer keeps the measured plan on screen.
    assert.match(host.textContent ?? '', /Connector migration and cutover/)
    assert.match(host.textContent ?? '', /The migration plan could not be loaded\./)
  } finally { await unmount() }
})

test('the workspace reads French end to end', async () => {
  const { host, unmount } = await mount(french, 'fr')
  try {
    const text = host.textContent ?? ''
    assert.doesNotMatch(text, /Final checks|Connector migration|Let’s move your books in/)
    assert.doesNotMatch(text, /sync\.migrationAssistant\./)
  } finally { await unmount() }
})
