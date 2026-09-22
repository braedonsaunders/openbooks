import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const stateKey = Symbol.for('openbooks.item-create-route-test')
const ITEM_ID = '00000000-0000-4000-8000-00000000b101'
const ORG_ID = '00000000-0000-4000-8000-00000000b102'
const ACTOR_ID = '00000000-0000-4000-8000-00000000b103'

interface State {
  item: Record<string, unknown> | null
  audits: Array<{ changes: Record<string, unknown> }>
  calls: Array<{ text: string; inTransaction: boolean }>
  failAudit: boolean
  featureEnabled: boolean
  inTransaction: boolean
}

const state: State = {
  item: null,
  audits: [],
  calls: [],
  failAudit: false,
  featureEnabled: true,
  inTransaction: false,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return ''
  return chunks.map((chunk) => {
    if (typeof chunk === 'string') return chunk
    const value = (chunk as { value?: unknown[] })?.value
    if (Array.isArray(value)) return value.map(String).join('')
    if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk)
    return ''
  }).join('')
}

function sqlValues(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return []
  return chunks.flatMap((chunk) => {
    if (typeof chunk === 'string') return [chunk]
    if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlValues(chunk)
    return []
  })
}

;(globalThis as typeof globalThis & { itemCreateSqlText?: unknown }).itemCreateSqlText = sqlText
;(globalThis as typeof globalThis & { itemCreateSqlValues?: unknown }).itemCreateSqlValues = sqlValues

const mockSources = new Map<string, string>([
  ['mock:db', `
    const state = globalThis[Symbol.for('openbooks.item-create-route-test')]
    const sqlText = globalThis.itemCreateSqlText
    const sqlValues = globalThis.itemCreateSqlValues
    export const db = {
      execute: async (query) => {
        const text = sqlText(query)
        const values = sqlValues(query)
        state.calls.push({ text, inTransaction: state.inTransaction })
        if (text.includes('insert into items')) {
          if (state.item) return { rows: [] }
          state.item = {
            id: '${ITEM_ID}', org_id: '${ORG_ID}', kind: 'service', code: null,
            name: 'Consulting', description: null, category: null, unit: null,
            default_rate: '125.0000', default_cost: '50.0000',
            income_account_id: null, expense_account_id: null,
            payroll_expense_account_id: null, cost_recovery_account_id: null,
            tax_code_id: null, show_on_timesheet: false,
            recognition_rule_id: null, deferred_account_id: null,
            create_plans_on: 'billing', revenue_allocation: 'normal',
            standalone_selling_price: null, is_active: true, custom: {},
          }
          return { rows: [{ id: '${ITEM_ID}' }] }
        }
        if (text.includes("changes->'after'")) {
          return { rows: state.audits[0] ? [{ after: state.audits[0].changes.after }] : [] }
        }
        if (text.includes('insert into audit_log')) {
          if (state.failAudit) throw new Error('audit writer unavailable')
          const encoded = values.find((value) => typeof value === 'string' && value.startsWith('{"before"'))
          if (typeof encoded !== 'string') throw new Error('audit changes missing')
          state.audits.push({ changes: JSON.parse(encoded) })
          return { rows: [] }
        }
        return { rows: [] }
      },
    }
    export async function withOrgTransaction(_orgId, work) {
      const beforeItem = structuredClone(state.item)
      const beforeAudits = structuredClone(state.audits)
      state.inTransaction = true
      try { return await work() }
      catch (error) { state.item = beforeItem; state.audits = beforeAudits; throw error }
      finally { state.inTransaction = false }
    }
  `],
  ['mock:authz', `export async function guardPermission() { return { user: { orgId: '${ORG_ID}', id: '${ACTOR_ID}' } } }`],
  ['mock:features', `export async function isFeatureEnabled() { return globalThis[Symbol.for('openbooks.item-create-route-test')].featureEnabled }`],
  ['mock:custom-fields', `
    export async function loadFieldDefs() { return [] }
    export function validateCustomValues(_defs, values) { return { ok: true, errors: {}, cleaned: values ?? {} } }
    export async function findUnownedCustomReferences() { return [] }
  `],
  ['mock:item-lib', `
    export async function loadItem() {
      const item = globalThis[Symbol.for('openbooks.item-create-route-test')].item
      return item ? { item: structuredClone(item), incomeAccountName: null, expenseAccountName: null, payrollCostingAccountName: null, taxCodeName: null } : null
    }
  `],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/platform/db.ts', 'mock:db'],
  ['../../../lib/authz', 'mock:authz'],
  ['../../../lib/features', 'mock:features'],
  ['../../../lib/custom-fields', 'mock:custom-fields'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === './_lib' && context.parentURL?.includes('/api/items/')) return { shortCircuit: true, url: 'mock:item-lib' }
    if (specifier.startsWith('@/') && context.parentURL) {
      return nextResolve(new URL(`../../../${specifier.slice(2)}.ts`, context.parentURL).href, context)
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

const routeUrl = './route.ts?item-create-test'
const { POST } = await import(routeUrl) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  state.item = null
  state.audits.length = 0
  state.calls.length = 0
  state.failAudit = false
  state.featureEnabled = true
  state.inTransaction = false
}

function create(body: Record<string, unknown>, id = ITEM_ID): Promise<Response> {
  return POST(new Request('http://openbooks.test/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': id },
    body: JSON.stringify(body),
  }))
}

