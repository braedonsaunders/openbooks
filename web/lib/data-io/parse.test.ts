import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import ExcelJS from 'exceljs'

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
  sheet.addRow(['numericAmount', 'formulaAmount', 'textAmount'])
  sheet.addRow([
    999999999999998.99,
    { formula: '999999999999998.99', result: 999999999999998.99 },
    '999999999999998.9900',
  ])
  const buffer = await workbook.xlsx.writeBuffer()
  return Buffer.from(buffer as ArrayBuffer).toString('base64')
}

test('XLSX parsing retains numeric, formula, and text cell provenance', async () => {
  const parsed = await parseImportFile('xlsx', { base64: await provenanceWorkbook() })

  assert.deepEqual(parsed.headers, ['numericAmount', 'formulaAmount', 'textAmount'])
  assert.equal(parsed.rows.length, 1)
  const row = parsed.rows[0]
  assert.ok(row)
  assert.equal(typeof row.numericAmount, 'number')
  assert.equal(row.numericAmount, 999999999999999)
  assert.equal(typeof row.formulaAmount, 'number')
  assert.equal(row.formulaAmount, 999999999999999)
  assert.equal(typeof row.textAmount, 'string')
  assert.equal(row.textAmount, '999999999999998.9900')
})
