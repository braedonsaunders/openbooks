/**
 * Pure board logic shared by every scheduling view: cell addressing,
 * rectangular selection, pattern tiling for paste and fill, the inverse of a
 * saved batch for undo, typed-input parsing and day totals. No React, no I/O.
 */
import type { BoardChange, BookingFields, ChangeResult, SpanInput } from '@openbooks/engine/src/schedule-boards/entries.ts'
import type { BoardAbsence, BoardEntry, BoardRow, BoardTarget, BoardWindow } from '@openbooks/engine/src/schedule-boards/window.ts'

export type { BoardChange, BookingFields, ChangeResult, SpanInput, BoardAbsence, BoardEntry, BoardRow, BoardTarget, BoardWindow }

/** Literal imported evidence is shown once, without presenting its linked booking again. */
export function presentedBoardEntries(board: BoardWindow): readonly BoardEntry[] {
  const linked = new Set((board.sourceRecords ?? []).flatMap(record => record.linkedEntryId ? [record.linkedEntryId] : []))
  return linked.size ? board.entries.filter(entry => !linked.has(entry.id)) : board.entries
}

export interface CellAddress {
  readonly row: number
  readonly col: number
}

export interface Selection {
  readonly anchor: CellAddress
  readonly focus: CellAddress
}

export interface Rect {
  readonly top: number
  readonly left: number
  readonly bottom: number
  readonly right: number
}

export function selectionRect(selection: Selection): Rect {
  return {
    top: Math.min(selection.anchor.row, selection.focus.row),
    bottom: Math.max(selection.anchor.row, selection.focus.row),
    left: Math.min(selection.anchor.col, selection.focus.col),
    right: Math.max(selection.anchor.col, selection.focus.col),
  }
}

export function rectCells(rect: Rect): CellAddress[] {
  const cells: CellAddress[] = []
  for (let row = rect.top; row <= rect.bottom; row++) {
    for (let col = rect.left; col <= rect.right; col++) cells.push({ row, col })
  }
  return cells
}

export function rectSize(rect: Rect): { rows: number; cols: number } {
  return { rows: rect.bottom - rect.top + 1, cols: rect.right - rect.left + 1 }
}

export function clampCell(cell: CellAddress, rows: number, cols: number): CellAddress {
  return { row: Math.max(0, Math.min(rows - 1, cell.row)), col: Math.max(0, Math.min(cols - 1, cell.col)) }
}

export const cellKey = (partyId: string, date: string) => `${partyId}|${date}`

/** Bookings indexed by person and every date they touch. */
export function indexEntries(entries: readonly BoardEntry[]): Map<string, BoardEntry[]> {
  const index = new Map<string, BoardEntry[]>()
  for (const entry of entries) {
    let date = entry.startsOn
    // A booking is listed on its start date; an overnight shift also shows on the next morning.
    const dates = [date]
    if (entry.endsOn !== entry.startsOn && entry.endClock !== '00:00') dates.push(entry.endsOn)
    for (date of dates) {
      const key = cellKey(entry.subjectId, date)
      const list = index.get(key)
      if (list) list.push(entry)
      else index.set(key, [entry])
    }
  }
  for (const list of index.values()) list.sort((a, b) => a.startsAt.localeCompare(b.startsAt))
  return index
}

export function indexAbsences(absences: readonly BoardAbsence[]): Map<string, BoardAbsence[]> {
  const index = new Map<string, BoardAbsence[]>()
  for (const absence of absences) {
    const key = cellKey(absence.workerPartyId, absence.onDate)
    const list = index.get(key)
    if (list) list.push(absence)
    else index.set(key, [absence])
  }
  return index
}

/** The fields that recreate a booking somewhere else. */
export function entryTemplate(entry: BoardEntry): Omit<BookingFields, 'workerPartyId' | 'subject' | 'onDate'> {
  return {
    target: entry.target ? { kind: entry.target.kind, id: entry.target.id } : null,
    projectTaskId: entry.projectTaskId,
    departmentId: entry.departmentId,
    detail: entry.detail,
    notes: entry.notes,
    span: spanOf(entry),
  }
}

export function spanOf(entry: BoardEntry): SpanInput {
  return entry.spanMode === 'day'
    ? { mode: 'day' }
    : { mode: 'timed', starts: entry.startClock, ends: entry.endClock, breakMinutes: entry.breakMinutes }
}

