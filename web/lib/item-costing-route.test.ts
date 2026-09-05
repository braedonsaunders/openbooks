import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route boundary suite for /api/items/[id]/costing: the costing-profile PUT
// must mutate the accounting policy and write its audit row in ONE database
// transaction, record exact before/after/actor/reason/revision evidence, and
// honour an expectedUpdatedAt optimistic-concurrency fence with 409. The real
// route handler runs against a scripted database fake whose autocommit vs
// in-transaction split makes a missing transaction observable.
const stateKey = Symbol.for('openbooks.item-costing-route-test')
type ProfileRow = Record<string, unknown>
interface DbCall {
  kind: 'execute' | 'tx-execute'
  text: string
  params: string[]
}
interface RouteState {
  calls: DbCall[]
  itemExists: boolean
  historyExists: boolean
  committedProfiles: Map<string, ProfileRow>
  committedAudits: { action: string; changes: unknown }[]
  failOn: 'none' | 'upsert' | 'audit'
  nextProfileAfterUpsert: ProfileRow | null
}
const routeState: RouteState = {
  calls: [],
  itemExists: true,
  historyExists: false,
  committedProfiles: new Map(),
  committedAudits: [],
  failOn: 'none',
  nextProfileAfterUpsert: null,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

/** Flatten a drizzle SQL chunk into its raw text for keyword routing. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((c) => {
      if (typeof c === 'string') return c
      const value = (c as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((c as { queryChunks?: unknown[] })?.queryChunks) return sqlText(c)
      return ''
    })
    .join('')
}
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlText?: unknown }).openbooksSqlText =
  sqlText

/** Extract every bound parameter of a drizzle SQL chunk, stringified.
 * Drizzle stores literal SQL text in StringChunk objects ({value: string[]})
 * and keeps interpolated parameters as sibling chunk entries. */
function sqlParams(query: unknown): string[] {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return []
  const out: string[] = []
  for (const c of chunks) {
    if (typeof c === 'string') {
      out.push(c)
      continue
    }
    if ((c as { queryChunks?: unknown[] })?.queryChunks) {
      out.push(...sqlParams(c))
      continue
    }
    const value = (c as { value?: unknown })?.value
    if (!Array.isArray(value)) out.push(String(value))
  }
  return out
}
;(globalThis as typeof globalThis & Record<string, unknown> & { openbooksSqlParams?: unknown }).openbooksSqlParams =
  sqlParams

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.item-costing-route-test')]
      const sqlText = globalThis.openbooksSqlText
      const sqlParams = globalThis.openbooksSqlParams

      function currentProfile() {
        // Reads inside the transaction observe staged writes; reads outside do not.
        return state.stagedProfile ?? state.committedProfiles.get(state.itemId) ?? null
      }

      function respond(kind, query) {
        const text = sqlText(query)
        const params = sqlParams(query)
        state.calls.push({ kind, text, params })

        const isTx = kind === 'tx-execute'
        if (text.includes('from items where')) {
          return { rows: state.itemExists ? [{ '?column?': 1 }] : [] }
        }
        if (text.includes('insert into item_inventory_profiles')) {
          if (state.failOn === 'upsert') throw new Error('profile upsert failed')
          // Faithful database emulation: an autocommit write lands instantly,
          // an in-transaction write stays staged until the caller commits.
          const row = state.nextProfileAfterUpsert
          if (isTx) {
            state.stagedProfile = row
          } else {
            state.committedProfiles.set(state.itemId, row)
          }
          return { rows: [row] }
        }
        if (text.includes('insert into audit_log')) {
          if (state.failOn === 'audit') throw new Error('audit sink offline')
          const changesParam = params.find((p) => p.startsWith('{'))
          const entry = {
            action: params[2],
            changes: changesParam === undefined ? null : JSON.parse(changesParam),
          }
          if (isTx) {
            state.pendingAudits.push(entry)
          } else {
            state.committedAudits.push(entry)
          }
          return { rows: [] }
        }
        if (text.includes('for update')) {
          const profile = currentProfile()
          return { rows: profile ? [profile] : [] }
        }
        if (text.includes('from cost_layers') && text.includes('inventory_movements')) {
          return { rows: [{ has_history: state.historyExists }] }
        }
        if (text.includes('as updated_at from item_inventory_profiles')) {
          const profile = currentProfile()
          return { rows: profile ? [{ updated_at: profile.updated_at }] : [] }
        }
        if (text.includes('from item_inventory_profiles')) {
          const profile = state.committedProfiles.get(state.itemId)
          if (!profile) return { rows: [] }
          // Honour the statement's projection so only columns the handler
          // actually selects are observable.
          const projection = text.slice(text.indexOf('select') + 6, text.indexOf('from'))
          const row = { ...profile }
          if (!projection.includes('updated_at')) delete row.updated_at
          return { rows: [row] }
        }
        return { rows: [] }
      }

      export const db = {
        execute: (query) => Promise.resolve(respond('execute', query)),
        transaction: async (work) => {
          state.txDepth += 1
          try {
            const result = await work({ execute: (query) => respond('tx-execute', query) })
            // Commit: staged writes become visible to everyone.
            if (state.stagedProfile) state.committedProfiles.set(state.itemId, state.stagedProfile)
            state.committedAudits.push(...state.pendingAudits)
            return result
          } catch (error) {
            // Rollback: staged writes vanish.
            throw error
          } finally {
            state.stagedProfile = null
            state.pendingAudits.length = 0
            state.txDepth -= 1
          }
        },
      }
      export const schema = {}
      export function withOrgTransaction(_orgId, work) { return work() }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export function registerRequestOrgResolver() {}
      export const pool = {}
      export const env = {}
    `,
  ],
  [
    'mock:feature-gates',
    `
      export async function guardFeaturePermission(permission) {
        if (permission === 'items.read' || permission === 'items.manage') {
          return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
        }
        return new Response(null, { status: 403 })
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['../../../../../lib/feature-gates', 'mock:feature-gates'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    // Next.js-style aliases forwarded to the real modules they point at
    // (web/lib/api/json.ts etc. relative to this web/lib test file).
    if (specifier.startsWith('@/lib/') && context.parentURL) {
      return nextResolve(new URL('./' + specifier.slice('@/lib/'.length) + '.ts', import.meta.url).href, context)
    }
    // Swap the persistence and authorization seams for scripted doubles.
    if (specifier === '@openbooks/engine/src/db.ts' || specifier.endsWith('/lib/feature-gates')) {
      return { url: mockUrls.get(specifier)!, shortCircuit: true }
    }
    const mocked = mockSources.get(specifier)
    if (mocked) return { url: mocked, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) {
      return { format: 'module', source, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const routeUrl = '../app/api/items/[id]/costing/route.ts?item-costing-route-test'
const { GET, PUT } = (await import(routeUrl)) as typeof import('../app/api/items/[id]/costing/route.ts')
hooks.deregister()

const ORG_ID = '00000000-0000-4000-8000-00000000b001'
const ITEM_ID = '00000000-0000-4000-8000-00000000c001'
const ACTOR_ID = 'user-1'
const ASSET_ACCOUNT = '00000000-0000-4000-8000-00000000a001'
const COGS_ACCOUNT = '00000000-0000-4000-8000-00000000a002'
const ADJUSTMENT_ACCOUNT = '00000000-0000-4000-8000-00000000a003'
const VARIANCE_ACCOUNT = '00000000-0000-4000-8000-00000000a004'
const GRNI_ACCOUNT = '00000000-0000-4000-8000-00000000a005'
const STORED_REVISION = '2026-08-24T12:00:00.100001Z'
const NEXT_REVISION = '2026-08-24T12:05:00.200002Z'

function profileRow(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    org_id: ORG_ID,
    item_id: ITEM_ID,
    costing_method: 'fifo',
    tracking: 'none',
    asset_account_id: ASSET_ACCOUNT,
    cogs_account_id: COGS_ACCOUNT,
    adjustment_account_id: ADJUSTMENT_ACCOUNT,
    variance_account_id: VARIANCE_ACCOUNT,
    received_not_billed_account_id: GRNI_ACCOUNT,
    standard_cost: '10.0000',
    base_unit: 'ea',
    reorder_point: '5.0000',
    preferred_stock_level: '50.0000',
    allow_negative_inventory: false,
    negative_cost_basis: 'last_receipt',
    provisional_unit_cost: null,
    created_by: ACTOR_ID,
    updated_by: ACTOR_ID,
    created_at: '2026-08-01T09:00:00.000000Z',
    updated_at: STORED_REVISION,
    ...overrides,
  }
}

const BASE_PROFILE = profileRow()
const NEXT_PROFILE = profileRow({
  costing_method: 'standard',
  allow_negative_inventory: true,
  negative_cost_basis: 'configured',
  provisional_unit_cost: '9.5000',
  updated_at: NEXT_REVISION,
})

function reset(): void {
  routeState.calls.length = 0
  routeState.itemExists = true
  routeState.historyExists = false
  routeState.committedProfiles = new Map([[ITEM_ID, { ...BASE_PROFILE }]])
  routeState.committedAudits = []
  routeState.failOn = 'none'
  routeState.nextProfileAfterUpsert = null
  ;(
    routeState as RouteState & {
      stagedProfile: ProfileRow | null
      pendingAudits: { action: string; changes: unknown }[]
      itemId: string
      txDepth: number
    }
  ).stagedProfile = null
  const extra = routeState as RouteState & {
    pendingAudits: { action: string; changes: unknown }[]
    itemId: string
    txDepth: number
  }
  extra.pendingAudits = []
  extra.itemId = ITEM_ID
  extra.txDepth = 0
}

function put(body: Record<string, unknown>): Promise<Response> {
  return PUT(new Request(`http://openbooks.test/api/items/${ITEM_ID}/costing`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: ITEM_ID }) })
}

function get(): Promise<Response> {
  return GET(new Request(`http://openbooks.test/api/items/${ITEM_ID}/costing`), {
    params: Promise.resolve({ id: ITEM_ID }),
  })
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    expectedUpdatedAt: STORED_REVISION,
    costingMethod: 'standard',
    tracking: 'none',
    assetAccountId: ASSET_ACCOUNT,
    cogsAccountId: COGS_ACCOUNT,
    adjustmentAccountId: ADJUSTMENT_ACCOUNT,
    varianceAccountId: VARIANCE_ACCOUNT,
    receivedNotBilledAccountId: GRNI_ACCOUNT,
    standardCost: '10',
    baseUnit: 'ea',
    reorderPoint: '5',
    preferredStockLevel: '50',
    allowNegativeInventory: true,
    negativeCostBasis: 'configured',
    provisionalUnitCost: '9.5',
    ...overrides,
  }
}

test('GET exposes the persisted revision token so callers can fence their save', async () => {
  reset()
  const response = await get()
  assert.equal(response.status, 200)
  const payload = (await response.json()) as { profile: { updated_at: string } | null }
  assert.ok(payload.profile, 'the stored profile is returned')
  assert.equal(payload.profile.updated_at, STORED_REVISION)
})

test('a reviewed save persists and audits the full policy change', async () => {
  reset()
  routeState.nextProfileAfterUpsert = NEXT_PROFILE
  const response = await put(validBody({ recostingAuthorization: 'REV-2026-087 controller approval' }))

  assert.equal(response.status, 200)
  const payload = (await response.json()) as { ok: boolean; updatedAt: string; policyChanged: boolean }
  assert.equal(payload.ok, true)
  assert.equal(payload.policyChanged, true)
  assert.equal(payload.updatedAt, NEXT_REVISION, 'the caller can chain the fresh revision')

  assert.deepEqual(routeState.committedProfiles.get(ITEM_ID), NEXT_PROFILE)
  assert.equal(routeState.committedAudits.length, 1, 'exactly one audit row was written')

  const audit = routeState.committedAudits[0]!
  assert.equal(audit.action, 'update')
  const changes = audit.changes as Record<string, any>
  assert.equal(changes.before.costing_method, 'fifo')
  assert.equal(changes.after.costing_method, 'standard')
  assert.deepEqual(changes.requested, { costingMethod: 'standard', tracking: 'none' })
  assert.equal(changes.recostingAuthorization, 'REV-2026-087 controller approval', 'the reason is recorded even without the history gate')
  assert.deepEqual(changes.revision, { before: STORED_REVISION, after: NEXT_REVISION }, 'exact revision evidence')
  // Adjustment, variance, GRNI and negative-stock policy fields are all in the evidence.
  assert.equal(changes.after.adjustment_account_id, ADJUSTMENT_ACCOUNT)
  assert.equal(changes.after.variance_account_id, VARIANCE_ACCOUNT)
  assert.equal(changes.after.received_not_billed_account_id, GRNI_ACCOUNT)
  assert.equal(changes.after.allow_negative_inventory, true)
  assert.equal(changes.after.negative_cost_basis, 'configured')
  assert.equal(changes.after.provisional_unit_cost, '9.5000')
})

test('the profile upsert and its audit row are written inside one transaction', async () => {
  reset()
  routeState.nextProfileAfterUpsert = NEXT_PROFILE
  await put(validBody())

  const upsertCalls = routeState.calls.filter((call) => call.text.includes('insert into item_inventory_profiles'))
  const auditCalls = routeState.calls.filter((call) => call.text.includes('insert into audit_log'))
  assert.equal(upsertCalls.length, 1)
  assert.equal(auditCalls.length, 1)
  assert.ok(
    upsertCalls.every((call) => call.kind === 'tx-execute') && auditCalls.every((call) => call.kind === 'tx-execute'),
    'both mutating statements ran inside the request transaction, not as autocommits',
  )
  assert.ok(routeState.committedAudits.length >= 1)
})

test('an optimistic-concurrency conflict returns 409 and writes nothing', async () => {
  reset()
  routeState.nextProfileAfterUpsert = NEXT_PROFILE
  const response = await put(validBody({ expectedUpdatedAt: '2026-08-24T11:00:00.000000Z' }))

  assert.equal(response.status, 409)
  assert.match(((await response.json()) as { error: string }).error, /changed after you opened it/)
  assert.deepEqual(routeState.committedProfiles.get(ITEM_ID), BASE_PROFILE, 'the stored profile is untouched')
  assert.equal(routeState.committedAudits.length, 0, 'no audit evidence for a refused write')
})

test('a fenced save under an exactly matching revision succeeds atomically', async () => {
  reset()
  routeState.nextProfileAfterUpsert = NEXT_PROFILE
  const response = await put(validBody({ expectedUpdatedAt: STORED_REVISION }))

  assert.equal(response.status, 200)
  const payload = (await response.json()) as { ok: boolean; updatedAt: string }
  assert.equal(payload.ok, true)
  assert.equal(payload.updatedAt, NEXT_REVISION)
  assert.deepEqual(routeState.committedProfiles.get(ITEM_ID), NEXT_PROFILE)
  assert.equal(routeState.committedAudits.length, 1)
  const changes = routeState.committedAudits[0]!.changes as Record<string, any>
  assert.equal(changes.revision.before, STORED_REVISION)
  assert.equal(changes.revision.after, NEXT_REVISION)

  const lock = routeState.calls.find((call) => call.text.includes('for update'))
  assert.ok(lock, 'the fenced save locks the profile row first')
  const fenceReads = routeState.calls.filter((call) =>
    call.text.includes('as updated_at from item_inventory_profiles'),
  )
  assert.equal(fenceReads.length, 1, 'the revision check happens once, under the lock')
})

test('a stale revision against a concurrently created profile conflicts with 409', async () => {
  reset()
  routeState.committedProfiles.delete(ITEM_ID)
  routeState.nextProfileAfterUpsert = NEXT_PROFILE
  const response = await put(validBody({ expectedUpdatedAt: STORED_REVISION }))

  assert.equal(response.status, 409)
  assert.equal(routeState.committedProfiles.size, 0, 'nothing was created behind the caller back')
  assert.equal(routeState.committedAudits.length, 0)
})

for (const failing of ['upsert', 'audit'] as const) {
  test(`a ${failing} statement failure leaves no partial write anywhere`, async () => {
    reset()
    routeState.failOn = failing
    routeState.nextProfileAfterUpsert = NEXT_PROFILE

    const response = await put(validBody({ expectedUpdatedAt: STORED_REVISION }))

    assert.equal(response.status, 400)
    assert.deepEqual(routeState.committedProfiles.get(ITEM_ID), BASE_PROFILE, 'the accounting policy is unchanged')
    assert.equal(routeState.committedAudits.length, 0, 'no orphan audit evidence')
  })
}

// The item-rate route is a neighboring API boundary but its live integration
// suite needs a database. Keep a cheap source-level guard in this route-boundary
// suite so a future edit cannot silently restore the two costly regressions.
const ratesRouteSource = readFileSync(
  new URL('../app/api/items/[id]/rates/route.ts', import.meta.url),
  'utf8',
)
const itemRatesSource = readFileSync(new URL('./item-rates.ts', import.meta.url), 'utf8')

test('item-rate version replacement copies unrelated item lines', () => {
  assert.match(ratesRouteSource, /const previousVersion = \(\(await tx\.execute/)
  assert.match(ratesRouteSource, /insert into item_rate_lines \([\s\S]*select org_id, \$\{version\.rows\[0\]\.id\}[\s\S]*item_id <> \$\{id\}/)
})

test('time bill snapshots rank matching dimensions and use the organization currency for defaults', () => {
  assert.match(itemRatesSource, /a\.department_id is null or a\.department_id = \$\{te\.department_id \?\? null\}/)
  assert.match(itemRatesSource, /a\.subsidiary_id is null or a\.subsidiary_id = \$\{te\.subsidiary_id \?\? null\}/)
  assert.match(itemRatesSource, /a\.location_id is null and a\.class_id is null/)
  assert.match(itemRatesSource, /order by c\.priority, c\.dimension_specificity desc/)
  assert.match(itemRatesSource, /o\.base_currency as default_rate_currency/)
  assert.match(itemRatesSource, /sourceCurrency = te\.default_rate_currency/)
})
