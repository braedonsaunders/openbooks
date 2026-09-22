import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

/**
 * Route boundary for the report builder's unsaved-create contract. The UI
 * does not call this endpoint on open/cancel; explicit Save supplies one UUID
 * key. Exact retries replay one tenant row/audit, while changed or foreign
 * reuse fails closed.
 */
const stateKey = Symbol.for('openbooks.report-definitions-create-test')
const ORG_ID = '00000000-0000-4000-8000-00000000d001'
const USER_ID = '00000000-0000-4000-8000-00000000d002'
const OTHER_ORG = '00000000-0000-4000-8000-00000000d003'

interface DefinitionRow {
  id: string
  org_id: string
  slug: string
  kind: string
  name: string
}

interface RouteState {
  requestKey: string | null
  rows: Map<string, DefinitionRow>
  auditAfter: Map<string, Record<string, unknown>>
  auditInserts: number
  transactionQueries: string[]
}

const state: RouteState = {
  requestKey: null,
  rows: new Map(),
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
      if (typeof chunk === 'string' || !chunk || typeof chunk !== 'object') return ''
      if (Array.isArray((chunk as { queryChunks?: unknown }).queryChunks)) return sqlText(chunk)
      const value = (chunk as { value?: unknown }).value
      if (typeof value === 'string') return value
      if (Array.isArray(value)) return value.filter((part) => typeof part === 'string').join('')
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
          typeof chunk === 'string'
          || typeof chunk === 'number'
          || typeof chunk === 'boolean'
          || chunk === null
        ) out.push(chunk)
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
        const value = (chunk as { value?: unknown }).value
        if (typeof value === 'string') out.push(value)
      }
    }
  }
  walk((query as { queryChunks?: unknown })?.queryChunks)
  return out
}

function sniffAudit(params: unknown[]): void {
  for (const param of params) {
    if (typeof param !== 'string') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(param)
    } catch {
      continue
    }
    if (
      parsed !== null
      && typeof parsed === 'object'
      && (parsed as { before?: unknown }).before === null
      && typeof (parsed as { after?: unknown }).after === 'object'
    ) {
      state.auditInserts += 1
      if (state.requestKey) {
        state.auditAfter.set(
          state.requestKey,
          (parsed as { after: Record<string, unknown> }).after,
        )
      }
    }
  }
}

;(globalThis as typeof globalThis & Record<string, unknown>).reportCreateSqlText = sqlText
;(globalThis as typeof globalThis & Record<string, unknown>).reportCreateParamsOf = paramsOf
;(globalThis as typeof globalThis & Record<string, unknown>).reportCreateSniffAudit = sniffAudit

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.report-definitions-create-test')]
      const sqlText = globalThis.reportCreateSqlText
      const paramsOf = globalThis.reportCreateParamsOf
      const sniffAudit = globalThis.reportCreateSniffAudit
      function responseRow(row) {
        return {
          id: row.id,
          kind: row.kind,
          slug: row.slug,
          name: row.name,
          description: null,
          query: { entity: 'ledger_lines', mode: 'rows', columns: ['posting_date'], limit: 1000 },
          layout: null,
          updated_at: '2026-09-22T00:00:00.000000Z',
        }
      }
      function respond(query) {
        const text = sqlText(query)
        const params = paramsOf(query)
        sniffAudit(params)
        if (text.includes('insert into report_definitions')) {
          if (state.rows.has(state.requestKey)) return { rows: [] }
          const after = state.auditAfter.get(state.requestKey)
          const row = {
            id: state.requestKey,
            org_id: '${ORG_ID}',
            slug: 'monthly-close',
            kind: 'custom',
            name: after?.name ?? 'Monthly close',
          }
          state.rows.set(state.requestKey, row)
          return { rows: [responseRow(row)] }
        }
        if (text.includes('from audit_log')) {
          const after = state.requestKey ? state.auditAfter.get(state.requestKey) : undefined
          return { rows: after ? [{ after }] : [] }
        }
        if (text.includes('from report_definitions')) {
          const row = state.requestKey ? state.rows.get(state.requestKey) : undefined
          if (!row || row.org_id !== '${ORG_ID}') return { rows: [] }
          return { rows: text.includes('select id from') ? [{ id: row.id }] : [responseRow(row)] }
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
    `export async function guardPermission(permission) {
       if (permission === 'reports.create' || permission === 'reports.read') {
         return { user: { orgId: '${ORG_ID}', id: '${USER_ID}' }, permissions: new Set(['reports.create']) }
       }
       return new Response(null, { status: 403 })
     }`,
  ],
  [
    'mock:catalog',
    `export async function validateOrgReportQuery(_gate, query) {
       if (!query || typeof query !== 'object' || Array.isArray(query)) throw new Error('Invalid report query')
       return query
     }`,
  ],
  [
    'mock:report-authz',
    `export async function canRunReportEntity() { return true }
     export async function canRunReportStatement() { return true }
     export async function guardReportEntity() { return null }`,
  ],
  [
    'mock:custom-reports',
    `export function slugifyReportName() { return 'monthly-close' }
     export async function uniqueReportSlug() { return 'monthly-close' }`,
  ],
  ['mock:ensure-definitions', 'export async function ensureReportDefinitions() {}'],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['../../../../lib/authz', 'mock:authz'],
  ['@/lib/custom-record-report-catalog', 'mock:catalog'],
  ['../../../../lib/report-authz', 'mock:report-authz'],
  ['../../../../lib/custom-reports', 'mock:custom-reports'],
  ['@openbooks/engine/src/reports/ensure-report-definitions.ts', 'mock:ensure-definitions'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    }
    if (specifier === '@/lib/api/json') {
      return { shortCircuit: true, url: new URL('../../../../lib/api/json.ts', import.meta.url).href }
    }
    if (specifier === '@openbooks/engine/src/platform/canonical-json.ts') {
      return {
        shortCircuit: true,
        url: new URL('../../../../../engine/src/platform/canonical-json.ts', import.meta.url).href,
      }
    }
    const mocked = mockUrls.get(specifier)
    if (mocked) return { shortCircuit: true, url: mocked }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const routeUrl = './route.ts?report-create-idempotency-test'
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.requestKey = null
  state.rows.clear()
  state.auditAfter.clear()
  state.auditInserts = 0
  state.transactionQueries.length = 0
}