export function entryFields(entry: BoardEntry): BookingFields {
  return { ...entryTemplate(entry), subject: { kind: entry.subjectKind, id: entry.subjectId }, onDate: entry.startsOn, seriesId: entry.seriesId }
}

export type ClipCell = readonly Omit<BookingFields, 'workerPartyId' | 'subject' | 'onDate'>[]

/**
 * Tile a copied block over a destination the way a spreadsheet pastes: a
 * destination that is a whole multiple of the block repeats it; otherwise
 * the block is pasted once at the destination's top-left.
 */
export function tilePattern(block: readonly (readonly ClipCell[])[], destination: Rect): { cell: CellAddress; content: ClipCell }[] {
  const blockRows = block.length
  const blockCols = block[0]?.length ?? 0
  if (blockRows === 0 || blockCols === 0) return []
  const size = rectSize(destination)
  const repeats = size.rows % blockRows === 0 && size.cols % blockCols === 0
  const rows = repeats ? size.rows : blockRows
  const cols = repeats ? size.cols : blockCols
  const out: { cell: CellAddress; content: ClipCell }[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out.push({ cell: { row: destination.top + r, col: destination.left + c }, content: block[r % blockRows]![c % blockCols]! })
    }
  }
  return out
}

/**
 * What undoes a saved batch. A booking that was created is removed; a
 * removed booking is booked again; a changed booking is changed back on the
 * row that now holds it.
 */
export function inverseOf(changes: readonly BoardChange[], results: readonly ChangeResult[], before: ReadonlyMap<string, BoardEntry>, newId: () => string): BoardChange[] {
  const inverse: BoardChange[] = []
  results.forEach((result, index) => {
    const change = changes[index]
    if (!result.ok || !change) return
    if (change.op === 'create' && result.entry) {
      inverse.push({ op: 'cancel', id: result.entry.id, expectedRevision: result.entry.revision })
    } else if (change.op === 'cancel') {
      const original = before.get(change.id)
      if (original) inverse.push({ op: 'create', id: newId(), ...entryFields(original) })
    } else if (change.op === 'update' && result.entry) {
      const original = before.get(change.id)
      if (original) inverse.push({ op: 'update', id: result.entry.id, expectedRevision: result.entry.revision, fields: entryFields(original) })
    }
  })
  return inverse.reverse()
}

export interface ParsedInput {
  readonly query: string
  readonly detail: string | null
  readonly span: SpanInput | null
}

const TIME = String.raw`(\d{1,2})(?::?(\d{2}))?`
const RANGE = new RegExp(String.raw`\s+${TIME}\s*-\s*${TIME}\s*$`)

