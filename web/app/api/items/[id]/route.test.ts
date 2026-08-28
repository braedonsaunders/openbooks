import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Executable route-boundary harness. The fake database applies the route's
// actual SQL and emulates transaction commit/rollback; it does not inspect the
// route source. This keeps the two controls under test observable: the item
// lock precedes the write, and an audit failure restores the item exactly.
const stateKey = Symbol.for('openbooks.item-route-test')
type ItemRow = Record<string, unknown>
interface RouteState {
  item: ItemRow
  nextItem: ItemRow
  audits: Array<{ changes: Record<string, unknown>; actorId: string; at: string }>
  calls: Array<{ text: string; inTransaction: boolean }>
  transactionOrgs: string[]
  failAudit: boolean
  inTransaction: boolean
}

const ITEM_ID = '00000000-0000-4000-8000-00000000a101'
const ORG_ID = '00000000-0000-4000-8000-00000000a102'
const ACTOR_ID = '00000000-0000-4000-8000-00000000a103'
const INCOME_ID = '00000000-0000-4000-8000-00000000a104'
const EXPENSE_ID = '00000000-0000-4000-8000-00000000a105'

const originalItem: ItemRow = {
  id: ITEM_ID,
  org_id: ORG_ID,
  kind: 'service',
  code: 'SVC-1',
  name: 'Consulting',
  description: 'Original description',
  category: 'Services',
  unit: 'hour',
  default_rate: '100.0000',
  default_cost: '40.0000',
  income_account_id: INCOME_ID,
  expense_account_id: EXPENSE_ID,
  cost_recovery_account_id: null,
  tax_code_id: null,
  show_on_timesheet: false,
  recognition_rule_id: null,
  deferred_account_id: null,
  create_plans_on: 'billing',
  revenue_allocation: 'normal',
  standalone_selling_price: null,
  is_active: true,
  custom: { department: 'advisory' },
  updated_at: '2026-08-28T12:00:00.000Z',
  updated_by: ACTOR_ID,
}

