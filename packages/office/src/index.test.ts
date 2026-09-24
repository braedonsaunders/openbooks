import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import {
  readSheet,
  reportResultToXlsx,
  SheetReadError,
  statementSheetToXlsx,
} from './index'

test('statement XLSX preserves the numeric(19,4) ledger maximum exactly', async () => {
  const ledgerMaximum = '999999999999999.9999'
  const buffer = await statementSheetToXlsx(
    {
      company: 'Example Company',
      title: 'Balance Sheet',
      periodPhrase: 'Year ended 2026-12-31',
      accountLabel: 'Account',
      columns: [{ label: 'Balance', kind: 'amount' }],
      rows: [{ kind: 'account', label: 'Ledger maximum', values: [ledgerMaximum] }],
    },
    { generatedAt: new Date('2026-08-28T12:00:00.000Z') },
  )

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
  const worksheet = workbook.worksheets[0]
  assert.ok(worksheet)

  // The data row follows the title, period, and header rows (row 6, column B).
  assert.equal(worksheet.getCell(6, 2).value, ledgerMaximum)
})

test('readSheet concatenates rich-text runs instead of importing them empty', async () => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Import')
  ws.getCell(1, 1).value = 'Name'
  ws.getCell(1, 2).value = 'Note'
  ws.getCell(2, 1).value = 'Widget'
  ws.getCell(2, 2).value = { richText: [{ text: 'Hello ' }, { text: 'World' }] }
  const buffer = await wb.xlsx.writeBuffer()
  const { headers, rows } = await readSheet(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer))
  assert.deepEqual(headers, ['Name', 'Note'])
  assert.deepEqual(rows, [['Widget', 'Hello World']])
})

test('readSheet refuses a spreadsheet error value naming its cell', async () => {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Import')
  ws.getCell(1, 1).value = 'Name'
  ws.getCell(1, 2).value = 'Qty'
  ws.getCell(2, 1).value = 'Widget'
  ws.getCell(2, 2).value = { error: '#DIV/0!' }
  const buffer = await wb.xlsx.writeBuffer()
  await assert.rejects(
    () => readSheet(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer)),
    (error: unknown) => {
      assert.ok(error instanceof SheetReadError)
      assert.match((error as Error).message, /B2/)
      assert.match((error as Error).message, /#DIV\/0!/)
      return true
    },
  )
})

test('report XLSX formats money as accounting but leaves counts and quantities alone', async () => {
  const buffer = await reportResultToXlsx(
    {
      groups: [
        {
          kind: 'results' as const,
          title: 'Recall',
          columns: ['Lots', 'Qty', 'Amount'],
          rows: [[3, 1.5, 19.99]],
          money: [false, false, true],
        },
      ],
      summary: [],
      rowCount: 1,
    },
    { reportName: 'Recall', generatedAt: new Date('2026-01-01T00:00:00Z') },
  )
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
  const ws = workbook.worksheets[0]!
  // Data row 5: the count stays a bare number with no forced format (Excel
  // shows General — never 3.00), the quantity keeps its natural precision,
  // the money column is accounting.
  assert.equal(ws.getCell(5, 1).value, 3)
  assert.equal(ws.getCell(5, 1).numFmt, undefined)
  assert.equal(ws.getCell(5, 2).value, 1.5)
  assert.equal(ws.getCell(5, 2).numFmt, undefined)
  assert.equal(ws.getCell(5, 3).value, 19.99)
  assert.equal(ws.getCell(5, 3).numFmt, '#,##0.00;(#,##0.00)')
})

test('statement XLSX keeps safely representable decimal strings numeric', async () => {
  const buffer = await statementSheetToXlsx(
    {
      company: 'Example Company',
      title: 'Balance Sheet',
      periodPhrase: 'Year ended 2026-12-31',
      accountLabel: 'Account',
      columns: [{ label: 'Balance', kind: 'amount' }],
      rows: [{ kind: 'account', label: 'Cash', values: ['1234.5000'] }],
    },
  )

  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer)
  const worksheet = workbook.worksheets[0]
  assert.ok(worksheet)
  assert.equal(worksheet.getCell(6, 2).value, 1234.5)
})
