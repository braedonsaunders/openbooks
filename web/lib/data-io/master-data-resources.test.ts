import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

interface MasterImportState {
  failAudit: boolean
  transactionCalls: number
  transactionRollbacks: number
  savepointsOpened: number
  savepointReleases: number
  savepointRollbacks: number
  attemptedMutations: string[]
  committedMutations: { table: string; id: string }[]
  scopedAccountOwnershipChecks: string[]
  scopedAccountLabelLookups: string[]
  auditInsertCalls: number
  readRows: Record<string, Record<string, unknown>[]>
  unscopedLabelLookups: number
}

const stateKey = Symbol.for('openbooks.master-data-import-test')
const importState: MasterImportState = {
  failAudit: false,
  transactionCalls: 0,
  transactionRollbacks: 0,
  savepointsOpened: 0,
  savepointReleases: 0,
  savepointRollbacks: 0,
  attemptedMutations: [],
  committedMutations: [],
  scopedAccountOwnershipChecks: [],
  scopedAccountLabelLookups: [],
  auditInsertCalls: 0,
  readRows: {},
  unscopedLabelLookups: 0,
}
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = importState

const mockSources = new Map<string, string>([
  [
    'mock:drizzle',
    `
      function render(value) {
        if (value === null || value === undefined) return ''
        if (typeof value === 'string') return value
        if (typeof value === 'number' || typeof value === 'boolean') return String(value)
        if (Array.isArray(value)) return value.map(render).join(', ')
        if (value.raw !== undefined) return String(value.raw)
        if (value.strings) return statementText(value)
        return String(value)
      }

      function statementText(query) {
        if (!Array.isArray(query?.strings)) return String(query)
        return query.strings.map((part, index) =>
          part + (index < query.values.length ? render(query.values[index]) : '')
        ).join('')
      }

      export function sql(strings, ...values) {
        return { strings, values }
      }

      sql.raw = (value) => ({ raw: String(value) })
      sql.join = (parts, separator) => ({ raw: parts.map(render).join(render(separator)) })
      export { statementText }
    `,
  ],
  [
    'mock:db',
    `
      const state = globalThis[Symbol.for('openbooks.master-data-import-test')]
      const ids = { accounts: 'account-1', items: 'item-1', parties: 'party-1' }

      function render(value) {
        if (value === null || value === undefined) return ''
        if (typeof value === 'string') return value
        if (typeof value === 'number' || typeof value === 'boolean') return String(value)
        if (Array.isArray(value)) return value.map(render).join(', ')
        if (value.raw !== undefined) return String(value.raw)
        if (value.strings) return statementText(value)
        return String(value)
      }

      function statementText(query) {
        if (!Array.isArray(query?.strings)) return String(query)
        return query.strings.map((part, index) =>
          part + (index < query.values.length ? render(query.values[index]) : '')
        ).join('')
      }

      function tableFromInsert(text) {
        return text.match(/insert\\s+into\\s+(accounts|items|parties)\\b/i)?.[1]?.toLowerCase() ?? null
      }

      function tableFromRead(text) {
        return text.match(/from\\s+(accounts|items|parties)\\b/i)?.[1]?.toLowerCase() ?? null
      }

      function mutationFromInsert(text, pending) {
        const table = tableFromInsert(text)
        if (!table) throw new Error('unexpected mutation statement: ' + text)
        const id = ids[table]
        const mutation = { table, id }
        state.attemptedMutations.push(table)
        if (pending) pending.push(mutation)
        else state.committedMutations.push(mutation)
        return { rows: [{ id }] }
      }

      function execute(query, pending = null) {
        const text = statementText(query)
        const insertedTable = tableFromInsert(text)
        if (insertedTable === 'accounts' || insertedTable === 'items' || insertedTable === 'parties') {
          return mutationFromInsert(text, pending)
        }
        if (/select\\s+id\\s+from\\s+accounts\\s+where\\s+id\\s*=.*and\\s+org_id\\s*=/i.test(text)) {
          const id = String(query.values?.[0] ?? '')
          state.scopedAccountOwnershipChecks.push(text)
          return { rows: [] }
        }
        if (/select\\s+number\\s+as\\s+label\\s+from\\s+accounts\\s+where\\s+id\\s*=.*and\\s+org_id\\s*=/i.test(text)) {
          state.scopedAccountLabelLookups.push(text)
          return { rows: [] }
        }
        const table = tableFromRead(text)
        if (table) return { rows: state.readRows[table] ?? [] }
        return { rows: [] }
      }

      export const db = {
        async execute(query) {
          const text = statementText(query)
          if (/insert\\s+into\\s+audit_log\\b/i.test(text)) {
            state.auditInsertCalls++
            if (state.failAudit) throw new Error('forced audit insert failure')
            return { rows: [] }
          }
          return execute(query)
        },
        async transaction(callback) {
          state.transactionCalls++
          const pending = []
          try {
            const result = await callback({
              async execute(query) {
                const text = statementText(query)
                if (/^\\s*savepoint\\s/i.test(text)) state.savepointsOpened++
                if (/^\\s*release\\s+savepoint\\s/i.test(text)) state.savepointReleases++
                if (/^\\s*rollback\\s+to\\s+savepoint\\s/i.test(text)) state.savepointRollbacks++
                if (/insert\\s+into\\s+audit_log\\b/i.test(text)) {
                  state.auditInsertCalls++
                  if (state.failAudit) throw new Error('forced audit insert failure')
                  return { rows: [] }
                }
                return execute(query, pending)
              },
            })
            state.committedMutations.push(...pending)
            return result
          } catch (error) {
            state.transactionRollbacks++
            pending.length = 0
            throw error
          }
        },
      }
    `,
  ],
  [
    'mock:registry',
    `
      export function toSnake(value) {
        return String(value).replace(/[A-Z]/g, (match) => '_' + match.toLowerCase())
      }
    `,
  ],
  [
    'mock:coerce',
    `
      export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
      export function coerceBoolean(value) {
        return value === true || value === 1 || String(value).toLowerCase() === 'true'
      }
    `,
  ],
  [
    'mock:custom-fields',
    `
      export async function loadFieldDefs() {
        return []
      }

      export function validateCustomValues() {
        return { ok: true, cleaned: {} }
      }
    `,
  ],
  [
    'mock:resource-core',
    `
      const state = globalThis[Symbol.for('openbooks.master-data-import-test')]
      export const MAX_EXPORT_ROWS = 50_000

      export async function orgFeatureEnabled() {
        return true
      }

      export class RefResolver {
        async resolveId(target, human) {
          const value = String(human ?? '').trim()
          if (target.resource === 'accounts' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
            return value
          }
          return null
        }

        async resolveLabel(target, id) {
          if (target.resource === 'accounts') {
            state.unscopedLabelLookups++
            throw new Error('unscoped account label lookup')
          }
          return String(id)
        }
      }

      export async function exportCell(field, value, resolver) {
        if (value === null || value === undefined) return null
        if (field.kind === 'reference' && field.ref) return resolver.resolveLabel(field.ref, value)
        if (field.kind === 'boolean') return Boolean(value)
        return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
          ? value
          : JSON.stringify(value)
      }
    `,
  ],
])

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export {}', format: 'module', shortCircuit: true }
    }
    const mockUrl = new Map([
      ['drizzle-orm', 'mock:drizzle'],
      ['@openbooks/engine/src/db.ts', 'mock:db'],
      ['../setup/registry', 'mock:registry'],
      ['../setup/coerce', 'mock:coerce'],
      ['../custom-fields', 'mock:custom-fields'],
      ['./resource-core', 'mock:resource-core'],
    ]).get(specifier)
    if (mockUrl) return { url: mockUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url)
    if (source !== undefined) return { format: 'module', source, shortCircuit: true }
    return nextLoad(url, context)
  },
})

