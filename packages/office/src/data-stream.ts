import ExcelJS from 'exceljs'
import { Readable, Writable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Parse } from 'unzipper'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SaxesParser } from 'saxes'
import { guardCsvCell, readSheetCellValue, SheetReadError, type SheetCellValue } from './index'

interface WorkbookDecoder {
  sharedStrings: unknown
  _parseSharedStrings(input: Readable): AsyncIterable<{ index: number; text: unknown }>
  _parseStyles(input: Readable): Promise<void>
  _parseWorkbook(input: Readable): Promise<void>
  _parseRels(input: Readable): Promise<void>
  _parseWorksheet(input: AsyncIterable<Uint8Array>, id: number): Iterable<{ value: AsyncIterable<ExcelJS.Row> }>
}
/** Validate XML before the spreadsheet decoder allocates its record objects. */
async function* literalSheetBytes(source: AsyncIterable<Uint8Array>, container: 'row' | 'si' = 'row',
  numbers?: Map<number, Map<string, string>>): AsyncGenerator<Uint8Array> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const parser = new SaxesParser({ xmlns: true })
  const label = container === 'si' ? 'shared string' : 'worksheet row'
  let inside = false, recordBytes = 0, rowNumber = 0, address = '', numeric = false, valueOpen = false, value = ''
  const count = (text: string) => {
    if (!inside) return
    recordBytes += Buffer.byteLength(text)
    if (recordBytes > 4 * 1024 * 1024) throw new SheetReadError(label, 'is larger than 4 MiB — reduce that record before importing')
  }
  parser.on('error', () => { throw new SheetReadError(label, 'has malformed XML — save the workbook again before importing') })
  parser.on('doctype', () => { throw new SheetReadError(label, 'contains a document type declaration — save the data in a new workbook before importing') })
  parser.on('opentag', (tag) => {
    if (tag.local === 'f') throw new SheetReadError('worksheet', 'contains formulas — copy the cells and paste their values into a new workbook before importing')
    if (container === 'row' && tag.prefix && ['row', 'c', 'v', 't', 'is'].includes(tag.local)) throw new SheetReadError('worksheet', 'uses prefixed record elements this decoder cannot read — save the data as CSV before importing')
    if (tag.local === container) {
      if (inside) throw new SheetReadError(label, 'contains a nested record — save the workbook again before importing')
      inside = true; recordBytes = 0
      if (container === 'row') {
        rowNumber = Number(tag.attributes.r?.value)
        if (!Number.isInteger(rowNumber) || rowNumber < 1 || rowNumber > 1_048_576) throw new SheetReadError(label, 'has an invalid row number — save the workbook again before importing')
      }
    }
    for (const attribute of Object.values(tag.attributes)) count(attribute.value)
    if (inside && container === 'row' && tag.local === 'c') {
      address = String(tag.attributes.r?.value ?? '').toUpperCase()
      const reference = /^([A-Z]{1,3})([1-9]\d*)$/.exec(address)
      const column = reference?.[1]?.split('').reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0)
      if (!reference || Number(reference[2]) !== rowNumber || !column || column > 16_384) throw new SheetReadError('worksheet cell', 'has an invalid address — save the workbook again before importing')
      numeric = !tag.attributes.t || tag.attributes.t.value === 'n'
      value = ''
    }
    if (inside && numeric && tag.local === 'v') valueOpen = true
  })
  const text = (part: string) => { count(part); if (valueOpen) value += part }
  parser.on('text', text); parser.on('cdata', text)
  parser.on('closetag', (tag) => {
    if (tag.local === 'v') valueOpen = false
    if (inside && container === 'row' && tag.local === 'c' && numeric && numbers) {
      const literal = value.trim()
      if (literal && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(literal)) throw new SheetReadError(address, 'contains an invalid numeric literal — enter a number or save the cell as text')
      let row = numbers.get(rowNumber)
      if (!row) { row = new Map(); numbers.set(rowNumber, row) }
      row.set(address, literal)
      numeric = false
    }
    if (tag.local === container) inside = false
  })
  let tail = '', textBytes = 0
  for await (const bytes of source) {
    const decoded = decoder.decode(bytes, { stream: true })
    const text = tail + decoded
    const boundary = text.lastIndexOf('<')
    textBytes = boundary === -1 ? textBytes + bytes.length : Buffer.byteLength(text.slice(boundary))
    if (textBytes > 4 * 1024 * 1024) throw new SheetReadError('worksheet', 'contains a cell larger than 4 MiB — reduce that cell before importing')
    tail = text.slice(-8)
    parser.write(decoded)
    yield bytes
  }
  parser.write(decoder.decode()).close()
}

