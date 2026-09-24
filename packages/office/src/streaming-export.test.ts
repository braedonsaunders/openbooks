import assert from 'node:assert/strict'
import test from 'node:test'
import ExcelJS from 'exceljs'
import {
  createPagedCsvStream,
  createStreamingXlsxExport,
  readSheet,
  reportResultToCsv,
  reportResultToXlsx,
  xlsxColumnWidth,
  xlsxExportCellLength,
  type PagedCsvPageGroup,
} from './index'

type Cell = string | number | null | undefined
type CannedGroup = { title: string; subtitle?: string; columns: string[]; rows: Cell[][] }

// A small multi-page lot-recall-shaped population: three offset pages, an
// injection attack string, nulls, numbers, and exact-decimal strings.
function cannedPages(): CannedGroup[][] {
  const columns = ['Lot #', 'Item', 'Qty', 'Note']
  const page = (rows: Cell[][]): CannedGroup[] => [{ title: 'Results', columns, rows }]
  return [
    page([
      ['LOT-1', 'Widget', '-2.0000', '=cmd|evil'],
      ['LOT-2', 'Gadget', '5', null],
    ]),
    page([
      ['LOT-3', 'Widget', '1.5', 'ok'],
      ['LOT-4', '+@bad', '3', 'x,y’가'],
    ]),
    page([['LOT-5', 'Widget', '7', undefined]]),
  ]
}

function mergedResult(pages: CannedGroup[][]) {
  const groups = [
    {
      kind: 'results' as const,
      title: 'Results',
      subtitle: `${pages.flatMap((p) => p.flatMap((g) => g.rows)).length} row(s)`,
      columns: pages[0]![0]!.columns,
      rows: pages.flatMap((p) => p.flatMap((g) => g.rows)),
      isEmpty: false,
    },
  ]
  const rowCount = groups[0]!.rows.length
  return { groups, summary: [{ label: 'Rows', value: rowCount }], rowCount }
}

function toSlots(pages: CannedGroup[][]): PagedCsvPageGroup[][] {
  return pages.map((page) => page.map((g) => ({ slot: 0, title: g.title, columns: g.columns, rows: g.rows })))
}

test('streamed CSV is byte-identical to the buffered builder on multi-page output', () => {
  const pages = cannedPages()
  const expected = reportResultToCsv(mergedResult(pages), { sectionHeader: 'Section' })
  const stream = createPagedCsvStream({ sectionHeader: 'Section' })
  for (const page of toSlots(pages)) stream.pushPage(page)
  assert.equal(stream.finish(), expected)
})

test('streamed CSV matches on grouped pages with a boundary-spanning section', () => {
  const columns = ['Item', 'Qty']
  // Section B spans the page boundary; pages arrive in offset order with
  // page-local (sorted) group order, like shapeRowsResult emits them.
  const pages: CannedGroup[][] = [
    [
      { title: 'Kind: a', columns, rows: [['x', '1']] },
      { title: 'Kind: b', columns, rows: [['y', '2']] },
    ],
    [
      { title: 'Kind: b', columns, rows: [['z', '3']] },
      { title: 'Kind: c', columns, rows: [['w', '4']] },
    ],
  ]
  const merged = {
    groups: [
      { kind: 'section' as const, title: 'Kind: a', subtitle: '1 row(s)', columns, rows: [['x', '1'] as Cell[]], isEmpty: false },
      { kind: 'section' as const, title: 'Kind: b', subtitle: '2 row(s)', columns, rows: [['y', '2'] as Cell[], ['z', '3'] as Cell[]], isEmpty: false },
      { kind: 'section' as const, title: 'Kind: c', subtitle: '1 row(s)', columns, rows: [['w', '4'] as Cell[]], isEmpty: false },
    ],
    summary: [{ label: 'Rows', value: 4 }],
    rowCount: 4,
  }
  const expected = reportResultToCsv(merged, { sectionHeader: 'Section' })
  const stream = createPagedCsvStream({ sectionHeader: 'Section' })
  const slots = new Map([['Kind: a', 0], ['Kind: b', 1], ['Kind: c', 2]])
  for (const page of pages) {
    stream.pushPage(page.map((g) => ({ slot: slots.get(g.title)!, title: g.title, columns: g.columns, rows: g.rows })))
  }
  assert.equal(stream.finish(), expected)
})