const resourceUrl = './master-data-resources.ts?master-data-behavior-test'
const { MASTER_BY_KEY, masterResource } = await import(resourceUrl) as typeof import('./master-data-resources.ts')
hooks.deregister()

function resetImportState(failAudit: boolean): void {
  importState.failAudit = failAudit
  importState.transactionCalls = 0
  importState.transactionRollbacks = 0
  importState.savepointsOpened = 0
  importState.savepointReleases = 0
  importState.savepointRollbacks = 0
  importState.attemptedMutations.length = 0
  importState.committedMutations.length = 0
  importState.scopedAccountOwnershipChecks.length = 0
  importState.scopedAccountLabelLookups.length = 0
  importState.auditInsertCalls = 0
  importState.readRows = {}
  importState.unscopedLabelLookups = 0
}

const writeContext = { orgId: 'org-1', actorId: 'actor-1', dryRun: false }

function resource(key: 'accounts' | 'items' | 'parties') {
  const entity = MASTER_BY_KEY.get(key)
  assert.ok(entity)
  return masterResource(entity, writeContext.orgId)
}

const rowsByResource = {
  accounts: { number: '1000', name: 'Cash', type: 'asset_bank' },
  items: { code: 'SKU-1', name: 'Widget', kind: 'service' },
  parties: { shortCode: 'CUS-1', displayName: 'Customer', kind: 'company' },
} as const

