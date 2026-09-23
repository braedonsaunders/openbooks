import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Route-boundary suite for the canonical unsaved create contract: opening the
// New dashboard dialog (or cancelling it) must write nothing — this endpoint
// runs only on explicit Save, keyed by Idempotency-Key exactly like POST
// /api/accounts. An exact retry replays (200); a changed payload on the same
// key, or a key colliding with another org's row, is a 409 that returns no row.
const stateKey = Symbol.for('openbooks.insight-dashboards-create-test')
const ORG_ID = '00000000-0000-4000-8000-00000000d101'
const USER_ID = '00000000-0000-4000-8000-00000000d102'
const OTHER_ORG = '00000000-0000-4000-8000-00000000d103'

interface DashboardRow {
  id: string
  org_id: string
}

interface RouteState {
  requestKey: string | null
  rows: Map<string, DashboardRow>
  /** Card ids the visibility predicate admits for the calling org. */
  visibleCards: Set<string>
  auditAfter: Map<string, Record<string, unknown>>
  auditInserts: number
  transactionQueries: string[]
}

const state: RouteState = {
  requestKey: null,
  rows: new Map(),
  visibleCards: new Set(),
  auditAfter: new Map(),
  auditInserts: 0,
  transactionQueries: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return ''
      if (!chunk || typeof chunk !== 'object') return ''
      if (Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)) {
        return sqlText(chunk)
      }
      const value = (chunk as { value?: unknown }).value
      if (typeof value === 'string') return value
      if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join('')
      return ''
    })
    .join('')
}

function paramsOf(query: unknown): unknown[] {
  const out: unknown[] = []
  const walk = (chunks: unknown): void => {
    if (!Array.isArray(chunks)) return
    for (const chunk of chunks) {
      if (!chunk || typeof chunk !== 'object') {
        if (
          typeof chunk === 'string' ||
          typeof chunk === 'number' ||
          typeof chunk === 'boolean' ||
          chunk === null
        ) {
          out.push(chunk)
        }
        continue
      }
      if (Array.isArray(chunk)) {
        out.push(...chunk)
        continue
      }
      const nested = (chunk as { queryChunks?: unknown }).queryChunks
      if (Array.isArray(nested)) {
        walk(nested)
        continue
      }
      if ('value' in chunk) {
        const v = (chunk as { value?: unknown }).value
        if (typeof v === 'string') out.push(v)
      }
    }
  }
  walk((query as { queryChunks?: unknown })?.queryChunks)
  return out
}

function sniffAudit(params: unknown[]): void {
  for (const param of params) {
    if (typeof param !== 'string') continue
    let parsed: unknown = null
    try {
      parsed = JSON.parse(param)
    } catch {
      continue
    }
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      (parsed as { before?: unknown }).before === null &&
      typeof (parsed as { after?: unknown }).after === 'object'
    ) {
      state.auditInserts += 1
      if (state.requestKey) {
        state.auditAfter.set(state.requestKey, (parsed as { after: Record<string, unknown> }).after)
      }
    }
  }
}

