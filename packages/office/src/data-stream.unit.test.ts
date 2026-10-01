import assert from 'node:assert/strict'
import test from 'node:test'
import { Writable } from 'node:stream'
import ExcelJS from 'exceljs'
import { createDataXlsxStream } from './data-stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Parse } from 'unzipper'

test('spreadsheet stream retains exact decimals and neutralizes formula text', async () => {
  const chunks: Buffer[] = []
  const sink = new Writable({ write(chunk: Buffer, _encoding, callback) { chunks.push(chunk); callback() } })
  const writer = createDataXlsxStream(sink, ['code', 'amount'])
  writer.append(['=HYPERLINK("bad")', '999999999999998.99'])
  await writer.drain(); await writer.finish()
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Buffer.concat(chunks) as unknown as ArrayBuffer)
  assert.equal(workbook.worksheets[0]!.getCell('A2').value, '\'=HYPERLINK("bad")')
  assert.equal(workbook.worksheets[0]!.getCell('B2').value, '999999999999998.99')
})
test('a slow destination applies backpressure without retaining all row objects', { timeout: 60_000 }, async () => {
  let outputBytes = 0, writes = 0
  const sink = new Writable({ highWaterMark: 1024, write(chunk: Buffer, _encoding, callback) {
    outputBytes += chunk.length; writes++; setTimeout(callback, 1)
  } })
  const writer = createDataXlsxStream(sink, ['code', 'amount'])
  const initial = process.memoryUsage().heapUsed
  let peak = initial
  for (let page = 0; page < 400; page++) {
    for (let row = 0; row < 250; row++) writer.append([`record-${page * 250 + row}`, '1234567890123.1234'])
    await writer.drain(); peak = Math.max(peak, process.memoryUsage().heapUsed)
  }
  await writer.finish()
  assert.ok(outputBytes > 100_000); assert.ok(writes > 10)
  assert.ok(peak - initial < 100 * 1024 * 1024, `Writer retained ${peak - initial} bytes under destination backpressure`)
})

test('million-row spreadsheet exports roll over without losing the last data row', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'openbooks-export-test-'))
  const file = join(dir, 'rows.xlsx'), sink = createWriteStream(file)
  const writer = createDataXlsxStream(sink, ['code', 'amount'])
  try {
    const total = 1_048_576
    for (let start = 0; start < total; start += 250) {
      for (let row = start; row < Math.min(start + 250, total); row++) writer.append([`record-${row}`, '999999999999998.99'])
      await writer.drain()
    }
    await writer.finish()
    const source = createReadStream(file), zip = Parse({ forceStream: true })
    source.pipe(zip)
    const counts: number[] = []
    let lastRowPresent = false
    try {
      for await (const entry of zip) {
        if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(entry.path)) { await entry.autodrain().promise(); continue }
        let count = 0, tail = ''
        for await (const bytes of entry) {
          const text = tail + bytes.toString('utf8')
          count += (text.match(/<row\s/g) ?? []).length
          if (text.includes('record-1048575')) lastRowPresent = true
          // A row tag cannot fit in this tail; boundary-spanning tags can.
          tail = text.slice(-4)
        }
        counts.push(count)
      }
    } finally { source.destroy(); zip.destroy() }
    assert.deepEqual(counts, [1_048_576, 2])
    assert.equal(lastRowPresent, true)
  } finally { writer.abort(); sink.destroy(); await rm(dir, { recursive: true, force: true }) }
})
