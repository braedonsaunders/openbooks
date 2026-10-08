import { presentedBoardEntries, type BoardWindow, type BoardEntry, type BoardRow } from './model'

export const bookingLegendKey = (entry: BoardEntry) => entry.target ? `label:${entry.target.code ?? entry.target.label}` : null
export const sourceLegendKey = (label: string | null) => label === null ? null : `label:${label}`

/** Value pills share the literal text shown by native booking and history chips. */
export function boardLegend(board: BoardWindow) {
  const slots = new Map<string, { key: string; label: string; color: string | null; people: Set<string> }>()
  const replaced = new Set(board.replaced)
  const days = new Set(board.days.filter(day => board.board.showWeekends || !day.isWeekend).map(day => day.date))
  function add(key: string | null, label: string | null, color: string | null, person: string) {
    if (key === null || label === null) return
    const slot = slots.get(key) ?? { key, label, color, people: new Set<string>() }
    slot.people.add(person); slots.set(key, slot)
  }
  for (const entry of presentedBoardEntries(board)) if (!replaced.has(entry.id) && days.has(entry.startsOn))
    add(bookingLegendKey(entry), entry.target?.code ?? entry.target?.label ?? null, entry.target?.color ?? null, entry.subjectId)
  for (const record of board.sourceRecords ?? []) if (days.has(record.onDate))
    add(sourceLegendKey(record.label), record.label, record.color, record.workerPartyId)
  return [...slots.values()].sort((a, b) => b.people.size - a.people.size || a.label.localeCompare(b.label))
}

/** Search and a selected value narrow rows together; hover only highlights cells. */
export function filterBoardRows(board: BoardWindow, search: string, selected: string | null): readonly BoardRow[] {
  const query = search.trim().toLowerCase()
  const entries = presentedBoardEntries(board)
  const selectedPeople = selected ? boardLegend(board).find(slot => slot.key === selected)?.people ?? new Set<string>() : null
  return board.rows.filter(person => (!selectedPeople || selectedPeople.has(person.subjectId)) && (!query
    || `${person.name} ${person.jobTitle ?? ''} ${person.tradeName ?? ''}`.toLowerCase().includes(query)
    || entries.some(entry => entry.subjectId === person.subjectId && entry.target && `${entry.target.code ?? ''} ${entry.target.label}`.toLowerCase().includes(query))
    || (board.sourceRecords ?? []).some(record => record.workerPartyId === person.subjectId && `${record.label ?? ''} ${record.result ?? ''}`.toLowerCase().includes(query))))
}