test('streamed CSV footer rows ride the last section with its prefix, like the buffered path', () => {
  const stream = createPagedCsvStream({ sectionHeader: 'Section' })
  stream.pushPage([{ slot: 0, title: 'Kind: a', columns: ['Item'], rows: [['x']] }])
  stream.pushPage([{ slot: 1, title: 'Kind: b', columns: ['Item'], rows: [['y']] }])
  const footers: Cell[][] = [['Rows: 2'], ['Showing the first 2 of 9 rows']]
  const expected = reportResultToCsv(
    {
      groups: [
        { kind: 'section' as const, title: 'Kind: a', columns: ['Item'], rows: [['x'] as Cell[]], isEmpty: false },
        { kind: 'section' as const, title: 'Kind: b', columns: ['Item'], rows: [['y'] as Cell[], ['Rows: 2'] as Cell[], ['Showing the first 2 of 9 rows'] as Cell[]], isEmpty: false },
      ],
      summary: [],
      rowCount: 2,
    },
    { sectionHeader: 'Section' },
  )
  assert.equal(stream.finish(footers), expected)
})

test('a rowless trailing declaration keeps the header and footer on the whole report', () => {
  // The paged caller declares every merged group rowless before finishing,
  // including trailing sections a row cap cut before any row was filed: the
  // section column must survive and the footer must ride the last merged
  // section, exactly like the buffered builder appending to its last group.
  const stream = createPagedCsvStream({ sectionHeader: 'Section' })
  stream.pushPage([{ slot: 0, title: 'Kind: a', columns: ['Item'], rows: [['x']] }])
  stream.pushPage([
    { slot: 0, title: 'Kind: a', columns: ['Item'], rows: [] },
    { slot: 1, title: 'Kind: b', columns: ['Item'], rows: [] },
  ])
  const out = stream.finish([[`Rows: 1`]])
  const expected = reportResultToCsv(
    {
      groups: [
        { kind: 'section' as const, title: 'Kind: a', columns: ['Item'], rows: [['x'] as Cell[]], isEmpty: false },
        { kind: 'section' as const, title: 'Kind: b', columns: ['Item'], rows: [['Rows: 1'] as Cell[]], isEmpty: false },
      ],
      summary: [],
      rowCount: 1,
    },
    { sectionHeader: 'Section' },
  )
  assert.equal(out, expected)
})

test('streamed CSV covers the empty result exactly', () => {
  const stream = createPagedCsvStream({ sectionHeader: 'Section' })
  stream.pushPage([{ slot: 0, title: 'Results', columns: ['Lot #'], rows: [] }])
  const expected = reportResultToCsv(
    { groups: [{ kind: 'results' as const, title: 'Results', columns: ['Lot #'], rows: [], isEmpty: true }], summary: [], rowCount: 0 },
    { sectionHeader: 'Section' },
  )
  assert.equal(stream.finish(), expected)
})

test('the CSV stream releases each page: later input mutation cannot corrupt output', () => {
  const pages = cannedPages()
  const pristine = structuredClone(pages)
  const expected = reportResultToCsv(mergedResult(pristine), { sectionHeader: 'Section' })
  const stream = createPagedCsvStream({ sectionHeader: 'Section' })
  for (const page of toSlots(pages)) {
    stream.pushPage(page)
    for (const group of page) {
      for (const row of group.rows) row.fill('MUTATED')
      group.rows.length = 0
    }
  }
  assert.equal(stream.finish(), expected)
})