function clock(hours: string, minutes: string | undefined): string | null {
  const h = Number(hours)
  const m = minutes === undefined ? 0 : Number(minutes)
  if (!Number.isInteger(h) || h > 23 || !Number.isInteger(m) || m > 59) return null
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * Read what a scheduler typed into a cell: the target code or name, an
 * optional detail after a slash ("BIRLA/kiln 2"), and an optional time range
 * at the end ("BIRLA 6-14:30") that books those hours instead of the day.
 */
export function parseCellInput(raw: string): ParsedInput {
  let text = raw.trim()
  let span: SpanInput | null = null
  const range = RANGE.exec(text)
  if (range) {
    const starts = clock(range[1]!, range[2])
    const ends = clock(range[3]!, range[4])
    if (starts && ends && starts !== ends) {
      span = { mode: 'timed', starts, ends, breakMinutes: 0 }
      text = text.slice(0, range.index).trim()
    }
  }
  const slash = text.indexOf('/')
  if (slash > 0) {
    const detail = text.slice(slash + 1).trim()
    return { query: text.slice(0, slash).trim(), detail: detail || null, span }
  }
  return { query: text, detail: null, span }
}

export function formatMinutes(minutes: number): string {
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, '0')}`
}

export interface DayTotal {
  readonly people: number
  readonly minutes: number
  readonly byTarget: readonly { target: BoardTarget; people: number }[]
}

/** Headcount and booked minutes per day over the shown people; unavailable codes do not count. */
export function dayTotals(dates: readonly string[], people: readonly BoardRow[], index: ReadonlyMap<string, BoardEntry[]>, hidden: ReadonlySet<string>): Map<string, DayTotal> {
  const totals = new Map<string, DayTotal>()
  for (const date of dates) {
    let count = 0
    let minutes = 0
    const byTarget = new Map<string, { target: BoardTarget; people: Set<string> }>()
    for (const person of people) {
      const entries = (index.get(cellKey(person.subjectId, date)) ?? []).filter((entry) => entry.startsOn === date && !hidden.has(entry.id))
      const working = entries.filter((entry) => entry.target?.counts !== false)
      if (working.length) count++
      for (const entry of working) {
        minutes += entry.workedMinutes
        if (entry.target) {
          const key = `${entry.target.kind}:${entry.target.id}`
          const slot = byTarget.get(key) ?? { target: entry.target, people: new Set<string>() }
          slot.people.add(person.subjectId)
          byTarget.set(key, slot)
        }
      }
    }
    totals.set(date, {
      people: count,
      minutes,
      byTarget: [...byTarget.values()].map((slot) => ({ target: slot.target, people: slot.people.size })).sort((a, b) => b.people - a.people),
    })
  }
  return totals
}

/** A stable hue for a target, so the same job reads the same colour everywhere. Codes keep their configured colour. */
export function targetHue(target: Pick<BoardTarget, 'id' | 'color'> | null): number {
  if (!target) return 210
  if (target.color && /^#[0-9a-f]{6}$/i.test(target.color)) return hexHue(target.color)
  let hash = 0
  for (const char of target.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 360
}

function hexHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 210
  const delta = max - min
  const hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4
  return Math.round(((hue * 60) + 360) % 360)
}

export function targetShortLabel(target: BoardTarget | null): string {
  if (!target) return '—'
  return target.code || target.label
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]![0] : '')).toUpperCase()
}

export type GroupBy = 'none' | 'department' | 'trade' | 'jobTitle'

export interface RowItem {
  readonly kind: 'group' | 'person'
  readonly key: string
  readonly label: string
  readonly person?: BoardRow
  /** Index into the person rows (selection coordinates). */
  readonly personIndex?: number
  readonly count?: number
}

/** Flatten people into display rows with optional group headers. Person order is the selection order. */
export function groupRows(people: readonly BoardRow[], groupBy: GroupBy, ungrouped: string): { items: RowItem[]; persons: BoardRow[] } {
  if (groupBy === 'none') {
    return {
      items: people.map((person, personIndex) => ({ kind: 'person', key: person.subjectId, label: person.name, person, personIndex })),
      persons: [...people],
    }
  }
  const label = (person: BoardRow) =>
    (groupBy === 'department' ? person.departmentName : groupBy === 'trade' ? person.tradeName : person.jobTitle) ?? ungrouped
  const groups = new Map<string, BoardRow[]>()
  for (const person of people) {
    const key = label(person)
    const list = groups.get(key)
    if (list) list.push(person)
    else groups.set(key, [person])
  }
  const items: RowItem[] = []
  const persons: BoardRow[] = []
  for (const [name, members] of [...groups.entries()].sort(([a], [b]) => (a === ungrouped ? 1 : b === ungrouped ? -1 : a.localeCompare(b)))) {
    items.push({ kind: 'group', key: `group:${name}`, label: name, count: members.length })
    for (const person of members) {
      items.push({ kind: 'person', key: person.subjectId, label: person.name, person, personIndex: persons.length })
      persons.push(person)
    }
  }
  return { items, persons }
}

export function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}
export function weekStart(date: string, weekStartsOn: number): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
  return addDays(date, -((weekday - weekStartsOn + 7) % 7))
}
/** The dates a view shows around an anchor date. */
export function viewRange(view: string, anchor: string, rangeDays: number, weekStartsOn: number): { from: string; through: string } {
  if (view === 'calendar') {
    // Whole weeks covering the month: five when they fit, otherwise six.
    const year = Number(anchor.slice(0, 4))
    const month = Number(anchor.slice(5, 7))
    const last = `${anchor.slice(0, 7)}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`
    const from = weekStart(`${anchor.slice(0, 7)}-01`, weekStartsOn)
    const five = addDays(from, 34)
    return { from, through: five >= last ? five : addDays(from, 41) }
  }
  const from = rangeDays >= 7 ? weekStart(anchor, weekStartsOn) : anchor
  return { from, through: addDays(from, rangeDays - 1) }
}
