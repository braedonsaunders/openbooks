import { parseCsvRows } from '@openbooks/engine/banking/csv'
import { readSheetRows } from '@openbooks/office'
import { parseImportJson } from './import-parse'
import { assertUniqueHeaders, ImportParseError } from './parse'
import { TRANSFER_MAX_ROW_BYTES, TransferRefusal } from './transfer-contract'
import { CELL_PROVENANCE_KEY, type ImportFormat } from './types'

export type ParsedRecord = { headers: string[]; row: Record<string, unknown> | null }

async function* decoded(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for await (const bytes of source) yield decoder.decode(bytes, { stream: true })
  yield decoder.decode()
}

/** Split CSV records without treating quoted newlines as record boundaries. */
async function* csvRecords(source: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  let record = '', first = true, skipLf = false
  let field: 'start' | 'bare' | 'quoted' | 'closed' = 'start'
  for await (let text of decoded(source)) {
    if (first && text.length) { text = text.replace(/^\uFEFF/, ''); first = false }
    let start = 0
    for (let i = 0; i < text.length; i++) {
      const char = text[i]!
      if (skipLf) { skipLf = false; if (char === '\n') { start = i + 1; continue } }
      if ((char === '\n' || char === '\r') && field !== 'quoted') {
        record += text.slice(start, i)
        if (Buffer.byteLength(record) > TRANSFER_MAX_ROW_BYTES) throw oversizedRow()
        yield record
        record = ''; start = i + 1; field = 'start'; skipLf = char === '\r'
        continue
      }
      if (field === 'quoted') { if (char === '"') field = 'closed'; continue }
      if (field === 'closed') {
        if (char === '"') { field = 'quoted'; continue }
        if (char === ',') { field = 'start'; continue }
        throw new ImportParseError('A quoted CSV field has content after its closing quote — place all field content inside the quotes before importing.')
      }
      if (char === ',') field = 'start'
      else if (char === '"') {
        if (field !== 'start') throw new ImportParseError('A CSV quote appears inside an unquoted field — quote the complete field and double any literal quotes before importing.')
        field = 'quoted'
      } else field = 'bare'
    }
    record += text.slice(start)
    if (Buffer.byteLength(record) > TRANSFER_MAX_ROW_BYTES) throw oversizedRow()
  }
  if (field === 'quoted') throw new ImportParseError('Unterminated quoted CSV cell — close the quote and upload the corrected file.')
  if (record.length) yield record
}
function oversizedRow() {
  return new TransferRefusal('A source record exceeds 4 MiB — reduce the contents of that record and upload the corrected file.', 422)
}

/** Retain numeric source tokens while holding at most one JSON record. */
async function* jsonRecords(source: AsyncIterable<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  let state: 'start' | 'first' | 'object' | 'between' | 'expect' | 'done' = 'start'
  let array = false, quoted = false, escaped = false, depth = 0, record = ''
  for await (const text of decoded(source)) {
    for (const char of text) {
      if (state !== 'object') {
        if (/\s/.test(char)) continue
        if (state === 'start' && char === '[') { array = true; state = 'first'; continue }
        if ((state === 'start' || state === 'first' || state === 'expect') && char === '{') {
          state = 'object'; depth = 1; record = '{'; continue
        }
        if ((state === 'between' || state === 'first') && array && char === ']') { state = 'done'; continue }
        if (state === 'between' && array && char === ',') { state = 'expect'; continue }
        throw new ImportParseError('Invalid JSON import — supply an object or an array of objects without trailing commas or trailing content.')
      }
      record += char
      if (record.length > TRANSFER_MAX_ROW_BYTES) throw oversizedRow()
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
      } else if (char === '"') quoted = true
      else if (char === '{' || char === '[') depth++
      else if (char === '}' || char === ']') depth--
      if (depth === 0) {
        if (Buffer.byteLength(record) > TRANSFER_MAX_ROW_BYTES) throw oversizedRow()
        const row = parseImportJson(record)
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new ImportParseError('Each JSON entry must be an object.')
        if (Object.hasOwn(row, CELL_PROVENANCE_KEY)) throw new ImportParseError('Reserved provenance keys cannot be supplied by a JSON file.')
        yield row as Record<string, unknown>
        record = ''; state = array ? 'between' : 'done'
      }
    }
  }
  if (state !== 'done') throw new ImportParseError('Incomplete JSON import — check the file and upload it again.')
}

export async function* parseTransferRows(format: ImportFormat, source: AsyncIterable<Uint8Array>): AsyncGenerator<ParsedRecord> {
  if (format === 'json') {
    const headers: string[] = [], seen = new Set<string>()
    for await (const row of jsonRecords(source)) {
      for (const key of Object.keys(row)) if (!seen.has(key)) { seen.add(key); headers.push(key) }
      if (headers.length > 16_384) throw new ImportParseError('The file has more than 16,384 columns — reduce its column count before importing.')
      yield { headers, row }
    }
    return
  }
  let headers: string[] | null = null
  const records = format === 'xlsx' ? readSheetRows(source) : csvRecords(source)
  for await (const record of records) {
    if (typeof record === 'string' && !record.trim()) continue
    const cells = typeof record === 'string' ? (parseCsvRows(record)[0] ?? []) : record
    if (!headers) {
      headers = cells.map((value) => String(value ?? '').trim())
      if (headers.length > 16_384) throw new ImportParseError('The file has more than 16,384 columns — reduce its column count before importing.')
      assertUniqueHeaders(headers)
      if (headers.some((header) => header === CELL_PROVENANCE_KEY)) throw new ImportParseError('A column uses a reserved provenance key — rename it before importing.')
      if (!headers.some(Boolean)) throw new ImportParseError('The file has no named columns — add a header row before importing.')
      yield { headers, row: null }; continue
    }
    if (cells.every((cell) => cell === null || cell === undefined || String(cell).trim() === '')) continue
    if (cells.length > headers.length && cells.slice(headers.length).some((cell) => String(cell ?? '').trim())) {
      throw new ImportParseError('A record has values beyond the header columns — name every populated column before importing.')
    }
    const row: Record<string, unknown> = {}, provenance: Record<string, string> = {}
    headers.forEach((header, i) => {
      if (!header) {
        if (String(cells[i] ?? '').trim()) throw new ImportParseError('A populated column has no header — name the column before importing.')
        return
      }
      const cell = cells[i]
      if (cell && typeof cell === 'object' && 'value' in cell) { row[header] = cell.value; provenance[header] = 'formula' }
      else row[header] = cell ?? ''
    })
    if (Object.keys(provenance).length) row[CELL_PROVENANCE_KEY] = provenance
    if (Buffer.byteLength(JSON.stringify(row)) > TRANSFER_MAX_ROW_BYTES) throw oversizedRow()
    yield { headers, row }
  }
}
