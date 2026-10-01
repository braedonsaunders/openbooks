import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import JSZip from 'jszip'
import { spawn } from 'node:child_process'
import { parseTransferRows } from './stream-parse'

async function* bytes(text: string, size = 1) {
  const source = Buffer.from(text)
  for (let i = 0; i < source.length; i += size) yield source.subarray(i, i + size)
}
async function records(format: 'csv' | 'json', text: string, size = 1) {
  const out = []
  for await (const record of parseTransferRows(format, bytes(text, size))) if (record.row) out.push(record.row)
  return out
}
test('CSV chunk boundaries preserve quoted newlines, doubled quotes and UTF-8', async () => {
  assert.deepEqual(await records('csv', '\uFEFFname,amount,memo\r\nÉlodie,999999999999998.99,"line one\nline ""two"""\r\n'), [
    { name: 'Élodie', amount: '999999999999998.99', memo: 'line one\nline "two"' },
  ])
  assert.deepEqual(await records('csv', 'code,amount\rFIRST,-12.00\r\rLAST,0.01\r', 1), [{ code: 'FIRST', amount: '-12.00' }, { code: 'LAST', amount: '0.01' }])
})
test('JSON rows retain source number tokens, nested amounts and unioned headers', async () => {
  const rows = await records('json', '[{"amount":999999999999998.99,"lines":[{"quantity":9007199254740993}]},{"name":"quoted } [ \\\""}]')
  assert.equal(rows[0]!.amount, '999999999999998.99')
  assert.deepEqual(rows[0]!.lines, [{ quantity: '9007199254740993' }])
  assert.equal(rows[1]!.name, 'quoted } [ "')
})
test('malformed records are refused rather than skipped or joined silently', async () => {
  for (const text of ['[{"a":1}{"a":2}]', '[,{"a":1}]', '[{"a":1},]', '[null]', '{"a":1}x', '[{"a":1}', '']) {
    await assert.rejects(records('json', text), /JSON|object|Incomplete/)
  }
  await assert.rejects(records('csv', 'amount,amount\n1,2\n'), /duplicate column "amount".*rename/)
  await assert.rejects(records('csv', 'a\n"unfinished\n'), /Unterminated.*close the quote/)
  await assert.rejects(records('csv', 'a\n1,2\n'), /beyond the header.*name every populated/)
  await assert.rejects(records('csv', 'a,\n1,2\n'), /no header.*name the column/)
  await assert.rejects(records('csv', 'a\nx"y"\n'), /quote appears inside.*quote the complete field/)
  await assert.rejects(records('csv', 'a\n"x"y\n'), /content after its closing quote.*inside the quotes/)
})
test('streaming XLSX reads shared strings without caching the dictionary in memory', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Data')
  sheet.addRow(['employee', 'amount']); sheet.addRow(['Élodie', '999999999999998.99'])
  const binary = Buffer.from(await workbook.xlsx.writeBuffer())
  const source = (async function* () { for (let i = 0; i < binary.length; i += 127) yield binary.subarray(i, i + 127) })()
  const rows = []
  for await (const record of parseTransferRows('xlsx', source)) if (record.row) rows.push(record.row)
  assert.deepEqual(rows, [{ employee: 'Élodie', amount: '999999999999998.99' }])
})
test('XLSX formulas, including array formulas, cannot masquerade as literal money', async () => {
  for (const array of [false, true]) {
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Data')
    sheet.addRow(['name', 'amount']); sheet.addRow(['computed', { formula: '1+1', result: 2, ...(array ? { shareType: 'array' as const, ref: 'B2:B3' } : {}) }])
    if (array) sheet.addRow(['array result', 2])
    const binary = Buffer.from(await workbook.xlsx.writeBuffer())
    await assert.rejects(async () => { for await (const _ of parseTransferRows('xlsx', (async function* () { yield binary })())) { /* consume */ } }, /contains formulas.*paste their values/)
  }
})
test('numeric spreadsheet XML retains decimal digits while date styles remain dates', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Data')
  sheet.addRow(['amount', 'date']); sheet.addRow([2, new Date('2026-01-31T00:00:00Z')])
  const archive = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
  const path = 'xl/worksheets/sheet1.xml'
  const original = await archive.file(path)!.async('string')
  assert.ok(original.includes('<v>2</v>'))
  archive.file(path, original.replace('<v>2</v>', '<v>999999999999998.9999</v>'))
  const binary = await archive.generateAsync({ type: 'nodebuffer' })
  const rows = []
  for await (const record of parseTransferRows('xlsx', (async function* () { yield binary })())) if (record.row) rows.push(record.row)
  assert.deepEqual(rows, [{ amount: '999999999999998.9999', date: '2026-01-31' }])
})
test('invalid numeric spreadsheet tokens refuse with the cell address and a usable remedy', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Data')
  sheet.addRow(['amount']); sheet.addRow([2])
  const archive = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
  const path = 'xl/worksheets/sheet1.xml', original = await archive.file(path)!.async('string')
  assert.ok(original.includes('<v>2</v>'))
  for (const literal of ['2USD', 'NaN', 'Infinity', '1,234']) {
    archive.file(path, original.replace('<v>2</v>', `<v>${literal}</v>`))
    const binary = await archive.generateAsync({ type: 'nodebuffer' })
    await assert.rejects(async () => {
      for await (const _ of parseTransferRows('xlsx', (async function* () { yield binary })())) { /* consume */ }
    }, /A2.*invalid numeric literal.*enter a number or save the cell as text/)
  }
})
test('prefixed spreadsheet records cannot disappear silently in the native decoder', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Data')
  sheet.addRow(['amount']); sheet.addRow([2])
  const archive = await JSZip.loadAsync(await workbook.xlsx.writeBuffer())
  const path = 'xl/worksheets/sheet1.xml', original = await archive.file(path)!.async('string')
  const prefixed = original.replace('<worksheet ', '<worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ')
    .replace(/<(\/?)(row|c|v)(?=[\s>])/g, '<$1x:$2')
  archive.file(path, prefixed)
  const binary = await archive.generateAsync({ type: 'nodebuffer' })
  await assert.rejects(async () => {
    for await (const _ of parseTransferRows('xlsx', (async function* () { yield binary })())) { /* consume */ }
  }, /prefixed record elements.*save the data as CSV/)
})
test('spreadsheet records are bounded before inline or dictionary text expands into a row', async () => {
  for (const shared of [false, true]) {
    const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Data')
    sheet.addRow(Array.from({ length: 150 }, (_, index) => `field${index}`))
    sheet.addRow(Array.from({ length: 150 }, () => 'x'.repeat(32_000)))
    const binary = Buffer.from(await workbook.xlsx.writeBuffer({ useSharedStrings: shared }))
    await assert.rejects(async () => {
      for await (const _ of parseTransferRows('xlsx', (async function* () { yield binary })())) { /* consume */ }
    }, /worksheet row.*larger than 4 MiB.*reduce that record/)
  }
})
test('an oversized spreadsheet dictionary entry refuses by name', async () => {
  const workbook = new ExcelJS.Workbook(), sheet = workbook.addWorksheet('Data')
  sheet.addRow(['value']); sheet.addRow(['x'.repeat(4 * 1024 * 1024 + 1)])
  const binary = Buffer.from(await workbook.xlsx.writeBuffer({ useSharedStrings: true }))
  await assert.rejects(async () => {
    for await (const _ of parseTransferRows('xlsx', (async function* () { yield binary })())) { /* consume */ }
  }, /shared string|cell larger than 4 MiB/)
})
test('two million CSV rows are consumed with bounded memory and no truncated tail', { timeout: 60_000 }, async () => {
  // A constrained child measures live retention after garbage collection.
  // Uncollected allocations in an unconstrained V8 heap are not retained rows.
  const program = `
  import assert from 'node:assert/strict';
  import { parseTransferRows } from './web/lib/data-io/stream-parse.ts';
  const count = 2_000_000
  const source = (async function* () {
    yield Buffer.from('code,amount\\n')
    for (let start = 0; start < count; start += 1000) {
      yield Buffer.from(Array.from({ length: Math.min(1000, count - start) }, (_, i) => 'ROW-' + (start + i) + ',999999999999998.99\\n').join(''))
    }
  })()
  let consumed = 0, last = null, peak = 0
  global.gc()
  const initial = process.memoryUsage().heapUsed
  for await (const record of parseTransferRows('csv', source)) {
    if (!record.row) continue
    consumed++; last = record.row
    if (consumed % 100_000 === 0) { global.gc(); peak = Math.max(peak, process.memoryUsage().heapUsed) }
  }
  assert.equal(consumed, count)
  assert.equal(last?.code, 'ROW-1999999')
  assert.equal(last?.amount, '999999999999998.99')
  assert.ok(peak - initial < 16 * 1024 * 1024, 'Parser retained source rows beyond its current record window')
  `
  const child = spawn(process.execPath, ['--max-old-space-size=128', '--expose-gc', '--import', './scripts/test-hooks.mjs', '--import', 'tsx', '--input-type=module', '-e', program], { stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  assert.equal(exit, 0, output)
})