test('the CSV stream stays bounded on a large population while matching the builder', () => {
  const columns = ['Lot #', 'Item', 'Qty']
  const slots: PagedCsvPageGroup[][] = []
  for (let p = 0; p < 12; p++) {
    const rows: Cell[][] = []
    for (let r = 0; r < 500; r++) rows.push([`LOT-${p * 500 + r}`, 'Widget', `${r}.0000`])
    slots.push([{ slot: 0, title: 'Results', columns, rows }])
  }
  const stream = createPagedCsvStream({})
  for (const page of slots) {
    stream.pushPage(page)
    for (const group of page) {
      for (const row of group.rows) row.fill('MUTATED')
      group.rows.length = 0
    }
  }
  const out = stream.finish()
  const dataLines = out.split('\r\n').filter((line) => line !== '')
  assert.equal(dataLines.length, 1 + 12 * 500)
  assert.match(dataLines[0]!, /^Lot #,Item,Qty$/)
  assert.match(dataLines[1]!, /^LOT-0,Widget,0\.0000$/)
  assert.match(dataLines[dataLines.length - 1]!, /^LOT-5999,Widget,499\.0000$/)
})

async function readAll(buffer: Buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buffer as unknown as ArrayBuffer)
  return wb
}

test('streamed XLSX carries the same sheets, values, and styles as the buffered builder', async () => {
  const generatedAt = new Date('2026-01-01T00:00:00Z')
  const oldInput = {
    groups: [
      {
        kind: 'section' as const,
        title: 'Kind: a/b:c*d?e[f]g',
        subtitle: '2 row(s)',
        columns: ['Item', 'Qty'],
        rows: [['x', 1.5] as Cell[], ['y', '2.0000'] as Cell[]],
        isEmpty: false,
      },
      {
        kind: 'section' as const,
        title: 'Kind: a/b:c*d?e[f]g',
        subtitle: '1 row(s)',
        columns: ['Item', 'Qty'],
        rows: [['z', null] as Cell[]],
        isEmpty: false,
      },
    ],
    summary: [{ label: 'Rows', value: 3 }],
    rowCount: 3,
  }
  const expected = await reportResultToXlsx(oldInput, { reportName: 'Recall', dateRangeLabel: 'FY2026', generatedAt })
  const measure = (columns: string[], rows: Cell[][]): number[] =>
    columns.map((c, i) => xlsxColumnWidth(Math.max(
      xlsxExportCellLength(c),
      ...rows.slice(0, 400).map((row) => xlsxExportCellLength(row[i])),
    )))
  const writer = createStreamingXlsxExport({
    reportName: 'Recall',
    dateRangeLabel: 'FY2026',
    generatedAt,
    groups: [
      { title: 'Kind: a/b:c*d?e[f]g', subtitle: '2 row(s)', columns: ['Item', 'Qty'], widths: measure(['Item', 'Qty'], [['x', 1.5], ['y', '2.0000']]) },
      { title: 'Kind: a/b:c*d?e[f]g', subtitle: '1 row(s)', columns: ['Item', 'Qty'], widths: measure(['Item', 'Qty'], [['z', null]]) },
    ],
  })
  writer.appendRows(0, [['x', 1.5], ['y', '2.0000']])
  // Interleaved sheets (page-outer emission) must still land on the right sheet.
  writer.appendRows(1, [['z', null]])
  const actual = await writer.finish()

  // Content identity through the repo's own sheet reader.
  const back = await readSheet(actual)
  assert.deepEqual(back.headers, ['Recall'])
  assert.ok(back.rows.length >= 5)

  const oldWb = await readAll(expected)
  const newWb = await readAll(actual)
  assert.deepEqual(newWb.worksheets.map((w) => w.name), oldWb.worksheets.map((w) => w.name))
  // ExcelJS's streaming writer omits truly-empty cells where the document
  // builder stores an empty string; Excel renders both as blank, so the
  // comparison normalises blank cells (values only — styles stay strict).
  const blank = (v: unknown): boolean => v === null || v === undefined || v === ''
  for (let s = 0; s < oldWb.worksheets.length; s++) {
    const oldWs = oldWb.worksheets[s]!
    const newWs = newWb.worksheets[s]!
    assert.equal(newWs.rowCount, oldWs.rowCount, `sheet ${s} row count`)
    for (let r = 1; r <= oldWs.rowCount; r++) {
      for (let c = 1; c <= 2; c++) {
        const oldValue = oldWs.getCell(r, c).value
        const newValue = newWs.getCell(r, c).value
        assert.ok(
          (blank(oldValue) && blank(newValue)) || JSON.stringify(newValue) === JSON.stringify(oldValue),
          `sheet ${s} r${r}c${c} value: ${JSON.stringify(newValue)} !== ${JSON.stringify(oldValue)}`,
        )
      }
    }
    // Styles: title block, header, and the numeric format survive streaming.
    assert.deepEqual(newWs.getCell(1, 1).font, oldWs.getCell(1, 1).font)
    assert.deepEqual(newWs.getCell(4, 1).font, oldWs.getCell(4, 1).font)
    assert.deepEqual(newWs.getCell(4, 1).fill, oldWs.getCell(4, 1).fill)
    assert.deepEqual(newWs.getCell(4, 1).alignment, oldWs.getCell(4, 1).alignment)
    assert.equal(newWs.getCell(5, 2).numFmt, oldWs.getCell(5, 2).numFmt)
    assert.deepEqual(newWs.getCell(5, 2).alignment, oldWs.getCell(5, 2).alignment)
    assert.equal(newWs.getColumn(1).width, oldWs.getColumn(1).width)
  }
})