const QUERY = {
  entity: 'ledger_lines',
  mode: 'rows',
  columns: ['posting_date'],
  filters: null,
  limit: 1000,
}

const BODY = {
  name: 'Monthly close',
  description: 'Close evidence',
  query: QUERY,
  layout: null,
}

function post(key: string | null, body: Record<string, unknown>): Promise<Response> {
  state.requestKey = key
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (key) headers['Idempotency-Key'] = key
  return POST(new Request('http://openbooks.test/api/reports/definitions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }))
}

test('report create refuses a missing or malformed idempotency key before any write', async () => {
  reset()
  for (const key of [null, 'not-a-uuid']) {
    const response = await post(key, BODY)
    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: 'invalid_idempotency_key' })
  }
  assert.equal(state.transactionQueries.length, 0)
})

test('report Save creates and audits once, replays exactly, and refuses changed reuse', async () => {
  reset()
  const key = '00000000-0000-4000-8000-00000000d010'

  const created = await post(key, BODY)
  assert.equal(created.status, 201)
  const createdBody = (await created.json()) as { definition: { id: string } }
  assert.equal(createdBody.definition.id, key)
  assert.equal(state.auditInserts, 1)
  assert.equal(state.auditAfter.get(key)?.org_id, ORG_ID)
  assert.deepEqual(state.auditAfter.get(key)?.query, QUERY)

  const replay = await post(key, BODY)
  assert.equal(replay.status, 200)
  assert.equal(((await replay.json()) as { definition: { id: string } }).definition.id, key)
  assert.equal(state.auditInserts, 1, 'an exact retry must not duplicate audit evidence')

  const changed = await post(key, { ...BODY, name: 'Changed report' })
  assert.equal(changed.status, 409)
  assert.deepEqual(await changed.json(), { error: 'invalid_idempotency_key' })
})

test('report create refuses malformed plans and foreign key collisions without writing', async () => {
  reset()
  const invalidKey = '00000000-0000-4000-8000-00000000d011'
  const invalid = await post(invalidKey, { ...BODY, query: 'tomorrow' })
  assert.equal(invalid.status, 422)
  assert.equal(state.rows.size, 0)

  const foreignKey = '00000000-0000-4000-8000-00000000d012'
  state.rows.set(foreignKey, {
    id: foreignKey,
    org_id: OTHER_ORG,
    slug: 'foreign',
    kind: 'custom',
    name: 'Foreign report',
  })
  const foreign = await post(foreignKey, BODY)
  assert.equal(foreign.status, 409)
  assert.deepEqual(await foreign.json(), { error: 'invalid_idempotency_key' })
  assert.equal(state.auditInserts, 0)
})