const routeState: RouteState = {
  item: structuredClone(originalItem),
  nextItem: structuredClone(originalItem),
  audits: [],
  calls: [],
  transactionOrgs: [],
  failAudit: false,
  inTransaction: false,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState

/** Flatten a drizzle SQL object into text for the fake driver's routing. */
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

/** Values are direct primitive chunks in the drizzle SQL object. */
function sqlValues(query: unknown): unknown[] {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks
  if (!Array.isArray(chunks)) return []
  return chunks.flatMap((chunk) => {
    if (typeof chunk === 'string') return [chunk]
    if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlValues(chunk)
    return []
  })
}

;(globalThis as typeof globalThis & { openbooksSqlTextItem?: unknown }).openbooksSqlTextItem = sqlText
;(globalThis as typeof globalThis & { openbooksSqlValuesItem?: unknown }).openbooksSqlValuesItem = sqlValues

const mockSources = new Map<string, string>([
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.item-route-test')]
      const sqlText = globalThis.openbooksSqlTextItem
      const sqlValues = globalThis.openbooksSqlValuesItem
      export const db = {
        execute: async (query) => {
          const text = sqlText(query)
          state.calls.push({ text, inTransaction: state.inTransaction })
          const values = sqlValues(query)
          if (text.includes('select * from items') && text.includes('for update')) {
            return { rows: [structuredClone(state.item)] }
          }
          if (text.includes('select 1 from accounts')) {
            const id = values.find((value) => value === '${INCOME_ID}' || value === '${EXPENSE_ID}')
            return { rows: id ? [{ id }] : [] }
          }
          if (text.includes('select 1 from tax_codes') || text.includes('select 1 from recognition_rules')) {
            return { rows: [] }
          }
          if (text.includes('update items set')) {
            state.item = structuredClone(state.nextItem)
            return { rows: [structuredClone(state.item)] }
          }
          if (text.includes('insert into audit_log')) {
            if (state.failAudit) throw new Error('audit writer unavailable')
            const encoded = values.find((value) => typeof value === 'string' && value.startsWith('{'))
            if (typeof encoded !== 'string') throw new Error('audit changes missing')
            state.audits.push({ changes: JSON.parse(encoded), actorId: '${ACTOR_ID}', at: new Date().toISOString() })
            return { rows: [] }
          }
          return { rows: [] }
        },
      }
      export async function withOrgTransaction(orgId, work) {
        const before = structuredClone(state.item)
        const audits = structuredClone(state.audits)
        state.transactionOrgs.push(orgId)
        state.inTransaction = true
        try {
          return await work()
        } catch (error) {
          state.item = before
          state.audits = audits
          throw error
        } finally {
          state.inTransaction = false
        }
      }
    `,
  ],
  [
    'mock:authz',
    `
      export async function guardPermission() {
        return { user: { orgId: '${ORG_ID}', id: '${ACTOR_ID}' } }
      }
    `,
  ],
  ['mock:features', `export async function isFeatureEnabled() { return true }`],
  [
    'mock:custom-fields',
    `
      export async function loadFieldDefs() { return [] }
      export function validateCustomValues(_defs, values) { return { ok: true, errors: {}, cleaned: values ?? {} } }
    `,
  ],
  [
    'mock:item-lib',
    `
      const state = globalThis[Symbol.for('openbooks.item-route-test')]
      export async function loadItem() {
        return { item: structuredClone(state.item), incomeAccountName: null, expenseAccountName: null, taxCodeName: null }
      }
    `,
  ],
])

const mockUrls = new Map<string, string>([
  ['@openbooks/engine/src/db.ts', 'mock:db'],
  ['../../../../lib/authz', 'mock:authz'],
  ['../../../../lib/features', 'mock:features'],
  ['../../../../lib/custom-fields', 'mock:custom-fields'],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') return { shortCircuit: true, format: 'module', url: 'data:text/javascript,export {}' }
    if (specifier === '../_lib' && context.parentURL?.includes('/api/items/')) {
      return { url: 'mock:item-lib', shortCircuit: true }
    }
    if (specifier.startsWith('@/') && context.parentURL) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context)
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

const routeUrl = './route.ts?item-accounting-audit-test'
const { PATCH } = (await import(routeUrl)) as typeof import('./route.ts')
hooks.deregister()

function reset(): void {
  routeState.item = structuredClone(originalItem)
  routeState.nextItem = structuredClone(originalItem)
  routeState.audits.length = 0
  routeState.calls.length = 0
  routeState.transactionOrgs.length = 0
  routeState.failAudit = false
  routeState.inTransaction = false
}

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/items/${ITEM_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'X-Request-Id': 'item-audit-test' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ITEM_ID }) },
  )
}

test('PATCH rolls the item mutation back when its audit insert fails', async () => {
  reset()
  routeState.failAudit = true
  routeState.nextItem = { ...routeState.item, default_rate: '125.0000' }
  const before = structuredClone(routeState.item)

  await assert.rejects(() => patch({ defaultRate: '125', reason: 'corrected rate' }), /audit writer unavailable/)

  assert.deepEqual(routeState.item, before, 'the failed audit rolled the accounting mutation back')
  assert.equal(routeState.audits.length, 0, 'the failed audit did not leave an audit row')
  assert.deepEqual(routeState.transactionOrgs, [ORG_ID], 'the write used one tenant-pinned transaction')
})

test('PATCH commits a locked before/after accounting snapshot with actor and reason', async () => {
  reset()
  routeState.nextItem = {
    ...routeState.item,
    default_rate: '125.0000',
    default_cost: '45.0000',
    income_account_id: EXPENSE_ID,
    expense_account_id: INCOME_ID,
    name: 'Updated consulting',
    updated_at: '2026-08-28T12:01:00.000Z',
    updated_by: ACTOR_ID,
  }

  const response = await patch({
    name: 'Updated consulting',
    defaultRate: '125',
    defaultCost: '45',
    incomeAccountId: EXPENSE_ID,
    expenseAccountId: INCOME_ID,
    reason: 'annual pricing review',
  })

  assert.equal(response.status, 200)
  assert.equal(routeState.audits.length, 1)
  const audit = routeState.audits[0]!
  const changes = audit.changes
  assert.deepEqual(changes.before, {
    kind: originalItem.kind,
    code: originalItem.code,
    name: originalItem.name,
    description: originalItem.description,
    category: originalItem.category,
    unit: originalItem.unit,
    default_rate: originalItem.default_rate,
    default_cost: originalItem.default_cost,
    income_account_id: originalItem.income_account_id,
    expense_account_id: originalItem.expense_account_id,
    cost_recovery_account_id: null,
    tax_code_id: null,
    show_on_timesheet: false,
    recognition_rule_id: null,
    deferred_account_id: null,
    create_plans_on: 'billing',
    revenue_allocation: 'normal',
    standalone_selling_price: null,
    is_active: true,
    custom: { department: 'advisory' },
    updated_at: originalItem.updated_at,
    updated_by: ACTOR_ID,
  })
  assert.equal((changes.after as ItemRow).default_rate, '125.0000')
  assert.equal((changes.after as ItemRow).default_cost, '45.0000')
  assert.equal((changes.after as ItemRow).income_account_id, EXPENSE_ID)
  assert.equal((changes.after as ItemRow).expense_account_id, INCOME_ID)
  assert.equal((changes.after as ItemRow).name, 'Updated consulting')
  assert.equal(changes.reason, 'annual pricing review')
  assert.equal(audit.actorId, ACTOR_ID, 'the authenticated actor is attached to the audit row')
  assert.match(audit.at, /^\d{4}-\d{2}-\d{2}T/, 'the audit row has a commit timestamp')
  assert.equal(routeState.item.default_rate, '125.0000')
  assert.equal(routeState.item.default_cost, '45.0000')
  assert.equal(routeState.calls[0]?.inTransaction, true)
  assert.match(routeState.calls[0]?.text ?? '', /for update/)
  assert.ok(routeState.calls.every((call) => call.inTransaction), 'lock, references, write, and audit shared the transaction')
  const updateIndex = routeState.calls.findIndex((call) => call.text.includes('update items set'))
  const auditIndex = routeState.calls.findIndex((call) => call.text.includes('insert into audit_log'))
  assert.ok(updateIndex >= 0 && auditIndex > updateIndex, 'the audit is written after the mutation inside the fence')
})
