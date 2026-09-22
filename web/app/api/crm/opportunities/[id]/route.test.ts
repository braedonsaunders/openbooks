import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.opportunity-contact-route-test')
interface DbCall { kind: 'execute' | 'tx-execute'; text: string }
interface RouteState {
  calls: DbCall[]
  lockedContactMatches: boolean[]
  txWrites: number
  auditWrites: number
  stageWrites: number
  transactionCount: number
  opportunity: Record<string, unknown> | null
  auditBefores: Record<string, unknown>[]
  updateBefores: Record<string, unknown>[]
  stageBefores: Array<{ before: Record<string, unknown>; after: Record<string, unknown> }>
  lastUpdateBefore: Record<string, unknown> | null
  concurrentLocks: boolean
  lockRequests: number
  releaseLockBarrier: (() => void) | null
  firstLockReady: (() => void) | null
  txStatusValid: boolean
  txStatusClosed: boolean
  /** Stage-entry policy flags (migration 0175) carried by the status rows. */
  statusPolicy: Record<string, boolean>
  /** Opportunity lines already stored, for gates that count them. */
  storedLines: number
  txInvalidReference: string | null
  loaded: Record<string, unknown> | null
  sequence: number
}
const routeState: RouteState = {
  calls: [],
  lockedContactMatches: [],
  txWrites: 0,
  auditWrites: 0,
  stageWrites: 0,
  transactionCount: 0,
  opportunity: null,
  auditBefores: [],
  updateBefores: [],
  stageBefores: [],
  lastUpdateBefore: null,
  concurrentLocks: false,
  lockRequests: 0,
  releaseLockBarrier: null,
  firstLockReady: null,
  txStatusValid: true,
  txStatusClosed: false,
  statusPolicy: {},
  storedLines: 0,
  txInvalidReference: null,
  loaded: null,
  sequence: 0,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks.map((chunk) => {
    if (typeof chunk === 'string') return chunk
    // Interpolated scalars ride bare in the chunk list (not wrapped) —
    // stringify them too, or writes like `is_active = true` read back as
    // `is_active = ` and untestable.
    if (typeof chunk === 'number' || typeof chunk === 'boolean' || typeof chunk === 'bigint') return String(chunk)
    const value = (chunk as { value?: unknown[] })?.value
    if (Array.isArray(value)) return value.map(String).join('')
    if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
    return ''
  }).join('')
}
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlTextOpportunity?: unknown }).openbooksSqlTextOpportunity = sqlText

const REVISION = '2026-09-15T12:00:00.000000Z'

const PARTY_A = '00000000-0000-4000-8000-00000000c001'
const PARTY_B = '00000000-0000-4000-8000-00000000c002'
const CONTACT_ID = '00000000-0000-4000-8000-00000000c003'
const CONTACT_B_ID = '00000000-0000-4000-8000-00000000c009'
const OWNER_ID = '00000000-0000-4000-8000-00000000c004'
const TEAM_ID = '00000000-0000-4000-8000-00000000c005'
const SOURCE_ID = '00000000-0000-4000-8000-00000000c006'
const STATUS_ID = '00000000-0000-4000-8000-00000000c007'
const STATUS_B_ID = '00000000-0000-4000-8000-00000000c00a'
const OPPORTUNITY_ID = '00000000-0000-4000-8000-00000000c008'

const staleOpportunity = {
  id: OPPORTUNITY_ID,
  revision: REVISION,
  party_id: PARTY_A,
  primary_contact_id: CONTACT_ID,
  owner_user_id: OWNER_ID,
  sales_team_id: TEAM_ID,
  lead_source_id: SOURCE_ID,
  status_id: STATUS_ID,
  is_closed: false,
  is_won: false,
  probability: 20,
  forecast_category: 'most_likely',
  title: 'Existing opportunity',
  currency: 'USD',
  win_loss_reason: null,
  projected_amount: '100.00',
  weighted_amount: '20.00',
  next_step: null,
}