/** Workbook metadata is finite; worksheet rows and shared strings stream. */
async function* metadataBytes(source: AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  let size = 0
  for await (const bytes of source) {
    size += bytes.length
    if (size > 8 * 1024 * 1024) throw new SheetReadError('workbook metadata', 'exceeds 8 MiB — remove unused formatting or import the data as CSV or JSON')
    yield bytes
  }
}

/** Shared strings are disk indexed: an XLSX dictionary may contain millions of values. */
export async function* readSheetRows(source: AsyncIterable<Uint8Array>): AsyncGenerator<SheetCellValue[]> {
  const dir = await mkdtemp(join(tmpdir(), 'openbooks-sheet-'))
  const dictionary = new DatabaseSync(join(dir, 'strings.sqlite'))
  dictionary.exec('PRAGMA cache_size=-2048; CREATE TABLE strings (id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
  const put = dictionary.prepare('INSERT INTO strings VALUES (?, ?)')
  const get = dictionary.prepare('SELECT value FROM strings WHERE id=?')
  const textValue = (value: unknown): string => {
    if (value && typeof value === 'object' && 'richText' in value) {
      return (value.richText as { text: string }[]).map((part) => part.text).join('')
    }
    return String(value ?? '')
  }
  const input = Readable.from(source)
  const zip = Parse({ forceStream: true })
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(input, {
    sharedStrings: 'emit', worksheets: 'emit', hyperlinks: 'ignore', styles: 'cache',
  })
  // Reuse ExcelJS's XML decoders while owning archive scratch files. Its
  // default reader removes deferred sheets only on success; cancellations
  // here remove the entire private directory in finally.
  const xml = reader as unknown as WorkbookDecoder
  const worksheets: { id: number; path: string }[] = []
  input.on('error', (error) => zip.destroy(error))
  input.pipe(zip)
  try {
    for await (const entry of zip) {
      if (entry.path === 'xl/sharedStrings.xml') {
        dictionary.exec('BEGIN')
        for await (const value of xml._parseSharedStrings(Readable.from(literalSheetBytes(entry, 'si')))) {
          const text = textValue(value.text)
          if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new SheetReadError('shared string', 'is larger than 4 MiB — reduce that cell before importing')
          put.run(value.index, text)
        }
        dictionary.exec('COMMIT')
      } else if (entry.path === 'xl/styles.xml') await xml._parseStyles(Readable.from(metadataBytes(entry)))
      else if (entry.path === 'xl/workbook.xml') await xml._parseWorkbook(Readable.from(metadataBytes(entry)))
      else if (entry.path === 'xl/_rels/workbook.xml.rels') await xml._parseRels(Readable.from(metadataBytes(entry)))
      else {
        const match = /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(entry.path)
        if (match) {
          if (worksheets.length >= 1024) throw new SheetReadError('workbook', 'has more than 1,024 worksheets — split it into separate import files')
          const path = join(dir, `sheet-${worksheets.length}.xml`)
          await pipeline(entry, createWriteStream(path, { mode: 0o600 }))
          worksheets.push({ id: Number(match[1]), path })
        } else await entry.autodrain().promise()
      }
    }
    // Resolve dictionary references only after the XML row is bounded. The
    // native reader must not expand thousands of large strings into one row.
    xml.sharedStrings = null
    let firstHeaders: SheetCellValue[] | null = null
    for (const sheet of worksheets.sort((a, b) => a.id - b.id)) {
      let first = true
      const file = createReadStream(sheet.path)
      const numbers = new Map<number, Map<string, string>>()
      try {
      const worksheet = [...xml._parseWorksheet(literalSheetBytes(file, 'row', numbers), sheet.id)][0]?.value
      if (!worksheet) throw new SheetReadError('worksheet', 'could not be read — save the workbook again and retry')
      for await (const row of worksheet) {
        const cells: SheetCellValue[] = []
        let cellBytes = 0
        row.eachCell({ includeEmpty: true }, (cell, column) => {
          let value: unknown = cell.value
          if (value && typeof value === 'object' && 'sharedString' in value) {
            const entry = get.get(Number(value.sharedString))
            if (!entry) throw new SheetReadError('shared string', 'is missing — save the workbook again and retry')
            value = entry.value
          }
          // Numeric XML tokens retain their original decimal digits. Date
          // styles remain native dates; formulas have already been refused.
          const raw = typeof value === 'number' ? numbers.get(row.number)?.get(cell.address) : undefined
          const literal = raw === undefined ? readSheetCellValue(value as ExcelJS.CellValue, false, cell.address) : raw
          cellBytes += Buffer.byteLength(JSON.stringify(literal))
          if (cellBytes > 4 * 1024 * 1024) throw new SheetReadError('worksheet row', 'is larger than 4 MiB — reduce that record before importing')
          cells[column - 1] = literal
        })
        numbers.delete(row.number)
        if (first) {
          first = false
          if (firstHeaders) {
            if (JSON.stringify(cells) !== JSON.stringify(firstHeaders)) throw new SheetReadError('workbook', 'has different worksheet headers — split differently shaped sheets into separate files')
            continue
          }
          firstHeaders = cells
        }
        yield cells
      }
      if (numbers.size) throw new SheetReadError('worksheet', 'contains numeric records the decoder could not read — save the workbook again before importing')
      } finally { file.destroy() }
    }
  } finally {
    input.destroy(); zip.destroy()
    dictionary.close()
    await rm(dir, { recursive: true, force: true })
  }
}

/** Row commits release spreadsheet objects; each worksheet obeys Excel's row limit. */
export function createDataXlsxStream(sink: Writable, columns: string[]) {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: sink, useSharedStrings: false, useStyles: false })
  let sheet: ExcelJS.Worksheet | null = null, count = 0, sheets = 0
  const pending = new Set<Promise<void>>()
  let failure: Error | null = null
  const archive = (workbook as unknown as { zip: { on(event: string, handler: (error: Error) => void): void; abort(): void; destroy(): void } }).zip
  archive.on('error', (error) => { failure = error; sink.destroy(error) })
  return {
    append(row: unknown[]) {
      if (failure) throw failure
      if (row.some((value) => String(value ?? '').length > 32_767)) throw new SheetReadError('export cell', 'exceeds the spreadsheet limit of 32,767 characters — export this resource as CSV or JSON instead')
      if (!sheet || count === 1_048_576) {
        sheet?.commit()
        sheet = workbook.addWorksheet(`Data ${++sheets}`)
        // ExcelJS commits rows synchronously and does not await its internal
        // pipe acknowledgements. Track those acknowledgements so a caller
        // can drain each page before reading the next page from PostgreSQL.
        const stream = (sheet as unknown as { stream: { _pipe(chunk: unknown): Promise<void> } }).stream
        const pipe = stream._pipe.bind(stream)
        stream._pipe = (chunk) => {
          const write = pipe(chunk)
          pending.add(write)
          void write.then(() => pending.delete(write), (error: Error) => { pending.delete(write); failure = error })
          return write
        }
        sheet.addRow(columns).commit(); count = 1
      }
      // Financial decimals remain text, preserving every digit on round-trip.
      sheet.addRow(row.map((value) => value === null || value === undefined ? '' : guardCsvCell(String(value)))).commit()
      count++
    },
    async drain() {
      while (pending.size) await Promise.all([...pending])
      if (failure) throw failure
    },
    async finish() {
      if (!sheet) { sheet = workbook.addWorksheet('Data 1'); sheet.addRow(columns).commit() }
      sheet.commit(); await workbook.commit()
    },
    abort() {
      archive.abort(); archive.destroy()
    },
  }
}
