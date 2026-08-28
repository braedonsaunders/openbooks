import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { statementSheetToXlsx } from './index'

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