const mockSources = new Map<string, string>([
  ['mock:db', `
    const state = globalThis[Symbol.for('openbooks.opportunity-contact-route-test')]
    const sqlText = globalThis.openbooksSqlTextOpportunity
    const respondExecute = (query) => {
      const text = sqlText(query)
      state.calls.push({ kind: 'execute', text })
      if (text.includes('from crm_opportunities')) return { rows: [${JSON.stringify(staleOpportunity)}] }
      if (text.includes('from crm_opportunity_statuses')) return { rows: [{ is_closed: false, is_won: false, probability: 20, default_forecast_category: 'most_likely', ...state.statusPolicy }] }
      if (text.includes('count(*)') && text.includes('crm_opportunity_lines')) return { rows: [{ count: state.storedLines }] }
      if (text.includes('from items')) return { rows: [{ ok: 1, is_active: true }] }
      if (text.includes('from currencies')) return { rows: [{ code: 'USD' }] }
      if (text.includes('from parties') || text.includes('from contacts') || text.includes('from users') || text.includes('from crm_sales_teams') || text.includes('from crm_lead_sources')) return { rows: [{ ok: 1 }] }
      return { rows: [] }
    }
    let lockHeld = false
    const lockWaiters = []
    const acquireLock = async () => {
      if (!lockHeld) { lockHeld = true; return }
      await new Promise((resolve) => lockWaiters.push(resolve))
      lockHeld = true
    }
    const releaseLock = () => {
      const next = lockWaiters.shift()
      if (next) next()
      else lockHeld = false
    }
    export const db = {
      execute: (query) => Promise.resolve(respondExecute(query)),
      transaction: async (work) => {
        state.transactionCount += 1
        let ownsLock = false
        const tx = {
        execute: async (query) => {
          const text = sqlText(query)
          state.calls.push({ kind: 'tx-execute', text })
          if (text.includes('for update of o')) {
            const request = state.lockRequests++
            if (state.concurrentLocks && request === 0) {
              await new Promise((resolve) => { state.releaseLockBarrier = resolve })
              await acquireLock()
              state.firstLockReady?.()
              state.firstLockReady = null
            } else if (state.concurrentLocks && request === 1) {
              state.releaseLockBarrier?.()
              state.releaseLockBarrier = null
              await new Promise((resolve) => { state.firstLockReady = resolve })
              await acquireLock()
            } else {
              await acquireLock()
            }
            ownsLock = true
            return { rows: state.opportunity ? [state.opportunity] : [] }
          }
          if (text.includes('count(*)') && text.includes('crm_opportunity_lines')) {
            return { rows: [{ count: state.storedLines }] }
          }
          if (text.includes('from contacts') && text.includes('party_id')) {
            const matches = state.lockedContactMatches.shift() ?? true
            return { rows: matches ? [{ ok: 1 }] : [] }
          }
          if (text.includes('from crm_opportunity_statuses')) {
            return { rows: state.txStatusValid ? [state.txStatusClosed ? { is_closed: true, is_won: false, probability: 0, default_forecast_category: 'most_likely', ...state.statusPolicy } : { is_closed: false, is_won: false, probability: 20, default_forecast_category: 'most_likely', ...state.statusPolicy }] : [] }
          }
          if (text.includes('from parties') || text.includes('from contacts') || text.includes('from users') || text.includes('from crm_sales_teams') || text.includes('from crm_lead_sources') || text.includes('from currencies') || text.includes('from items')) {
            if (state.txInvalidReference && text.includes('from ' + state.txInvalidReference)) return { rows: [] }
            return { rows: [{ ok: 1, is_active: true }] }
          }
          if (text.includes('update crm_opportunities')) {
            const before = { ...(state.opportunity || {}) }
            const value = (label, fallback) => {
              const match = text.match(new RegExp(label + ' = ([^,]+)'))
              const raw = match?.[1]?.trim()
              return !raw || raw === label ? fallback : raw === 'null' ? null : raw
            }
            state.sequence += 1
            state.opportunity = {
              ...state.opportunity,
              revision: '2026-09-15T12:00:00.' + String(state.sequence).padStart(6, '0') + 'Z',
              title: value('title', before.title),
              party_id: value('party_id', before.party_id),
              primary_contact_id: value('primary_contact_id', before.primary_contact_id),
              status_id: value('status_id', before.status_id),
              next_step: value('next_step', before.next_step),
            }
            state.updateBefores.push(before)
            state.lastUpdateBefore = before
            state.txWrites += 1
            return { rows: [] }
          }
          if (text.includes('insert into crm_opportunity_stage_events')) {
            state.stageWrites += 1
            state.stageBefores.push({ before: state.lastUpdateBefore || {}, after: { ...(state.opportunity || {}) } })
            return { rows: [] }
          }
          if (text.includes('insert into audit_log')) {
            state.auditWrites += 1
            const before = state.updateBefores[state.auditWrites - 1]
            if (before) state.auditBefores.push(before)
            return { rows: [] }
          }
          return { rows: [] }
        },
        }
        try { return await work(tx) }
        finally { if (ownsLock) releaseLock() }
      },
    }
    export const schema = {}
    export const pool = {}
    export const env = {}
    export function withOrgTransaction(_orgId, work) { return work() }
    export async function withOrg(_orgId, work) { return work() }
    export async function withOrgContext(_orgId, work) { return work() }
    export async function withBypass(work) { return work() }
    export async function withBypassContext(_opts, work) { return work() }
    export function inDbTransaction(_work) { throw new Error('unexpected inDbTransaction') }
    export function registerRequestOrgResolver() {}
  `],
  ['mock:crm', `
    export async function promoteCrmAccount() {}
  `],
  ['mock:crm-scope', `
    export function crmOpportunityScope() { return '' }
    export function crmSharedScope() { return '' }
  `],
  // The stage gate is re-exported from the REAL engine module rather than
  // restated here. A hand-written stub of a policy resolver would let the
  // route keep passing this file while the rule it enforces drifted away from
  // the one the product actually applies, which is the whole failure mode the
  // single resolver exists to prevent. It is pure (no database), so borrowing
  // it costs nothing.
  ['mock:crm-math', `
    export { validateOpportunityStageTransition } from ${JSON.stringify(
      new URL('../../../../../../engine/src/crm/crm-math.ts', import.meta.url).href,
    )}
    export function computeOpportunityTotals(lines, probability) {
      return { lines, projectedAmount: '0.00', weightedAmount: '0.00', probability }
    }
    export function validateContributionTotal() {}
  `],
  ['mock:authz', `
    export async function guardPermission() { return { user: { orgId: 'org-1', id: 'user-1' } } }
  `],
  ['mock:feature-gates', `
    export async function guardFeaturePermission() { return { user: { orgId: 'org-1', id: 'user-1' } } }
  `],
  ['mock:features', `
    export async function isFeatureEnabled() { return true }
  `],
  ['mock:crm-loader', `
    const state = globalThis[Symbol.for('openbooks.opportunity-contact-route-test')]
    export async function loadOpportunity() { return state.loaded }
  `],
  ['mock:json', `
    export const jsonObject = {}
    export async function parseJsonBody(req) {
      try { return { ok: true, data: await req.json() } }
      catch { return { ok: false, response: new Response(JSON.stringify({ error: 'invalid JSON' }), { status: 400 }) } }
    }
  `],
  ['mock:list-params', `
    export function isUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) }
  `],
])

