import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { DOC_KINDS } from '../document-kinds.ts'

interface TransactionImportState {
  failLineInsert: boolean
  transactionCalls: number
  rootInsertCalls: number
  transactionInsertTargets: string[]
  rollbacks: number
  documents: Record<string, unknown>[]
  lines: Record<string, unknown>[]
  attemptedLines: Record<string, unknown>[]
}

const stateKey = Symbol.for('openbooks.transaction-import-test')
const importState: TransactionImportState = {
  failLineInsert: false,
  transactionCalls: 0,
  rootInsertCalls: 0,
  transactionInsertTargets: [],
  rollbacks: 0,
  documents: [],
  lines: [],
  attemptedLines: [],
}
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
      const state = globalThis[Symbol.for('openbooks.transaction-import-test')]
      const documentId = 'document-1'

      export const schema = {
        documents: Symbol.for('openbooks.transaction-import-test.documents'),
        documentLines: Symbol.for('openbooks.transaction-import-test.document-lines'),
      }

      function insertTargetName(target) {
        if (target === schema.documents) return 'documents'
        if (target === schema.documentLines) return 'documentLines'
        throw new Error('unexpected insert target')
      }

      function insertInto(target, pending) {
        return {
          values(values) {
            if (target === schema.documents) {
              return {
                async returning() {
                  pending.documents.push({ ...values, id: documentId })
                  return [{ id: documentId }]
                },
              }
            }
            if (target === schema.documentLines) {
              return Promise.resolve().then(() => {
                const lines = Array.isArray(values) ? values : [values]
                state.attemptedLines.push(...lines)
                if (state.failLineInsert) {
                  throw new Error('forced document line insert failure')
                }
                pending.lines.push(...lines)
              })
            }
            throw new Error('unexpected insert target')
          },
        }
      }

      export const db = {
        async execute() {
          return { rows: [{ base_currency: 'CAD' }] }
        },
        insert(target) {
          state.rootInsertCalls++
          return insertInto(target, state)
        },
        async transaction(callback) {
          state.transactionCalls++
          const pending = { documents: [], lines: [] }
          try {
            const result = await callback({
              insert(target) {
                state.transactionInsertTargets.push(insertTargetName(target))
                return insertInto(target, pending)
              },
            })
            state.documents.push(...pending.documents)
            state.lines.push(...pending.lines)
            return result
          } catch (error) {
            state.rollbacks++
            throw error
          }
        },
      }
    `,
  ],
  [
    'mock:posting',
    `
      export async function postDocument() {
        throw new Error('postDocument is not expected in this test')
      }
    `,
  ],
  [
    'mock:documents',
    `
      export async function controlDeps() {
        throw new Error('controlDeps is not expected in this test')
      }

      export async function nextDocumentNumber() {
        return 'CC-000001'
      }
    `,
  ],
  [
    'mock:resource-core',
    `
      export const MAX_EXPORT_ROWS = 50_000

      export async function orgFeatureEnabled() {
        return false
      }

      export class RefResolver {
        async resolveId(target, human) {
          if (target.resource === 'accounts' && String(human) === '5000') {
            return 'account-1'
          }
          return null
        }
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
      ['@openbooks/engine/src/posting.ts', 'mock:posting'],
      ['../documents', 'mock:documents'],
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

const resourceUrl = './transaction-resources.ts?atomic-import-test'
const { transactionResource } = await import(resourceUrl) as typeof import('./transaction-resources.ts')
const parseUrl = './parse.ts?transaction-xlsx-provenance-test'
const { CELL_PROVENANCE_KEY, parseImportFile } = await import(parseUrl) as typeof import('./parse.ts')
hooks.deregister()

function resetImportState(failLineInsert: boolean): void {
  importState.failLineInsert = failLineInsert
  importState.transactionCalls = 0
  importState.rootInsertCalls = 0
  importState.transactionInsertTargets.length = 0
  importState.rollbacks = 0
  importState.documents.length = 0
  importState.lines.length = 0
  importState.attemptedLines.length = 0
}

async function importCardCharge(
  row: Record<string, unknown> = {
    documentDate: '2026-08-24',
    account: '5000',
    amount: '999999999999999.1234',
  },
) {
  const cfg = DOC_KINDS.card_charge
  assert.ok(cfg)
  return transactionResource(cfg, 'org-1').write(
    [row],
    'insert',
    { orgId: 'org-1', actorId: 'actor-1', dryRun: false },
  )
}

async function xlsxTransactionRows(): Promise<Record<string, unknown>[]> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Transactions')
  const nestedLines = '[{"account":"5000","amount":"999999999999998.9900"}]'
  sheet.addRow(['documentDate', 'account', 'amount', 'debit', 'credit', 'lines'])
  sheet.addRow(['2026-08-24', '5000', 999999999999998.99, '', '', ''])
  sheet.addRow([
    '2026-08-24',
    '5000',
    { formula: '999999999999998.99', result: 999999999999998.99 },
    '',
    '',
    '',
  ])
  sheet.addRow(['2026-08-24', '5000', '999999999999998.9900', '', '', ''])
  sheet.addRow([
    '2026-08-24',
    '5000',
    {
      formula: 'TEXT(999999999999998.99,"0.0000")',
      result: '999999999999999.0000',
    },
    '',
    '',
    '',
  ])
  sheet.addRow([
    '2026-08-24',
    '5000',
    '',
    {
      formula: 'TEXT(999999999999998.99,"0.0000")',
      result: '999999999999999.0000',
    },
    { sharedFormula: 'D6', result: '999999999999999.0000' },
    '',
  ])
  sheet.addRow(['2026-08-24', '', '', '', '', { formula: 'A1', result: nestedLines }])
  sheet.addRow(['2026-08-24', '', '', '', '', { sharedFormula: 'F7', result: nestedLines }])
  const buffer = await workbook.xlsx.writeBuffer()
  return (
    await parseImportFile('xlsx', {
      base64: Buffer.from(buffer as ArrayBuffer).toString('base64'),
    })
  ).rows
}

