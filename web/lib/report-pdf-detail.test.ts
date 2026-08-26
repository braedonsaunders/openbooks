import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { generalLedgerExportData, isExactDecimalText, pdfMoney } from './report-pdf-detail.ts'

// `report-pdf` is server-only in production. This suite runs it directly so
// the shared CSV/XLSX boundary is covered without weakening that production
// guard.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export {}', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const { exportDataToCsv, exportDataToRunResult, exportDataToXlsx } = await import('./report-pdf.ts')

const t = (key: string) => key

test('general-ledger export mirrors the paper view with one section per account', () => {
  const data = generalLedgerExportData({
    from: '2026-01-01',
    to: '2026-01-31',
    truncated: false,
    accounts: [{
      id: 'account-1',
      number: '5210',
      name: 'Overhead Allowance',
      type: 'cogs',
      opening: '0.0000',
      closing: '125.0000',
      lines: [{
        entryId: 'entry-1',
        entryNumber: 'JE-100',
        date: '2026-01-31',
        party: null,
        memo: 'Overhead applied',
        debit: '125.0000',
        credit: '0.0000',
        balance: '125.0000',
        docKind: null,
        docId: null,
      }],
    }],
  }, 'General Ledger', t)

  assert.equal(data.groups.length, 1)
  assert.equal(data.groups[0]?.kind, 'section')
  assert.equal(data.groups[0]?.title, '5210 Overhead Allowance')
  assert.deepEqual(data.groups[0]?.columns, [
    'generalLedger.columns.date',
    'generalLedger.columns.entry',
    'generalLedger.columns.detail',
    'trialBalance.columns.debits',
    'trialBalance.columns.credits',
    'export.columns.balance',
  ])
  assert.equal(data.groups[0]?.rows[1]?.[1], 'JE-100')
  assert.equal(data.groups[0]?.rows[1]?.[3], '125.0000')
})

test('general-ledger export preserves exact money strings and their column flags', () => {
  const data = generalLedgerExportData({
    from: '2026-01-01',
    to: '2026-01-31',
    truncated: false,
    accounts: [{
      id: 'account-1',
      number: '5210',
      name: 'Overhead Allowance',
      type: 'cogs',
      opening: '125.0000',
      closing: '9007199254740.9938',
      lines: [],
    }],
  }, 'General Ledger', t)

  assert.deepEqual(data.groups[0]?.money, [false, false, false, true, true, true])
  assert.equal(data.groups[0]?.rows[0]?.[5], '125.0000')
  assert.equal(data.groups[0]?.rows[1]?.[5], '9007199254740.9938')
})

async function generalLedgerAdapterValues(value: string): Promise<{
  csv: string
  runValue: string | number | null | undefined
  xlsxValue: ExcelJS.CellValue
}> {
  const data = generalLedgerExportData({
    from: '2026-01-01',
    to: '2026-01-31',
    truncated: false,
    accounts: [{
      id: 'account-1',
      number: '5210',
      name: 'Overhead Allowance',
      type: 'cogs',
      opening: value,
      closing: '0.0000',
      lines: [],
    }],
  }, 'General Ledger', t)

  const result = exportDataToRunResult(data)
  assert.deepEqual(result.groups[0]?.money, [false, false, false, true, true, true])

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await exportDataToXlsx(data, {
    reportName: 'General Ledger',
    generatedAt: new Date('2026-01-31T00:00:00Z'),
  }) as unknown as ArrayBuffer)

  return {
    csv: exportDataToCsv(data, {}),
    runValue: result.groups[0]?.rows[0]?.[5],
    xlsxValue: workbook.worksheets[0]?.getCell('F5').value ?? null,
  }
}

test('general-ledger CSV/XLSX adapters preserve exact money beyond 2^53', async () => {
  const exact = '9007199254740.9938'
  const values = await generalLedgerAdapterValues(exact)

  assert.equal(values.runValue, exact)
  assert.match(values.csv, /\r\n,,generalLedger\.opening,,,9007199254740\.9938\r\n/)
  assert.equal(values.xlsxValue, exact)
  assert.equal(typeof values.xlsxValue, 'string')
})

test('general-ledger CSV/XLSX adapters preserve a normal exact money value', async () => {
  const exact = '125.0000'
  const values = await generalLedgerAdapterValues(exact)

  assert.equal(values.runValue, exact)
  assert.match(values.csv, /\r\n,,generalLedger\.opening,,,125\.0000\r\n/)
  assert.equal(values.xlsxValue, exact)
  assert.equal(typeof values.xlsxValue, 'string')
})

test('pdfMoney prints exact ledger decimals IEEE-754 would corrupt', () => {
  // Past 2^53 (~15.95 significant digits) a Number() rounds cents away:
  // Number('9007199254740.9938') is already 9007199254740.994, and
  // Number('12345678901234567.8900') lands on ...568.00 — real money drift.
  assert.equal(pdfMoney('9007199254740.9938'), '9,007,199,254,740.99')
  assert.equal(pdfMoney('12345678901234567.8900'), '12,345,678,901,234,567.89')
})

test('pdfMoney rounds the exact value, not its double projection', () => {
  // Number('2.675') is really 2.67499999999999982…, which formats to "2.67";
  // the exact decimal string must half-round UP to "2.68".
  assert.equal(pdfMoney('2.675'), '2.68')
})

test('pdfMoney uses statement money conventions and locale separators', () => {
  assert.equal(pdfMoney('125'), '125.00')
  assert.equal(pdfMoney('-125.0000'), '-125.00')
  assert.equal(pdfMoney('-0.0000'), '0.00')
  assert.equal(pdfMoney('0'), '0.00')
  assert.equal(pdfMoney('0.005'), '0.01')
  assert.equal(pdfMoney('1234567.891', 'de'), '1.234.567,89')
})

test('pdfMoney renders non-numeric text raw instead of throwing', () => {
  assert.equal(pdfMoney('n/a'), 'n/a')
  assert.equal(pdfMoney('Acme GmbH'), 'Acme GmbH')
})

test('isExactDecimalText separates ledger decimals from prose and dates', () => {
  assert.equal(isExactDecimalText('125.0000'), true)
  assert.equal(isExactDecimalText('-12.5'), true)
  assert.equal(isExactDecimalText('+7'), true)
  assert.equal(isExactDecimalText(''), false)
  assert.equal(isExactDecimalText('2026-01-31'), false)
  assert.equal(isExactDecimalText('12.5%'), false)
  assert.equal(isExactDecimalText('JE-100'), false)
})