// Neither the money kernel, the decimal classifier, nor '@/lib/api/json' is
// mocked: hand doubles cannot produce the refusals the real modules enforce
// (the removed compareDecimal stub answered 0 for every comparison, so the
// totals-vs-lines check behind it could never fail).
const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['@openbooks/engine/src/crm/crm.ts', 'mock:crm'],
  ['@openbooks/engine/src/crm/crm-math.ts', 'mock:crm-math'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['../../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../../../../lib/features', 'mock:features'],
  ['../../../../../lib/crm', 'mock:crm-loader'],
  ['../../../../../lib/crm-scope', 'mock:crm-scope'],
  ['../../../../../lib/list-params', 'mock:list-params'],
  ['@/lib/list-params', 'mock:list-params'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    if (specifier.startsWith('@/lib/') && context.parentURL) {
      return nextResolve(new URL(`../../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context)
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?opportunity-contact-occ-test'
const { PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(lockedContactMatches: boolean[] = [true]): void {
  routeState.calls.length = 0
  routeState.lockedContactMatches = [...lockedContactMatches]
  routeState.txWrites = 0
  routeState.auditWrites = 0
  routeState.stageWrites = 0
  routeState.transactionCount = 0
  routeState.opportunity = { ...staleOpportunity }
  routeState.auditBefores = []
  routeState.updateBefores = []
  routeState.stageBefores = []
  routeState.lastUpdateBefore = null
  routeState.concurrentLocks = false
  routeState.lockRequests = 0
  routeState.releaseLockBarrier = null
  routeState.firstLockReady = null
  routeState.txStatusValid = true
  routeState.txStatusClosed = false
  routeState.statusPolicy = {}
  routeState.storedLines = 0
  routeState.txInvalidReference = null
  routeState.loaded = { id: OPPORTUNITY_ID, party_id: PARTY_B, primary_contact_id: CONTACT_ID }
  routeState.sequence = 0
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/crm/opportunities/${OPPORTUNITY_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: OPPORTUNITY_ID }) },
  )
}

test('PATCH rejects a contact that fails the account check on the locked opportunity', async () => {
  reset([false])

  const response = await patch({ title: 'Concurrent save', primaryContactId: CONTACT_ID, expectedUpdatedAt: REVISION })

  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: 'contact does not belong to the account' })
  assert.ok(routeState.calls.some((call) => call.kind === 'tx-execute' && call.text.includes('for update of o')), 'the opportunity was locked before the refreshed check')
  assert.ok(routeState.calls.some((call) => call.kind === 'tx-execute' && call.text.includes('from contacts')), 'the contact was checked against the locked account')
  assert.equal(routeState.txWrites, 0, 'the invalid pairing never reached the opportunity update')
  assert.equal(routeState.auditWrites, 0, 'the invalid pairing never reached the audit write')
})

test('PATCH persists when the contact belongs to the locked account', async () => {
  reset([true])

  const response = await patch({ title: 'Valid concurrent save', primaryContactId: CONTACT_ID, expectedUpdatedAt: REVISION })

  assert.equal(response.status, 200)
  assert.equal(routeState.txWrites, 1)
  assert.equal(routeState.auditWrites, 1)
  assert.equal(routeState.auditBefores[0]?.title, staleOpportunity.title)
  const txContactIndex = routeState.calls.findIndex((call) => call.kind === 'tx-execute' && call.text.includes('from contacts'))
  const txUpdateIndex = routeState.calls.findIndex((call) => call.kind === 'tx-execute' && call.text.includes('update crm_opportunities'))
  assert.ok(txContactIndex >= 0 && txUpdateIndex > txContactIndex, 'the account check precedes the write')
})

test('a stale concurrent PATCH loses loudly against the locked winner', async () => {
  reset([true, true])
  routeState.concurrentLocks = true

  // Both tabs read the same revision before either saves. The row lock still
  // serializes the two writes; the loser compares against the winner's
  // committed revision and refuses loudly instead of silently replacing it.
  // (Field-disjoint merging still applies when the second tab carries a fresh
  // token — the merge reads unspecified fields from the locked row.)
  const [first, second] = await Promise.all([
    patch({ title: 'First save', expectedUpdatedAt: REVISION }),
    patch({ nextStep: 'Call buyer', expectedUpdatedAt: REVISION }),
  ])


  assert.deepEqual([first.status, second.status], [200, 409])
  assert.deepEqual(await second.json(), { error: 'This opportunity changed after you opened it; reload the opportunity and reapply your changes' })
  assert.equal(routeState.opportunity?.title, 'First save')
  assert.equal(routeState.opportunity?.next_step, null)
  assert.equal(routeState.txWrites, 1)
  assert.equal(routeState.auditWrites, 1)
  assert.equal(routeState.transactionCount, 2)
  assert.equal(routeState.calls.filter((call) => call.kind === 'tx-execute' && call.text.includes('for update of o')).length, 2)
  assert.equal(routeState.auditBefores[0]?.title, staleOpportunity.title)
})

test('a save without a revision token refuses before touching the row', async () => {
  reset([true])

  const response = await patch({ title: 'Tokenless save' })

  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'A current opportunity revision is required; reload the opportunity and try again' })
  assert.equal(routeState.txWrites, 0)
  assert.equal(routeState.auditWrites, 0)
})

test('a party/contact race fails closed on the stale revision without writes from the losing request', async () => {
  reset([true, false])
  routeState.concurrentLocks = true

  // Both tabs read the same revision. The party change wins the lock and
  // advances the revision; the stale contact save refuses on its revision
  // before any domain check (the locked-account contact refusal stays pinned
  // by the sequential tests above).
  const [partyChange, staleContactChange] = await Promise.all([
    patch({ partyId: PARTY_B, primaryContactId: CONTACT_B_ID, expectedUpdatedAt: REVISION }),
    patch({ title: 'Stale contact save', primaryContactId: CONTACT_ID, expectedUpdatedAt: REVISION }),
  ])

  assert.equal(partyChange.status, 200)
  assert.equal(staleContactChange.status, 409)
  assert.deepEqual(await staleContactChange.json(), { error: 'This opportunity changed after you opened it; reload the opportunity and reapply your changes' })
  assert.equal(routeState.opportunity?.party_id, PARTY_B)
  assert.equal(routeState.opportunity?.primary_contact_id, CONTACT_B_ID)
  assert.equal(routeState.txWrites, 1)
  assert.equal(routeState.auditWrites, 1)
  assert.equal(routeState.updateBefores.length, 1, 'the rejected request never reached its update')
})

test('stage and audit before evidence use the predecessor read under the opportunity lock', async () => {
  reset([true, true])
  routeState.concurrentLocks = true

  // The stage change wins the lock; the concurrent title save carries the
  // same stale revision and refuses, so exactly one predecessor image feeds
  // the stage event and the audit trail.
  const [stageChange, titleChange] = await Promise.all([
    patch({ statusId: STATUS_B_ID, expectedUpdatedAt: REVISION }),
    patch({ title: 'After stage change', expectedUpdatedAt: REVISION }),
  ])

  assert.equal(stageChange.status, 200)
  assert.equal(titleChange.status, 409)
  assert.equal(routeState.stageWrites, 1)
  assert.equal(routeState.stageBefores[0]?.before.status_id, STATUS_ID)
  assert.equal(routeState.stageBefores[0]?.after.status_id, STATUS_B_ID)
  assert.equal(routeState.auditBefores[0]?.status_id, STATUS_ID)
  assert.equal(routeState.auditBefores.length, 1)
})

test('disappearance after preflight returns 404 before any transaction write', async () => {
  reset([true])
  routeState.opportunity = null

  const response = await patch({ title: 'Gone opportunity', expectedUpdatedAt: REVISION })

  assert.equal(response.status, 404)
  assert.deepEqual(await response.json(), { error: 'not found' })
  assert.equal(routeState.txWrites, 0)
  assert.equal(routeState.auditWrites, 0)
  assert.equal(routeState.calls.some((call) => call.text.includes('update crm_opportunities')), false)
})

test('an explicitly submitted deactivated status fails closed after locking', async () => {
  reset([true])
  routeState.txStatusValid = false

  const response = await patch({ statusId: STATUS_B_ID, title: 'Invalidated status', expectedUpdatedAt: REVISION })

  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: 'invalid status' })
  assert.ok(routeState.calls.some((call) => call.kind === 'tx-execute' && call.text.includes('from crm_opportunity_statuses') && call.text.includes('is_active') && call.text.includes('for update')))
  assert.equal(routeState.txWrites, 0)
  assert.equal(routeState.auditWrites, 0)
})

test('a deactivated derived status fails closed after locking', async () => {
  reset([true])
  routeState.txStatusValid = false

  const response = await patch({ title: 'Invalidated derived status', expectedUpdatedAt: REVISION })

  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: 'invalid status' })
  assert.equal(routeState.txWrites, 0)
  assert.equal(routeState.auditWrites, 0)
})

test('deactivated account, team, and source references fail closed on the locked connection', async () => {
  for (const [reference, error] of [
    ['parties', 'invalid account'],
    ['crm_sales_teams', 'invalid sales team'],
    ['crm_lead_sources', 'invalid lead source'],
  ] as const) {
    reset([true])
    routeState.txInvalidReference = reference

    const response = await patch({ title: `Invalid ${reference}`, expectedUpdatedAt: REVISION })

    assert.equal(response.status, 422)
    assert.deepEqual(await response.json(), { error })
    if (reference !== 'parties') {
      assert.ok(routeState.calls.some((call) => call.kind === 'tx-execute' && call.text.includes(`from ${reference}`) && call.text.includes('is_active') && call.text.includes('for update')))
    }
    assert.equal(routeState.txWrites, 0)
    assert.equal(routeState.auditWrites, 0)
  }
})

/**
 * F-t03-014: a titled opportunity saved without an account stayed inactive
 * forever — invisible in the list under Status=All (and zeroing every facet
 * count) while its drawer saved 200s, because activation required an
 * account. Activation now means "a real record, not a creation stub".
 */
function updateActiveFlag(): boolean | null {
  const update = routeState.calls.find(
    (call) => call.kind === 'tx-execute' && call.text.includes('update crm_opportunities'),
  )
  const match = update?.text.match(/is_active = (true|false)/)
  return match ? match[1] === 'true' : null
}

test('closing an account-less titled opportunity activates it for the list', async () => {
  reset([true])
  routeState.opportunity = {
    ...staleOpportunity,
    title: 'T03 Verify Opp',
    party_id: null,
    primary_contact_id: null,
    is_active: false,
  }
  routeState.txStatusClosed = true

  const response = await patch({
    statusId: STATUS_B_ID,
    winLossReason: 'Lost on price',
    expectedUpdatedAt: REVISION,
  })

  assert.equal(response.status, 200)
  assert.equal(updateActiveFlag(), true)
})

test('reopening keeps an active record visible without an account', async () => {
  reset([true])
  routeState.opportunity = {
    ...staleOpportunity,
    title: 'T03 Verify Opp',
    party_id: null,
    primary_contact_id: null,
    is_active: true,
  }

  const response = await patch({ statusId: STATUS_ID, expectedUpdatedAt: REVISION })

  assert.equal(response.status, 200)
  assert.equal(updateActiveFlag(), true)
})

test('an untitled stub without an account stays inactive', async () => {
  reset([true])
  routeState.opportunity = {
    ...staleOpportunity,
    title: 'New opportunity',
    party_id: null,
    primary_contact_id: null,
    is_active: false,
  }

  const response = await patch({ expectedUpdatedAt: REVISION })

  assert.equal(response.status, 200)
  assert.equal(updateActiveFlag(), false)
})

test('a closed-lost stage that declares no reason requirement no longer forces one', async () => {
  // The whole point of 0175: this rule used to be hard-coded as "closed and
  // not won", so no organization could hold a different policy. With the flag
  // off, the same closed-lost transition saves.
  reset()
  routeState.txStatusClosed = true

  const response = await patch({ statusId: STATUS_B_ID, expectedUpdatedAt: REVISION })

  assert.equal(response.status, 200)
})

test('a stage that declares a reason requirement refuses without one, before any write', async () => {
  reset()
  routeState.txStatusClosed = true
  routeState.statusPolicy = { requires_win_loss_reason: true }

  const response = await patch({ statusId: STATUS_B_ID, expectedUpdatedAt: REVISION })

  assert.equal(response.status, 422)
  // Wording pinned: the drawer highlights the loss-reason field by matching it.
  assert.deepEqual(await response.json(), { error: 'a loss reason is required' })
  assert.equal(routeState.txWrites, 0)
})

test('a declared reason requirement is satisfied by a reason', async () => {
  reset()
  routeState.txStatusClosed = true
  routeState.statusPolicy = { requires_win_loss_reason: true }

  const response = await patch({ statusId: STATUS_B_ID, winLossReason: 'Lost on price', expectedUpdatedAt: REVISION })

  assert.equal(response.status, 200)
})

test('a stage that requires lines counts the ones already stored, not just the submitted ones', async () => {
  // A stage move that sends no `lines` array must still be gated: the board
  // drags a card without touching line detail, and a gate that only inspected
  // the payload would wave those through.
  reset()
  routeState.statusPolicy = { requires_lines: true }
  routeState.storedLines = 0

  const refused = await patch({ statusId: STATUS_B_ID, expectedUpdatedAt: REVISION })
  assert.equal(refused.status, 422)
  assert.deepEqual(await refused.json(), { error: 'this stage requires at least one line' })
  assert.equal(routeState.txWrites, 0)

  reset()
  routeState.statusPolicy = { requires_lines: true }
  routeState.storedLines = 2
  const allowed = await patch({ statusId: STATUS_B_ID, expectedUpdatedAt: REVISION })
  assert.equal(allowed.status, 200)
})

test('a stage that requires a primary contact refuses when the contact is being cleared', async () => {
  reset()
  routeState.statusPolicy = { requires_primary_contact: true }

  const response = await patch({ primaryContactId: null, expectedUpdatedAt: REVISION })

  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: 'this stage requires a primary contact' })
  assert.equal(routeState.txWrites, 0)
})

test('an ungated stage never pays for the stored-line count', async () => {
  // Most saves are into stages that declare nothing; they must not run a
  // query whose answer cannot change the outcome.
  reset()

  const response = await patch({ title: 'Ordinary save', expectedUpdatedAt: REVISION })

  assert.equal(response.status, 200)
  assert.ok(
    !routeState.calls.some((call) => call.text.includes('count(*)') && call.text.includes('crm_opportunity_lines')),
    'an ungated stage must not count lines',
  )
})

test('the line write carries the cost columns', async () => {
  // This harness stubs the math, so it can prove the wiring and nothing more:
  // that a saved line reaches the insert with unit_cost and cost_amount on it.
  // What those values should BE — absence vs zero, the extension's rounding,
  // the margin — is asserted in engine/src/crm/crm-math.test.ts against the real
  // function, which is the only place those answers actually come from.
  reset()

  const response = await patch({
    lines: [{ itemId: PARTY_A, quantity: '2', unitPrice: '50', unitCost: '30' }],
    expectedUpdatedAt: REVISION,
  })

  assert.equal(response.status, 200)
  const insert = routeState.calls.find(
    (call) => call.kind === 'tx-execute' && call.text.includes('insert into crm_opportunity_lines'),
  )
  assert.ok(insert, 'the line must be written')
  assert.match(insert.text, /unit_cost, cost_amount/)
})
