import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import ExcelJS from 'exceljs'
import type { FormSection } from '@openbooks/forms-core'

interface RecordImportState {
  searchData: Record<string, unknown> | null
}

const stateKey = Symbol.for('openbooks.record-import-test')
const importState: RecordImportState = { searchData: null }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = importState

const mockSources = new Map<string, string>([
  [
    'mock:drizzle',
    `
      export function sql(strings, ...values) {
        return { strings, values }
      }
    `,
  ],
  [
    'mock:db',
    `
      export const schema = {}
      export const db = {
        async execute() {
          throw new Error('database execution is not expected during this dry-run test')
        },
      }
    `,
  ],
  [
    'mock:records',
    `
      const state = globalThis[Symbol.for('openbooks.record-import-test')]

      export async function loadRecordTypeByKey() {
        return { id: 'record-type-1', status: 'published' }
      }

      export async function buildSearchText(_sections, data) {
        state.searchData = structuredClone(data)
        return 'record search text'
      }
    `,
  ],
  [
    'mock:resource-core',
    `
      export const MAX_EXPORT_ROWS = 50_000

      export class RefResolver {
        async resolveId() {
          throw new Error('reference resolution is not expected in this test')
        }
      }

      export async function exportCell(_field, value) {
        return value
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
      ['../records', 'mock:records'],
      ['./resource-core', 'mock:resource-core'],
    ]).get(specifier)
    if (mockUrl) return { url: mockUrl, shortCircuit: true }
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

const resourceUrl = './record-resources.ts?xlsx-field-aware-import-test'
const { recordResource } = await import(resourceUrl) as typeof import('./record-resources.ts')
const parseUrl = './parse.ts?record-xlsx-field-aware-import-test'
const { parseImportFile } = await import(parseUrl) as typeof import('./parse.ts')
hooks.deregister()

const sections: FormSection[] = [
  {
    id: 'identity',
    title: 'Identity',
    fields: [
      { id: 'external_id', label: 'External ID', type: 'text', required: true },
      { id: 'quantity', label: 'Quantity', type: 'number', required: true },
      { id: 'amount', label: 'Amount', type: 'currency', required: true },
    ],
  },
]

async function parsedWorkbookRow(): Promise<Record<string, unknown>> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Custom records')
  sheet.addRow(['external_id', 'quantity', 'amount'])
  sheet.addRow([123456, 7.5, 42.25])
  const buffer = await workbook.xlsx.writeBuffer()
  const parsed = await parseImportFile('xlsx', {
    base64: Buffer.from(buffer as ArrayBuffer).toString('base64'),
  })
  const row = parsed.rows[0]
  assert.ok(row)
  return row
}

test('custom-record XLSX import coerces only text fields to their display string', async () => {
  importState.searchData = null
  const row = await parsedWorkbookRow()
  assert.equal(typeof row.external_id, 'number')
  assert.equal(typeof row.quantity, 'number')
  assert.equal(typeof row.amount, 'number')

  const outcome = await recordResource('org-1', 'inventory-tag', sections, 'Inventory tag').write(
    [row],
    'insert',
    { orgId: 'org-1', actorId: 'actor-1', dryRun: true },
  )

  assert.deepEqual(outcome, { created: 1, updated: 0, failed: 0, errors: [] })
  const searchData = importState.searchData as Record<string, unknown> | null
  assert.ok(searchData)
  assert.deepEqual(searchData, {
    external_id: '123456',
    quantity: 7.5,
    amount: 42.25,
  })
  assert.equal(typeof searchData.external_id, 'string')
  assert.equal(typeof searchData.quantity, 'number')
  assert.equal(typeof searchData.amount, 'number')
})