function mappedTransactionRow(
  row: Record<string, unknown>,
  source: 'amount' | 'debit' | 'credit' | 'lines',
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    documentDate: row.documentDate,
    account: row.account,
    __sourceColumns: {},
  }
  const sources = out.__sourceColumns as Record<string, string>
  if (source === 'lines') {
    out.lines = row.lines
    sources.lines = 'lines'
  } else {
    out.amount = row[source]
    sources.amount = source
  }
  const provenance = row[CELL_PROVENANCE_KEY]
  if (provenance !== undefined) {
    out.__unmappedColumns = { [CELL_PROVENANCE_KEY]: provenance }
  }
  return out
}

test('transaction import rolls back its draft when line persistence fails', async () => {
  resetImportState(true)

  const outcome = await importCardCharge()

  assert.deepEqual(outcome, {
    created: 0,
    updated: 0,
    failed: 1,
    errors: [{ row: 1, message: 'forced document line insert failure' }],
  })
  assert.equal(importState.transactionCalls, 1)
  assert.equal(importState.rootInsertCalls, 0)
  assert.deepEqual(
    importState.transactionInsertTargets,
    ['documents', 'documentLines'],
  )
  assert.equal(importState.rollbacks, 1)
  assert.equal(importState.attemptedLines[0]?.amount, '999999999999999.1234')
  assert.deepEqual(
    importState.documents,
    [],
    'the failed row must not leave an orphan draft',
  )
  assert.deepEqual(importState.lines, [])
})

test('transaction import commits its draft and lines together', async () => {
  resetImportState(false)

  const outcome = await importCardCharge()

  assert.deepEqual(outcome, { created: 1, updated: 0, failed: 0, errors: [] })
  assert.equal(importState.transactionCalls, 1)
  assert.equal(importState.rootInsertCalls, 0)
  assert.deepEqual(
    importState.transactionInsertTargets,
    ['documents', 'documentLines'],
  )
  assert.equal(importState.rollbacks, 0)
  assert.deepEqual(importState.documents, [
    {
      orgId: 'org-1',
      kind: 'card_charge',
      documentNumber: 'CC-000001',
      partyId: null,
      documentDate: '2026-08-24',
      dueDate: null,
      currency: 'CAD',
      referenceNumber: null,
      memo: null,
      status: 'draft',
      createdBy: 'actor-1',
      id: 'document-1',
    },
  ])
  assert.deepEqual(importState.lines, [
    {
      orgId: 'org-1',
      documentId: 'document-1',
      lineNumber: 1,
      accountId: 'account-1',
      description: null,
      amount: '999999999999999.1234',
      taxCodeId: null,
      createdBy: 'actor-1',
    },
  ])
})

test('transaction import rejects an unquoted JSON amount before writing', async () => {
  resetImportState(false)
  const lines = '[{"account":"5000","amount":999999999999998.99}]'

  const outcome = await importCardCharge({
    documentDate: '2026-08-24',
    lines,
  })

  assert.equal(JSON.parse(lines)[0].amount, 999999999999999)
  assert.deepEqual(outcome, {
    created: 0,
    updated: 0,
    failed: 1,
    errors: [
      {
        row: 1,
        message:
          'line amount "999999999999999" must be an exact decimal string with at most 4 decimal places',
      },
    ],
  })
  assert.equal(importState.transactionCalls, 0)
  assert.equal(importState.rootInsertCalls, 0)
  assert.deepEqual(importState.transactionInsertTargets, [])
  assert.deepEqual(importState.attemptedLines, [])
  assert.deepEqual(importState.documents, [])
  assert.deepEqual(importState.lines, [])
})