;(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksInsightDashboardsSqlText = sqlText
;(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksInsightDashboardsParamsOf = paramsOf
;(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksInsightDashboardsSniffAudit = sniffAudit

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.insight-dashboards-create-test')]
      const sqlText = globalThis.openbooksInsightDashboardsSqlText
      const paramsOf = globalThis.openbooksInsightDashboardsParamsOf
      const sniffAudit = globalThis.openbooksInsightDashboardsSniffAudit
      function respond(query) {
        const text = sqlText(query)
        const params = paramsOf(query)
        sniffAudit(params)
        if (text.includes('from insight_cards')) {
          const wanted = []
          for (const param of params) {
            if (typeof param === 'string' && param.startsWith('{') && param.endsWith('}')) {
              wanted.push(...param.slice(1, -1).split(',').filter(Boolean))
            }
          }
          return { rows: wanted.filter((id) => state.visibleCards.has(id)).map((id) => ({ id })) }
        }
        if (text.includes('insert into insight_dashboards')) {
          if (state.rows.has(state.requestKey)) return { rows: [] }
          state.rows.set(state.requestKey, { id: state.requestKey, org_id: '${ORG_ID}' })
          return { rows: [{ id: state.requestKey }] }
        }
        if (text.includes('from audit_log')) {
          const after = state.requestKey ? state.auditAfter.get(state.requestKey) : undefined
          return { rows: after ? [{ after }] : [] }
        }
        if (text.includes('from insight_dashboards')) {
          const row = state.requestKey ? state.rows.get(state.requestKey) : undefined
          return { rows: row && row.org_id === '${ORG_ID}' ? [{ id: row.id }] : [] }
        }
        return { rows: [] }
      }
      export const db = {
        execute: async (query) => respond(query),
        transaction: async (work) => work({
          execute: async (query) => {
            state.transactionQueries.push(sqlText(query))
            return respond(query)
          },
        }),
      }
      export const schema = {}
      export function withOrgTransaction(_orgId, work) { return work() }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export const pool = {}
      export const env = {}
      export function registerRequestOrgResolver() {}
      export function currentRequestOrgResolver() { return null }
      export function ambientTenantOrgId() { return null }
    `,
  ],
  [
    'mock:authz',
    // A faithful editor gate: real gates always carry the effective
    // permission set the visibility predicate reads.
    `export async function guardPermission(permission) {
       if (permission === 'insights.create') return {
         user: { orgId: '${ORG_ID}', id: '${USER_ID}' },
         permissions: new Set(['insights.read', 'insights.create']),
         allowedSubsidiaryIds: null,
       }
       return new Response(null, { status: 403 })
     }`,
  ],
  ['mock:get-authz', `export async function getAuthz() { return null }`],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['../../../../lib/authz', 'mock:authz'],
  ['@/lib/authz', 'mock:get-authz'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@/lib/api/json') {
      return {
        url: new URL('../../../../lib/api/json.ts', import.meta.url).href,
        shortCircuit: true,
      }
    }
    if (specifier === '@openbooks/engine/src/platform/canonical-json.ts') {
      return {
        url: new URL(
          '../../../../../engine/src/platform/canonical-json.ts',
          import.meta.url,
        ).href,
        shortCircuit: true,
      }
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

const routeUrl = './route.ts?insight-dashboards-create-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.requestKey = null
  state.rows.clear()
  state.visibleCards.clear()
  state.auditAfter.clear()
  state.auditInserts = 0
  state.transactionQueries.length = 0
}

const BODY = {
  name: 'Executive overview',
  description: null,
  layout: [],
  allowedRoles: null,
}

function post(key: string | null, body: Record<string, unknown>): Promise<Response> {
  state.requestKey = key
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key !== null) headers['Idempotency-Key'] = key
  return POST(
    new Request('http://openbooks.test/api/insights/dashboards', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  )
}

test('dashboard create refuses a missing or malformed idempotency key before any write', async () => {
  reset()

  const missing = await post(null, BODY)
  assert.equal(missing.status, 400)
  assert.deepEqual(await missing.json(), { error: 'invalid_idempotency_key' })

  const malformed = await post('not-a-uuid', BODY)
  assert.equal(malformed.status, 400)
  assert.deepEqual(await malformed.json(), { error: 'invalid_idempotency_key' })

  assert.equal(state.transactionQueries.length, 0, 'refused keys must not reach the database at all')
})

test('dashboard create validates the layout before inserting', async () => {
  reset()
  const key = '00000000-0000-4000-8000-00000000d110'

  const badLayout = await post(key, { ...BODY, layout: 'everywhere' })
  assert.equal(badLayout.status, 422)

  const badPlacement = await post(key, { ...BODY, layout: [{ cardId: 'not-a-uuid' }] })
  assert.equal(badPlacement.status, 422)

  assert.equal(state.rows.size, 0, 'validation failures must not insert')
})

test('dashboard creation replays only the exact request for an idempotency key', async () => {
  reset()
  const key = '00000000-0000-4000-8000-00000000d111'

  const created = await post(key, BODY)
  assert.equal(created.status, 201)
  assert.deepEqual(await created.json(), { id: key })
  assert.equal(state.auditInserts, 1, 'the create must leave exactly one insert audit event')
  assert.equal(state.auditAfter.get(key)?.name, 'Executive overview')

  const replay = await post(key, BODY)
  assert.equal(replay.status, 200)
  assert.deepEqual(await replay.json(), { id: key })
  assert.equal(state.auditInserts, 1, 'a replay must not write a second audit event')

  const changed = await post(key, { ...BODY, name: 'Something else' })
  assert.equal(changed.status, 409)
  assert.deepEqual(await changed.json(), { error: 'invalid_idempotency_key' })
})

test('dashboard create accepts a layout whose cards are all visible to the caller', async () => {
  reset()
  const key = '00000000-0000-4000-8000-00000000d120'
  const card = '00000000-0000-4000-8000-00000000c120'
  state.visibleCards.add(card)

  const response = await post(key, { ...BODY, layout: [{ cardId: card, x: 0, y: 0, w: 6, h: 4 }] })
  assert.equal(response.status, 201)
  assert.deepEqual(await response.json(), { id: key })
  assert.equal(state.auditInserts, 1, 'a valid create still writes its audit event')
})

test('dashboard create refuses a layout naming a missing card before any write', async () => {
  reset()
  const key = '00000000-0000-4000-8000-00000000d121'
  const missing = '00000000-0000-4000-8000-00000000c121'

  const response = await post(key, { ...BODY, layout: [{ cardId: missing, x: 0, y: 0, w: 6, h: 4 }] })
  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: 'Layout references an unavailable card' })
  assert.equal(state.rows.size, 0, 'the refusal commits no dashboard row')
  assert.equal(state.auditInserts, 0, 'the refusal commits no audit event')
})

test('dashboard create refuses a layout naming another org’s card before any write', async () => {
  reset()
  const key = '00000000-0000-4000-8000-00000000d122'
  // The card exists (a second org holds it) but the visibility predicate
  // does not admit it for this caller, so the check sees zero rows.
  const foreign = '00000000-0000-4000-8000-00000000c122'

  const response = await post(key, { ...BODY, layout: [{ cardId: foreign, x: 0, y: 0, w: 6, h: 4 }] })
  assert.equal(response.status, 422)
  assert.deepEqual(await response.json(), { error: 'Layout references an unavailable card' })
  assert.equal(state.rows.size, 0, 'the refusal commits no dashboard row')
  assert.equal(state.auditInserts, 0, 'the refusal commits no audit event')
})

test('dashboard create refuses a key colliding with another org without disclosing it', async () => {
  reset()
  const key = '00000000-0000-4000-8000-00000000d112'
  state.rows.set(key, { id: key, org_id: OTHER_ORG })

  const response = await post(key, BODY)
  assert.equal(response.status, 409)
  assert.deepEqual(await response.json(), { error: 'invalid_idempotency_key' })
  assert.equal(state.auditInserts, 0, 'a foreign collision must not audit in this org')
})
