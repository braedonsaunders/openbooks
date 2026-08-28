import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { sql } from 'drizzle-orm'

const stateKey = Symbol.for('openbooks.budget-actions-route-test')
type Scope = Set<string> | null
interface RouteState {
  allowedSubsidiaryIds: Scope
  scenarioStatus: string
  scenarioRevision: number
  queries: string[]
}
const state: RouteState = {
  allowedSubsidiaryIds: null,
  scenarioStatus: 'draft',
  scenarioRevision: 1,
  queries: [],
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksBudgetSqlText = sqlText
;(globalThis as typeof globalThis & Record<string, unknown>).openbooksBudgetSql = sql

/** Flatten a drizzle SQL chunk into the text emitted to the database. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks
    .map((chunk) => {
      if (typeof chunk === 'string') return chunk
      const value = (chunk as { value?: unknown[] })?.value
      if (Array.isArray(value)) return value.map(String).join('')
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
      return ''
    })
    .join('')
}

const ORG_ID = '00000000-0000-4000-8000-000000000001'
const USER_ID = '00000000-0000-4000-8000-000000000002'
const SCENARIO_ID = '00000000-0000-4000-8000-000000000003'
const SOURCE_SCENARIO_ID = '00000000-0000-4000-8000-000000000004'
const BOOK_ID = '00000000-0000-4000-8000-000000000005'
const SUBSIDIARY_A = '00000000-0000-4000-8000-000000000006'

const mockSources = new Map<string, string>([
  [
    'mock:json',
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    'mock:feature-gates',
    `
      const state = globalThis[Symbol.for('openbooks.budget-actions-route-test')]
      export async function guardFeaturePermission() {
        return {
          user: { orgId: '${ORG_ID}', id: '${USER_ID}' },
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
    `,
  ],
  [
    'mock:authz',
    `
      export function can() { return true }
      export function subsidiariesInScope(gate, ids) {
        return gate.allowedSubsidiaryIds === null || ids.every((id) => gate.allowedSubsidiaryIds.has(id))
      }
    `,
  ],
  [
    'mock:list-params',
    `
      export function isUuid(value) { return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) }
    `,
  ],
  [
    'mock:subsidiaries',
    `
      const sql = globalThis.openbooksBudgetSql
      const sqlText = globalThis.openbooksBudgetSqlText
      export function subsidiaryVisibleFilter(column, allowed) {
        if (allowed === null) return sql.raw('')
        const ids = [...allowed]
        const columnText = sqlText(column)
        const columnName = columnText.includes('bl.subsidiary_id')
          ? 'bl.subsidiary_id'
          : columnText.includes('l.subsidiary_id')
            ? 'l.subsidiary_id'
            : 'subsidiary_id'
        return ids.length
          ? sql.raw(\` and \${columnName} = any('{\${ids.join(',')}}'::uuid[])\`)
          : sql.raw(' and false')
      }
    `,
  ],
  [
    'mock:budget-mutations',
    `
      export class BudgetMutationError extends Error {
        constructor(message, status = 422) { super(message); this.status = status }
      }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.budget-actions-route-test')]
      const sqlText = globalThis.openbooksBudgetSqlText
      export const db = {
        async transaction(work) {
          return work({
            async execute(query) {
              const text = sqlText(query)
              state.queries.push(text)
              if (text.includes('select id, name, description, book_id')) {
                return { rows: [{
                  id: '${SCENARIO_ID}', name: 'FY2026 Budget', description: null,
                  book_id: '${BOOK_ID}', fiscal_year: 2026,
                  kind: 'budget', status: state.scenarioStatus, revision: state.scenarioRevision,
                }] }
              }
              if (text.includes('select id from budget_scenarios')) return { rows: [{ id: '${SOURCE_SCENARIO_ID}' }] }
              if (text.includes('select 1 from accounting_periods')) return { rows: [{ one: 1 }] }
              if (text.includes('insert into budget_scenarios')) return { rows: [{ id: '00000000-0000-4000-8000-000000000007' }] }
              return { rows: [] }
            },
          })
        },
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@/lib/api/json', 'mock:json'],
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['../../../../../lib/authz', 'mock:authz'],
  ['../../../../../lib/feature-gates', 'mock:feature-gates'],
  ['../../../../../lib/list-params', 'mock:list-params'],
  ['../../../../../lib/subsidiaries', 'mock:subsidiaries'],
  ['../../../../../lib/budget-mutations', 'mock:budget-mutations'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
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

const routeUrl = new URL('./route.ts?budget-actions-route-test', import.meta.url).href
const { POST } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(scope: Scope): void {
  state.allowedSubsidiaryIds = scope
  state.scenarioStatus = 'draft'
  state.scenarioRevision = 1
  state.queries = []
}

function post(body: Record<string, unknown>, id = SCENARIO_ID): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/budgets/${id}/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
}

function sourceCopyQuery(): string {
  return state.queries.find((query) => query.includes('from journal_lines')) ?? ''
}

test('rejects invalid actions and malformed scenario ids', async () => {
  reset(null)
  assert.equal((await post({ action: 'nope', expectedRevision: 1 })).status, 422)
  assert.equal((await post({ action: 'archive', expectedRevision: 1 }, 'not-a-uuid')).status, 404)
})

test('rejects stale revisions and locked budget mutations', async () => {
  reset(null)
  state.scenarioRevision = 4
  assert.equal((await post({ action: 'copy_prior_actuals', expectedRevision: 1 })).status, 409)
  reset(null)
  state.scenarioStatus = 'approved'
  assert.equal((await post({ action: 'copy_prior_actuals', expectedRevision: 1 })).status, 409)
})

test('copy_prior_actuals keeps each subsidiary as a distinct budget cell', async () => {
  reset(null)
  const response = await post({ action: 'copy_prior_actuals', expectedRevision: 1 })
  assert.equal(response.status, 200)
  const query = sourceCopyQuery()
  assert.match(query, /insert into budget_lines[\s\S]*subsidiary_id/)
  assert.match(query, /group by l\.account_id, destination\.id, l\.subsidiary_id/)
})

test('copy_prior_actuals applies restricted subsidiary visibility to source actuals', async () => {
  reset(new Set([SUBSIDIARY_A]))
  const response = await post({ action: 'copy_prior_actuals', expectedRevision: 1 })
  assert.equal(response.status, 200)
  assert.match(sourceCopyQuery(), new RegExp(`l\\.subsidiary_id = any\\(\\'{${SUBSIDIARY_A}\\}'::uuid\\[\\]\\)`))
})

test('copy_prior_actuals fails closed for an empty restricted subsidiary scope', async () => {
  reset(new Set())
  const response = await post({ action: 'copy_prior_actuals', expectedRevision: 1 })
  assert.equal(response.status, 200)
  assert.match(sourceCopyQuery(), /and false/)
})

test('copy_prior_actuals rejects an explicitly selected hidden subsidiary', async () => {
  reset(new Set([SUBSIDIARY_A]))
  const hidden = '00000000-0000-4000-8000-000000000008'
  const response = await post({ action: 'copy_prior_actuals', expectedRevision: 1, subsidiaryId: hidden })
  assert.equal(response.status, 422)
  assert.equal(sourceCopyQuery(), '')
})

test('copy and apply_source preserve subsidiary identity while honoring scope', async () => {
  reset(new Set([SUBSIDIARY_A]))
  const copied = await post({ action: 'copy', expectedRevision: 1 })
  assert.equal(copied.status, 200)
  const copyQuery = state.queries.find((query) => query.includes('insert into budget_lines')) ?? ''
  assert.match(copyQuery, /period_id, subsidiary_id, department_id/)
  assert.match(copyQuery, /bl\.subsidiary_id = any\('\{00000000-0000-4000-8000-000000000006\}'::uuid\[\]\)/)

  reset(new Set([SUBSIDIARY_A]))
  const applied = await post({ action: 'apply_source', expectedRevision: 1, sourceScenarioId: SOURCE_SCENARIO_ID })
  assert.equal(applied.status, 200)
  const applyQuery = state.queries.find((query) => query.includes('insert into budget_lines')) ?? ''
  assert.match(applyQuery, /period_id, subsidiary_id, department_id/)
  assert.match(applyQuery, /bl\.subsidiary_id = any\('\{00000000-0000-4000-8000-000000000006\}'::uuid\[\]\)/)
})