test('master-data mutations roll back when their audit insert fails', async () => {
  resetImportState(true)

  for (const key of ['accounts', 'items', 'parties'] as const) {
    const outcome = await resource(key).write([rowsByResource[key]], 'insert', writeContext)
    assert.deepEqual(outcome, {
      created: 0,
      updated: 0,
      failed: 1,
      errors: [{ row: 1, message: 'forced audit insert failure' }],
    })
  }

  assert.deepEqual(importState.attemptedMutations, ['accounts', 'items', 'parties'])
  assert.deepEqual(importState.committedMutations, [])
  assert.equal(importState.transactionCalls, 3)
  assert.equal(importState.transactionRollbacks, 3)
  assert.equal(importState.auditInsertCalls, 3)
  assert.equal(importState.savepointsOpened, 3)
  assert.equal(importState.savepointRollbacks, 3)
  assert.equal(importState.savepointReleases, 3)
})

test('master-data mutations commit with their audit evidence on the happy path', async () => {
  resetImportState(false)

  for (const key of ['accounts', 'items', 'parties'] as const) {
    const outcome = await resource(key).write([rowsByResource[key]], 'insert', writeContext)
    assert.deepEqual(outcome, { created: 1, updated: 0, failed: 0, errors: [] })
  }

  assert.deepEqual(importState.committedMutations, [
    { table: 'accounts', id: 'account-1' },
    { table: 'items', id: 'item-1' },
    { table: 'parties', id: 'party-1' },
  ])
  assert.equal(importState.transactionRollbacks, 0)
  assert.equal(importState.auditInsertCalls, 3)
})

test('account UUID references from another organization are rejected before writes', async () => {
  resetImportState(false)
  const foreignAccountId = '11111111-1111-4111-8111-111111111111'

  const outcome = await resource('items').write([
    {
      code: 'SKU-FOREIGN',
      name: 'Foreign account item',
      kind: 'service',
      incomeAccount: foreignAccountId,
    },
  ], 'insert', writeContext)

  assert.deepEqual(outcome, {
    created: 0,
    updated: 0,
    failed: 1,
    errors: [{ row: 1, message: `incomeAccount: "${foreignAccountId}" not found` }],
  })
  assert.equal(importState.scopedAccountOwnershipChecks.length, 1)
  assert.match(importState.scopedAccountOwnershipChecks[0]!, /org_id\s*=/i)
  assert.deepEqual(importState.attemptedMutations, [])
  assert.deepEqual(importState.committedMutations, [])
  assert.equal(importState.transactionCalls, 0)
})

test('master-data exports do not resolve account labels through an unscoped lookup', async () => {
  resetImportState(false)
  const foreignAccountId = '22222222-2222-4222-8222-222222222222'
  importState.readRows.items = [{
    code: 'SKU-FOREIGN',
    name: 'Legacy item',
    kind: 'service',
    category: null,
    income_account_id: foreignAccountId,
    expense_account_id: null,
    default_rate: null,
    unit: null,
    tax_code_id: null,
    show_on_timesheet: false,
    is_active: true,
    custom: {},
  }]

  const result = await resource('items').read()

  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0]?.incomeAccount, foreignAccountId)
  assert.equal(importState.unscopedLabelLookups, 0)
  assert.equal(importState.scopedAccountLabelLookups.length, 1)
  assert.match(importState.scopedAccountLabelLookups[0]!, /org_id\s*=/i)
})
