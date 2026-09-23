import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import ExcelJS from 'exceljs'
import { CELL_PROVENANCE_KEY } from './types.ts'

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'server-only') {
      return { url: 'data:text/javascript,export {}', format: 'module', shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
})

const parseUrl = './parse.ts?xlsx-cell-provenance-test'
const { parseImportFile } = await import(parseUrl) as typeof import('./parse.ts')
hooks.deregister()

async function provenanceWorkbook(): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Transactions')
  sheet.addRow([
    'numericAmount',
    'numericFormulaAmount',
    'textFormulaAmount',
    'sharedTextFormulaAmount',
    'textAmount',
  ])
  sheet.addRow([
    999999999999998.99,
    { formula: '999999999999998.99', result: 999999999999998.99 },
    {
      formula: 'TEXT(999999999999998.99,"0.0000")',
      result: '999999999999999.0000',
    },
    { sharedFormula: 'C2', result: '999999999999999.0000' },
    '999999999999998.9900',
  ])
  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer as ArrayBuffer).toString('base64')
}

async function arrayFormulaWorkbook(): Promise<string> {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Transactions')
  sheet.getCell('A1').value = 'amount'
  const fillFormula = sheet.fillFormula.bind(sheet) as unknown as (
    range: string,
    formula: string,
    results: Array<string | number>,
    shareType: 'array',
  ) => void
  fillFormula(
    'A2:A4',
    'TEXT(999999999999998.99,"0.0000")',
    [1, 999999999999998.99, '999999999999999.0000'],
    'array',
  )
  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer as ArrayBuffer).toString('base64')
}

test('XLSX parsing retains numeric, formula, and text cell provenance', async () => {
  const parsed = await parseImportFile('xlsx', { base64: await provenanceWorkbook() })

  assert.deepEqual(parsed.headers, [
    'numericAmount',
    'numericFormulaAmount',
    'textFormulaAmount',
    'sharedTextFormulaAmount',
    'textAmount',
  ])
  assert.equal(parsed.rows.length, 1)
  const row = parsed.rows[0]
  assert.ok(row)
  assert.equal(typeof row.numericAmount, 'number')
  assert.equal(row.numericAmount, 999999999999999)
  assert.equal(typeof row.numericFormulaAmount, 'number')
  assert.equal(row.numericFormulaAmount, 999999999999999)
  assert.equal(typeof row.textFormulaAmount, 'string')
  assert.equal(row.textFormulaAmount, '999999999999999.0000')
  assert.equal(typeof row.sharedTextFormulaAmount, 'string')
  assert.equal(row.sharedTextFormulaAmount, '999999999999999.0000')
  assert.equal(typeof row.textAmount, 'string')
  assert.equal(row.textAmount, '999999999999998.9900')
  assert.deepEqual(row[CELL_PROVENANCE_KEY], {
    numericFormulaAmount: 'formula',
    textFormulaAmount: 'formula',
    sharedTextFormulaAmount: 'formula',
  })
})

test('CSV parsing refuses duplicate headers instead of silently dropping a column', async () => {
  // Two "amount" columns collapse to one key downstream, so the first
  // column's money would vanish without a trace. Fail closed at the boundary.
  await assert.rejects(
    () => parseImportFile('csv', { text: 'documentDate,amount,amount\n2026-01-01,100,200\n' }),
    /duplicate.*amount/i,
  )
})

test('CSV parsing treats trim-equal headers as duplicates', async () => {
  await assert.rejects(
    () => parseImportFile('csv', { text: 'amount, amount \n1,2\n' }),
    /duplicate/i,
  )
})

test('XLSX parsing refuses duplicate headers', async () => {
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('Transactions')
  sheet.addRow(['documentDate', 'amount', 'amount'])
  sheet.addRow(['2026-01-01', 100, 200])
  const buffer = await workbook.xlsx.writeBuffer()
  await assert.rejects(
    () => parseImportFile('xlsx', { base64: Buffer.from(buffer as ArrayBuffer).toString('base64') }),
    /duplicate.*amount/i,
  )
})

test('CSV parsing reports truncation instead of silently dropping rows past the cap', async () => {
  const lines = ['documentDate,amount']
  for (let i = 0; i < 20_001; i++) lines.push(`2026-01-${String((i % 28) + 1).padStart(2, '0')},${i}`)
  const parsed = await parseImportFile('csv', { text: lines.join('\n') })
  assert.equal(parsed.rows.length, 20_000)
  assert.equal(parsed.truncated, true)
})

test('CSV parsing marks small files as complete', async () => {
  const parsed = await parseImportFile('csv', { text: 'documentDate,amount\n2026-01-01,100\n' })
  assert.equal(parsed.rows.length, 1)
  assert.equal(parsed.truncated, false)
})

test('JSON parsing refuses malformed input instead of returning an empty success', async () => {
  await assert.rejects(() => parseImportFile('json', { text: '{"a": 1,' }), /not valid JSON/)
  await assert.rejects(() => parseImportFile('json', { text: '' }), /not valid JSON/)
})

test('JSON parsing refuses non-object entries naming the first bad index', async () => {
  await assert.rejects(
    () => parseImportFile('json', { text: JSON.stringify([{ a: 1 }, null, { a: 3 }]) }),
    /entry 2 is not an object/,
  )
  await assert.rejects(
    () => parseImportFile('json', { text: JSON.stringify([{ a: 1 }, [1, 2]]) }),
    /entry 2 is not an object/,
  )
  await assert.rejects(() => parseImportFile('json', { text: '"just a string"' }), /entry 1 is not an object/)
  await assert.rejects(() => parseImportFile('json', { text: '42' }), /entry 1 is not an object/)
})

test('JSON parsing still accepts an object and an array of objects', async () => {
  const single = await parseImportFile('json', { text: JSON.stringify({ a: 1, b: 'x' }) })
  assert.deepEqual(single.headers, ['a', 'b'])
  assert.equal(single.rows.length, 1)
  const many = await parseImportFile('json', { text: JSON.stringify([{ a: 1 }, { a: 2, c: 3 }]) })
  assert.deepEqual(many.headers, ['a', 'c'])
  assert.equal(many.rows.length, 2)
  assert.equal(many.truncated, false)
})

test('XLSX parsing retains array-formula child provenance for numeric and string results', async () => {
  const parsed = await parseImportFile('xlsx', { base64: await arrayFormulaWorkbook() })

  assert.equal(parsed.rows.length, 3)
  const [master, numericChild, stringChild] = parsed.rows
  assert.ok(master)
  assert.ok(numericChild)
  assert.ok(stringChild)
  assert.equal(master.amount, 1)
  assert.equal(numericChild.amount, 999999999999999)
  assert.equal(stringChild.amount, '999999999999999.0000')
  for (const row of parsed.rows) {
    assert.deepEqual(row[CELL_PROVENANCE_KEY], { amount: 'formula' })
  }
})
