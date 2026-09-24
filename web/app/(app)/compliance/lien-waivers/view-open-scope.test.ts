import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// F3-87: the open waiver was looked up inside the FILTERED list, so a
// filter-excluded id opened nothing — a deep link with a direction/status
// filter silently dropped its drawer. The loader must fetch the open id
// independently of the list filters while keeping the org/subsidiary scope,
// so a filter-excluded id opens and an out-of-scope one still opens
// nothing. Loader-proved with a scope-enforcing mock of loadLienWaivers.

const W_RECEIVED = {
  id: 'aaaaaaaa-1111-4111-8111-111111111111',
  orgId: 'org-1',
  waiverNumber: 'W-1',
  direction: 'received',
  partyId: '11111111-1111-4111-8111-111111111111',
  partyName: 'Vendor A',
  projectId: '22222222-2222-4222-8222-222222222222',
  projectName: 'Project A',
  projectSubsidiaryId: 'sub-1',
  waiverType: 'final',
  status: 'requested',
  hasExecutedSnapshot: false,
  throughDate: '2026-01-01',
  amount: '100',
  currency: 'USD',
  signedAt: null,
}
const W_ISSUED = {
  ...W_RECEIVED,
  id: 'bbbbbbbb-2222-4222-8222-222222222222',
  waiverNumber: 'W-2',
  direction: 'issued',
  status: 'signed',
}
const W_FOREIGN = {
  ...W_RECEIVED,
  id: 'cccccccc-3333-4333-8333-333333333333',
  waiverNumber: 'W-9',
  orgId: 'org-2',
}
const W_RESTRICTED = {
  ...W_RECEIVED,
  id: 'dddddddd-4444-4444-8444-444444444444',
  waiverNumber: 'W-3',
  projectSubsidiaryId: 'sub-9',
}

const stateKey = Symbol.for('openbooks.lien-waiver-open-scope-test')
interface ScopeState {
  scope: Set<string> | null
  calls: { id: string | null; direction: string | null; status: string | null }[]
}
const scopeState: ScopeState = { scope: null, calls: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = scopeState

const mockSources = new Map<string, string>([
  [
    'mock:authz',
    `
      const state = globalThis[Symbol.for('openbooks.lien-waiver-open-scope-test')]
      export async function requirePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: state.scope }
      }
      export function can() { return false }
    `,
  ],
  [
    'mock:intl',
    `export async function getTranslations() { return (key) => key }`,
  ],
  ['mock:db', `export const db = { async execute() { return { rows: [] } } }`],
  ['mock:gates', `export async function requireFeatureEnabled() {}`],
  [
    'mock:compliance',
    `
      const state = globalThis[Symbol.for('openbooks.lien-waiver-open-scope-test')]
      const WAIVERS = [${JSON.stringify(W_RECEIVED)}, ${JSON.stringify(W_ISSUED)}, ${JSON.stringify(W_FOREIGN)}, ${JSON.stringify(W_RESTRICTED)}]
      export function complianceSubsidiaryFilter() { return null }
      export async function requireLienWaiverFeature() {}
      export async function isLienWaiverLegacyUnverified() { return false }
      export async function loadLienWaivers(args) {
        state.calls.push({ id: args.id ?? null, direction: args.direction ?? null, status: args.status ?? null })
        const allowed = state.scope
        return WAIVERS.filter((w) => {
          if (w.orgId !== args.orgId) return false
          if (args.id != null && w.id !== args.id) return false
          if (args.direction != null && w.direction !== args.direction) return false
          if (args.status != null && w.status !== args.status) return false
          if (allowed === null || allowed === undefined) return true
          if (allowed.size === 0) return false
          return allowed.has(w.projectSubsidiaryId)
        })
      }
    `,
  ],
  [
    'mock:money',
    `export async function getMoneyFormatter() { return { money: (value) => String(value) } }`,
  ],
  ['mock:tabs', `export async function complianceTabs() { return [] }`],
  [
    'mock:viewspec',
    `
      export function badge(label) { return label }
      export function column() { return {} }
      export function field() { return {} }
      export function grid(className, blocks) { return { className, blocks } }
      export function page(spec) { return spec }
      export function pageHeader(header) { return header }
      export function ref() { return () => false }
      export function rootRef() { return () => false }
      export function table(config) { return config }
      export function text(value) { return value }
      export function widgetBlock(kind, props) { return { kind, ...props } }
      export function widgetCell(kind, props) { return { kind, ...props } }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['../../../../lib/authz', 'mock:authz'],
  ['next-intl/server', 'mock:intl'],
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['../../../../lib/feature-gates', 'mock:gates'],
  ['../../../../lib/compliance', 'mock:compliance'],
  ['@/lib/money-server', 'mock:money'],
  ['../tabs', 'mock:tabs'],
  ['@braedonsaunders/appkit-viewspec', 'mock:viewspec'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, url: 'data:text/javascript,export {}' }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const viewUrl = './view.ts?lien-waiver-open-scope'
const { loadLienWaiversPage } = (await import(viewUrl)) as typeof import('./view.ts')
hooks.deregister()

function reset(scope: Set<string> | null): void {
  scopeState.scope = scope
  scopeState.calls = []
}

function targetedCalls(): { id: string | null; direction: string | null; status: string | null }[] {
  return scopeState.calls.filter((call) => call.id !== null)
}

test('a direction-excluded waiver still opens from its deep link', async () => {
  reset(null)
  const data = await loadLienWaiversPage({ direction: 'received', waiver: W_ISSUED.id })
  assert.equal(data.drawerOpen, true)
  assert.equal((data.drawerProps?.waiver as { id: string } | undefined)?.id, W_ISSUED.id)
  const targeted = targetedCalls()
  assert.equal(targeted.length, 1, 'the open id must load independently of the list filters')
  assert.deepEqual(targeted[0], { id: W_ISSUED.id, direction: null, status: null })
})

test('a status-excluded waiver still opens from its deep link', async () => {
  reset(null)
  const data = await loadLienWaiversPage({ status: 'requested', waiver: W_ISSUED.id })
  assert.equal(data.drawerOpen, true)
  assert.equal((data.drawerProps?.waiver as { id: string } | undefined)?.id, W_ISSUED.id)
})

test('a waiver from another org opens nothing', async () => {
  reset(null)
  const data = await loadLienWaiversPage({ waiver: W_FOREIGN.id })
  assert.equal(data.drawerOpen, false)
  assert.equal(data.drawerProps, null)
})

test('a waiver outside the subsidiary scope opens nothing', async () => {
  reset(new Set(['sub-1']))
  const data = await loadLienWaiversPage({ waiver: W_RESTRICTED.id })
  assert.equal(data.drawerOpen, false)
  assert.equal(data.drawerProps, null)
})

test('a scope-excluded waiver still opens when its subsidiary is allowed', async () => {
  reset(new Set(['sub-1']))
  const data = await loadLienWaiversPage({ direction: 'received', waiver: W_ISSUED.id })
  assert.equal(data.drawerOpen, true)
  assert.equal((data.drawerProps?.waiver as { id: string } | undefined)?.id, W_ISSUED.id)
})

test('a malformed waiver id opens nothing instead of failing', async () => {
  reset(null)
  const data = await loadLienWaiversPage({ waiver: 'not-a-uuid' })
  assert.equal(data.drawerOpen, false)
  assert.equal(data.drawerProps, null)
  assert.deepEqual(targetedCalls(), [], 'a malformed id must never reach the query')
})