test('POST inserts one active item and its immutable insert audit atomically', async () => {
  reset()
  const response = await create({ kind: 'service', name: 'Consulting', defaultRate: '125', defaultCost: '50', isActive: true })

  assert.equal(response.status, 201)
  assert.equal(state.item?.is_active, true)
  assert.equal(state.audits.length, 1)
  assert.equal(state.audits[0]?.changes.before, null)
  assert.equal((state.audits[0]?.changes.after as Record<string, unknown>).id, ITEM_ID)
  assert.ok(state.calls.every((call) => call.inTransaction), 'insert and audit share the tenant transaction')
})

test('POST rolls the item insert back when the audit cannot be written', async () => {
  reset()
  state.failAudit = true

  await assert.rejects(() => create({ kind: 'service', name: 'Consulting' }), /audit writer unavailable/)
  assert.equal(state.item, null)
  assert.equal(state.audits.length, 0)
})

test('POST replay returns the original item without a second insert audit', async () => {
  reset()
  const body = { kind: 'service', name: 'Consulting', defaultRate: '125', defaultCost: '50', isActive: true }
  assert.equal((await create(body)).status, 201)
  assert.equal((await create(body)).status, 200)
  assert.equal(state.audits.length, 1)
})

test('POST refuses an idempotency-key replay whose create payload changed', async () => {
  reset()
  assert.equal((await create({ kind: 'service', name: 'Consulting' })).status, 201)

  const response = await create({ kind: 'service', name: 'Different item' })
  assert.equal(response.status, 409)
  assert.equal(state.audits.length, 1)
  assert.equal(state.item?.name, 'Consulting')
})

test('POST requires a well-formed idempotency key before any write', async () => {
  reset()
  const response = await create({ kind: 'service', name: 'Consulting' }, 'not-a-uuid')

  assert.equal(response.status, 400)
  assert.equal(state.item, null)
  assert.equal(state.calls.length, 0)
})

test('POST refuses a dangling or cross-organization account reference', async () => {
  reset()
  const response = await create({
    kind: 'service',
    name: 'Consulting',
    incomeAccountId: '00000000-0000-4000-8000-00000000b999',
  })

  assert.equal(response.status, 422)
  assert.equal(state.item, null)
  assert.equal(state.audits.length, 0)
})

test('POST refuses a newly disabled item kind without writing', async () => {
  reset()
  state.featureEnabled = false
  const response = await create({ kind: 'inventory', name: 'Stocked widget' })

  assert.equal(response.status, 404)
  assert.equal(state.item, null)
  assert.equal(state.audits.length, 0)
})
