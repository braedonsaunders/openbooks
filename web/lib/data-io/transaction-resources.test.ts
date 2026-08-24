import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { DOC_KINDS } from '../document-kinds.ts'
import {
  CELL_PROVENANCE_KEY,
  SOURCE_COLUMNS_KEY,
  UNMAPPED_COLUMNS_KEY,
} from './types.ts'

interface TransactionImportState {
  failLineInsert: boolean
  transactionCalls: number
  rootInsertCalls: number
  transactionInsertTargets: string[]
  rollbacks: number
  outOfTransactionInsertStatements: number
  strandedTransactionWrites: number
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
  outOfTransactionInsertStatements: 0,
  strandedTransactionWrites: 0,
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

      // Any INSERT routed through the root connection escapes the import's
      // transaction, no matter whether it goes through the query builder or
      // raw SQL — both are counted so the regression can fail on them.
      function isInsertStatement(query) {
        const text = Array.isArray(query?.strings) ? query.strings.join('') : String(query)
        return /\\binsert\\s+into\\b/i.test(text)
      }

      async function executeOnConnection(query, inTransaction) {
        if (!inTransaction && isInsertStatement(query)) {
          state.outOfTransactionInsertStatements++
        }
        return { rows: [{ base_currency: 'CAD' }] }
      }

