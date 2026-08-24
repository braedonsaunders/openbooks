import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import ExcelJS from 'exceljs'

interface ImportRouteState {
  writes: Record<string, unknown>[][]
}

const stateKey = Symbol.for('openbooks.data-import-route-test')
const importState: ImportRouteState = { writes: [] }
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = importState

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
          throw new Error('database execution is not expected for a rejected preview')
        },
      }
    `,
  ],
  [
    'mock:authz',
    `
      export function can() {
        return true
      }

      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'actor-1' } }
      }
    `,
  ],
  [
    'mock:resources',
    `
      const state = globalThis[Symbol.for('openbooks.data-import-route-test')]
      const resource = {
        descriptor: {
          key: 'txn:card_charge',
          label: 'Card charge',
          supportsImport: true,
          writePermission: 'transactions.card_charge.create',
          canPost: false,
        },
        async fields() {
          return []
        },
        async write(rows) {
          state.writes.push(rows)
          return { created: rows.length, updated: 0, failed: 0, errors: [] }
        },
      }

      export async function getResource() {
        return resource
      }
    `,
  ],
  [
    'mock:parse',
    `
      export async function parseImportFile() {
        throw new Error('route parse mode is not expected in this preview test')
      }

      export function guessMapping() {
        return {}
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
      ['@/lib/api/json', 'mock:json'],
      ['drizzle-orm', 'mock:drizzle'],
      ['@openbooks/engine/src/db.ts', 'mock:db'],
      ['../../../../lib/authz', 'mock:authz'],
      ['../../../../lib/data-io/resources', 'mock:resources'],
      ['../../../../lib/data-io/parse', 'mock:parse'],
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

const routeUrl = '../../app/api/data/import/route.ts?duplicate-mapping-test'
const { POST } = await import(routeUrl) as typeof import('../../app/api/data/import/route.ts')
const parseUrl = './parse.ts?duplicate-mapping-route-test'
const { CELL_PROVENANCE_KEY, parseImportFile } = await import(parseUrl) as typeof import('./parse.ts')
hooks.deregister()

async function parsedFormulaRow(kind: 'amount' | 'lines'): Promise<Record<string, unknown>> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Transactions')
  if (kind === 'amount') {
    sheet.addRow(['documentDate', 'account', 'literal_amount', 'formula_amount'])
    sheet.addRow([
      '2026-08-24',
      '5000',
      '999999999999998.9900',
      {
        formula: 'TEXT(999999999999998.99,"0.0000")',
        result: '999999999999999.0000',
      },
    ])
  } else {
    const lines = '[{"account":"5000","amount":"999999999999998.9900"}]'
    sheet.addRow(['documentDate', 'literal_lines', 'formula_lines'])
    sheet.addRow(['2026-08-24', lines, { formula: 'A1', result: lines }])
  }
  const buffer = await workbook.xlsx.writeBuffer()
  const parsed = await parseImportFile('xlsx', {
    base64: Buffer.from(buffer as ArrayBuffer).toString('base64'),
  })
  const row = parsed.rows[0]
  assert.ok(row)
  return row
}

async function preview(
  rows: Record<string, unknown>[],
  mapping: Record<string, string>,
): Promise<Response> {
  return POST(new Request('http://openbooks.test/api/data/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'preview',
      resource: 'txn:card_charge',
      format: 'xlsx',
      rows,
      mapping,
      importMode: 'insert',
    }),
  }))
}

test('route rejects duplicate amount mappings before a formula value can outrun its provenance', async () => {
  importState.writes.length = 0
  const row = await parsedFormulaRow('amount')
  assert.deepEqual(row[CELL_PROVENANCE_KEY], { formula_amount: 'formula' })

  const response = await preview([row], {
    documentDate: 'documentDate',
    account: 'account',
    literal_amount: 'amount',
    formula_amount: 'amount',
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'multiple source columns map to the same target field',
    field: 'amount',
    sources: ['literal_amount', 'formula_amount'],
  })
  assert.equal(importState.writes.length, 0)
})

test('route rejects duplicate nested-lines mappings before a formula value can outrun its provenance', async () => {
  importState.writes.length = 0
  const row = await parsedFormulaRow('lines')
  assert.deepEqual(row[CELL_PROVENANCE_KEY], { formula_lines: 'formula' })

  const response = await preview([row], {
    documentDate: 'documentDate',
    literal_lines: 'lines',
    formula_lines: 'lines',
  })

  assert.equal(response.status, 400)
  assert.deepEqual(await response.json(), {
    error: 'multiple source columns map to the same target field',
    field: 'lines',
    sources: ['literal_lines', 'formula_lines'],
  })
  assert.equal(importState.writes.length, 0)
})