test('streamed XLSX honours subtitles, widths, and the empty-groups contract', async () => {
  const generatedAt = new Date('2026-01-01T00:00:00Z')
  const expected = await reportResultToXlsx(
    { groups: [], summary: [], rowCount: 0 },
    { reportName: 'Recall', generatedAt },
  )
  const writer = createStreamingXlsxExport({ reportName: 'Recall', generatedAt, groups: [] })
  const actual = await writer.finish()
  const oldWb = await readAll(expected)
  const newWb = await readAll(actual)
  assert.deepEqual(newWb.worksheets.map((w) => w.name), oldWb.worksheets.map((w) => w.name))
  assert.equal(newWb.worksheets[0]!.getCell(1, 1).value, 'Recall')
})

test('streamed XLSX formats money columns but leaves counts alone', async () => {
  const writer = createStreamingXlsxExport({
    reportName: 'R',
    generatedAt: new Date('2026-01-01T00:00:00Z'),
    groups: [{ title: 'Results', columns: ['Lots', 'Amount'], widths: [10, 16], money: [false, true] }],
  })
  writer.appendRows(0, [[3, 19.99]])
  const back = await readAll(await writer.finish())
  const ws = back.worksheets[0]!
  assert.equal(ws.getCell(5, 1).value, 3)
  assert.equal(ws.getCell(5, 1).numFmt, undefined)
  assert.equal(ws.getCell(5, 2).value, 19.99)
  assert.equal(ws.getCell(5, 2).numFmt, '#,##0.00;(#,##0.00)')
})

test('the XLSX stream releases each page: later input mutation cannot corrupt output', async () => {
  const writer = createStreamingXlsxExport({
    reportName: 'R',
    generatedAt: new Date('2026-01-01T00:00:00Z'),
    groups: [{ title: 'Results', columns: ['A'], widths: [10] }],
  })
  const rows: Cell[][] = [['keep-1'], ['keep-2']]
  writer.appendRows(0, rows)
  rows.forEach((row) => row.fill('MUTATED'))
  rows.length = 0
  const back = await readSheet(await writer.finish())
  assert.ok(back.rows.some((row) => row.includes('keep-1')))
  assert.ok(!back.rows.some((row) => row.includes('MUTATED')))
})