      function insertInto(target, connection, pending) {
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
              // Settle on a macrotask the way real line I/O does: a write the
              // code under test never awaits cannot settle before its
              // transaction resolves and is reported as stranded.
              return new Promise((resolve, reject) => {
                setTimeout(() => {
                  connection.settle()
                  const lines = Array.isArray(values) ? values : [values]
                  state.attemptedLines.push(
                    ...lines.map((line) => ({
                      ...line,
                      via: connection.transactionId === null ? 'root' : 'transaction',
                      transactionId: connection.transactionId,
                    })),
                  )
                  if (state.failLineInsert) {
                    reject(new Error('forced document line insert failure'))
                    return
                  }
                  pending.lines.push(...lines)
                  resolve()
                }, 0)
              })
            }
            throw new Error('unexpected insert target')
          },
        }
      }

      export const db = {
        execute(query) {
          return executeOnConnection(query, false)
        },
        insert(target) {
          state.rootInsertCalls++
          return insertInto(target, { transactionId: null, settle() {} }, state)
        },
        async transaction(callback) {
          state.transactionCalls++
          const transactionId = 'txn-' + String(state.transactionCalls)
          const pending = { documents: [], lines: [] }
          let unsettledWrites = 0
          const connection = {
            transactionId,
            settle() {
              unsettledWrites--
            },
          }
          try {
            const result = await callback({
              execute(query) {
                return executeOnConnection(query, true)
              },
              insert(target) {
                state.transactionInsertTargets.push(insertTargetName(target))
                if (target === schema.documentLines) unsettledWrites++
                return insertInto(target, connection, pending)
              },
            })
            if (unsettledWrites > 0) state.strandedTransactionWrites += unsettledWrites
            state.documents.push(...pending.documents)
            state.lines.push(...pending.lines)
            return result
          } catch (error) {
            if (unsettledWrites > 0) state.strandedTransactionWrites += unsettledWrites
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
const { parseImportFile } = await import(parseUrl) as typeof import('./parse.ts')
hooks.deregister()

function resetImportState(failLineInsert: boolean): void {
  importState.failLineInsert = failLineInsert
  importState.transactionCalls = 0
  importState.rootInsertCalls = 0
  importState.transactionInsertTargets.length = 0
  importState.rollbacks = 0
  importState.outOfTransactionInsertStatements = 0
  importState.strandedTransactionWrites = 0
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

async function xlsxArrayFormulaRows(): Promise<Record<string, unknown>[]> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Transactions')
  const nestedLines = '[{"account":"5000","amount":"999999999999998.9900"}]'
  sheet.addRow(['documentDate', 'account', 'amount', 'debit', 'credit', 'lines'])
  for (let row = 2; row <= 8; row++) {
    sheet.getCell(row, 1).value = '2026-08-24'
    sheet.getCell(row, 2).value = '5000'
  }
  for (let row = 9; row <= 10; row++) sheet.getCell(row, 1).value = '2026-08-24'
  const fillFormula = sheet.fillFormula.bind(sheet) as unknown as (
    range: string,
    formula: string,
    results: Array<string | number>,
    shareType: 'array',
  ) => void
  fillFormula(
    'C2:C4',
    'TEXT(999999999999998.99,"0.0000")',
    [1, 999999999999998.99, '999999999999999.0000'],
    'array',
  )
  fillFormula(
    'D5:D6',
    'TEXT(999999999999998.99,"0.0000")',
    [1, '999999999999999.0000'],
    'array',
  )
  fillFormula(
    'E7:E8',
    'TEXT(999999999999998.99,"0.0000")',
    [1, 999999999999998.99],
    'array',
  )
  fillFormula('F9:F10', 'A1', [nestedLines, nestedLines], 'array')
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
    [SOURCE_COLUMNS_KEY]: {},
  }
  const sources = out[SOURCE_COLUMNS_KEY] as Record<string, string>
  if (source === 'lines') {
    out.lines = row.lines
    sources.lines = 'lines'
  } else {
    out.amount = row[source]
    sources.amount = source
  }
  const provenance = row[CELL_PROVENANCE_KEY]
  if (provenance !== undefined) {
    out[UNMAPPED_COLUMNS_KEY] = { [CELL_PROVENANCE_KEY]: provenance }
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
  // The line write itself must have been issued on the import's transaction
  // connection and settled inside it: no root-connection escape hatch (query
  // builder or raw SQL) and no fire-and-forget write may exist.
  assert.deepEqual(
    importState.attemptedLines.map((line) => [line.via, line.transactionId]),
    [['transaction', 'txn-1']],
  )
  assert.equal(importState.outOfTransactionInsertStatements, 0)
  assert.equal(importState.strandedTransactionWrites, 0)
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
  // The committed draft and its lines must come from one transaction
  // connection: every attempted line write carries that provenance, nothing
  // was inserted through the root connection (builder or raw SQL), and no
  // write was left unsettled when the transaction resolved.
  assert.deepEqual(
    importState.attemptedLines.map((line) => [line.via, line.transactionId]),
    [['transaction', 'txn-1']],
  )
  assert.equal(importState.outOfTransactionInsertStatements, 0)
  assert.equal(importState.strandedTransactionWrites, 0)
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

test('transaction import line amounts hold exact decimal values at the boundary', async (t) => {
  const rejectAmount = async (amount: unknown) => {
    resetImportState(false)

    const outcome = await importCardCharge({
      documentDate: '2026-08-24',
      account: '5000',
      amount,
    })

    assert.equal(outcome.created, 0)
    assert.equal(outcome.failed, 1)
    assert.deepEqual(outcome.errors, [
      {
        row: 1,
        message:
          'line amount "' +
          String(amount) +
          '" must be an exact decimal string with at most 4 decimal places',
      },
    ])
    assert.equal(importState.transactionCalls, 0)
    assert.deepEqual(importState.attemptedLines, [])
    assert.deepEqual(importState.lines, [])
  }

  await t.test('rejects a fifth decimal place instead of rounding it away', async () => {
    await rejectAmount('999999999999998.99001')
  })

  await t.test('rejects scientific-notation text', async () => {
    await rejectAmount('1e3')
  })

  await t.test('rejects non-numeric text', async () => {
    await rejectAmount('NaN')
  })

  await t.test('preserves a negative amount exactly', async () => {
    resetImportState(false)

    const outcome = await importCardCharge({
      documentDate: '2026-08-24',
      lines: '[{"account":"5000","amount":"-100.5"}]',
    })

    assert.deepEqual(outcome, { created: 1, updated: 0, failed: 0, errors: [] })
    assert.equal(importState.lines[0]?.amount, '-100.5000')
  })

  await t.test('stores zero as the canonical four-decimal zero', async () => {
    resetImportState(false)

    const outcome = await importCardCharge({
      documentDate: '2026-08-24',
      lines: '[{"account":"5000","amount":"-0"}]',
    })

    assert.deepEqual(outcome, { created: 1, updated: 0, failed: 0, errors: [] })
    assert.equal(importState.lines[0]?.amount, '0.0000')
  })

  await t.test('canonicalizes an explicit plus sign and leading zeros', async () => {
    resetImportState(false)

    const outcome = await importCardCharge({
      documentDate: '2026-08-24',
      lines: '[{"account":"5000","amount":"+0007.25"}]',
    })

    assert.deepEqual(outcome, { created: 1, updated: 0, failed: 0, errors: [] })
    assert.equal(importState.lines[0]?.amount, '7.2500')
  })
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

test('transaction import rejects XLSX array-formula child values before writing', async (t) => {
  const rows = await xlsxArrayFormulaRows()
  assert.equal(rows.length, 9)
  const cases = [
    {
      name: 'numeric amount child',
      row: rows[1],
      source: 'amount' as const,
      message: 'line amount cannot come from a spreadsheet formula; provide a literal decimal string',
    },
    {
      name: 'cached-string amount child',
      row: rows[2],
      source: 'amount' as const,
      message: 'line amount cannot come from a spreadsheet formula; provide a literal decimal string',
    },
    {
      name: 'cached-string debit child',
      row: rows[4],
      source: 'debit' as const,
      message: 'line amount cannot come from a spreadsheet formula; provide a literal decimal string',
    },
    {
      name: 'numeric credit child',
      row: rows[6],
      source: 'credit' as const,
      message: 'line amount cannot come from a spreadsheet formula; provide a literal decimal string',
    },
    {
      name: 'nested-lines cached-string child',
      row: rows[8],
      source: 'lines' as const,
      message: 'lines cannot come from a spreadsheet formula; provide literal JSON text',
    },
  ]

  for (const { name, row, source, message } of cases) {
    assert.ok(row)
    await t.test(`rejects ${name}`, async () => {
      resetImportState(false)

      const outcome = await importCardCharge(mappedTransactionRow(row, source))

      assert.equal(outcome.created, 0)
      assert.equal(outcome.failed, 1)
      assert.deepEqual(outcome.errors, [{ row: 1, message }])
      assert.equal(importState.transactionCalls, 0)
      assert.deepEqual(importState.attemptedLines, [])
    })
  }
})