test('transaction import preserves an exact decimal string inside JSON lines', async () => {
  resetImportState(false)

  const outcome = await importCardCharge({
    documentDate: '2026-08-24',
    lines: '[{"account":"5000","amount":"999999999999998.9900"}]',
  })

  assert.deepEqual(outcome, { created: 1, updated: 0, failed: 0, errors: [] })
  assert.equal(importState.transactionCalls, 1)
  assert.equal(importState.rootInsertCalls, 0)
  assert.equal(importState.attemptedLines[0]?.amount, '999999999999998.9900')
  assert.equal(importState.lines[0]?.amount, '999999999999998.9900')
})

test('transaction import preserves XLSX cell provenance at the write boundary', async (t) => {
  const [numericRow, numericFormulaRow, textRow, textFormulaRow, debitCreditFormulaRow, nestedFormulaRow, sharedNestedFormulaRow] =
    await xlsxTransactionRows()
  assert.ok(numericRow)
  assert.ok(numericFormulaRow)
  assert.ok(textRow)
  assert.ok(textFormulaRow)
  assert.ok(debitCreditFormulaRow)
  assert.ok(nestedFormulaRow)
  assert.ok(sharedNestedFormulaRow)

  await t.test('rejects a numeric amount before writing', async () => {
    resetImportState(false)

    const outcome = await importCardCharge(mappedTransactionRow(numericRow, 'amount'))

    assert.deepEqual(outcome, {
      created: 0,
      updated: 0,
      failed: 1,
      errors: [
        {
          row: 1,
          message:
            'line amount "999999999999999" must be an exact decimal string with at most 4 decimal places',
        },
      ],
    })
    assert.equal(importState.transactionCalls, 0)
    assert.deepEqual(importState.attemptedLines, [])
  })

  await t.test('rejects a numeric formula result before writing', async () => {
    resetImportState(false)

    const outcome = await importCardCharge(mappedTransactionRow(numericFormulaRow, 'amount'))

    assert.deepEqual(outcome, {
      created: 0,
      updated: 0,
      failed: 1,
      errors: [
        {
          row: 1,
          message: 'line amount cannot come from a spreadsheet formula; provide a literal decimal string',
        },
      ],
    })
    assert.equal(importState.transactionCalls, 0)
    assert.deepEqual(importState.attemptedLines, [])
  })

  await t.test('accepts an exact text amount without changing it', async () => {
    resetImportState(false)

    const outcome = await importCardCharge(mappedTransactionRow(textRow, 'amount'))

    assert.deepEqual(outcome, { created: 1, updated: 0, failed: 0, errors: [] })
    assert.equal(importState.transactionCalls, 1)
    assert.equal(importState.attemptedLines[0]?.amount, '999999999999998.9900')
    assert.equal(importState.lines[0]?.amount, '999999999999998.9900')
  })

  await t.test('rejects a TEXT formula cached as a decimal string', async () => {
    resetImportState(false)

    const outcome = await importCardCharge(mappedTransactionRow(textFormulaRow, 'amount'))

    assert.deepEqual(outcome, {
      created: 0,
      updated: 0,
      failed: 1,
      errors: [
        {
          row: 1,
          message: 'line amount cannot come from a spreadsheet formula; provide a literal decimal string',
        },
      ],
    })
    assert.equal(importState.transactionCalls, 0)
    assert.deepEqual(importState.attemptedLines, [])
  })

  for (const source of ['debit', 'credit'] as const) {
    await t.test(`rejects a formula-derived ${source} mapped to amount`, async () => {
      resetImportState(false)

      const outcome = await importCardCharge(mappedTransactionRow(debitCreditFormulaRow, source))

      assert.equal(outcome.created, 0)
      assert.equal(outcome.failed, 1)
      assert.deepEqual(outcome.errors, [
        {
          row: 1,
          message: 'line amount cannot come from a spreadsheet formula; provide a literal decimal string',
        },
      ])
      assert.equal(importState.transactionCalls, 0)
      assert.deepEqual(importState.attemptedLines, [])
    })
  }

  for (const [name, row] of [
    ['formula-derived nested lines', nestedFormulaRow],
    ['shared-formula-derived nested lines', sharedNestedFormulaRow],
  ] as const) {
    await t.test(`rejects ${name}`, async () => {
      resetImportState(false)

      const outcome = await importCardCharge(mappedTransactionRow(row, 'lines'))

      assert.equal(outcome.created, 0)
      assert.equal(outcome.failed, 1)
      assert.deepEqual(outcome.errors, [
        {
          row: 1,
          message: 'lines cannot come from a spreadsheet formula; provide literal JSON text',
        },
      ])
      assert.equal(importState.transactionCalls, 0)
      assert.deepEqual(importState.attemptedLines, [])
    })
  }
})
