import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import {
  readSheet,
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
