import { add, cmp } from '@openbooks/engine/src/money/money.ts'
import type { ScheduledWork } from '@openbooks/engine/src/schedule-boards/prefill.ts'

interface CrewRow {
  employeePartyId: string
  itemId: string | null
  projectTaskId: string | null
  cells: Record<string, string>
}

/** Fill empty worker-days only. Existing hours and unfinished edits across
 * every labor item, task and time type remain authoritative. */
export function fillTicketFromSchedule(
  rows: readonly CrewRow[],
  scheduled: readonly ScheduledWork[],
  input: { projectId: string; days: readonly string[]; timeTypeId: string },
): { rows: CrewRow[]; filled: number; skipped: number } {
  const next = rows.map((row) => ({ ...row, cells: { ...row.cells } }))
  const days = new Set(input.days)
  const occupied = new Set<string>()
  for (const row of rows) {
    for (const [cell, value] of Object.entries(row.cells)) {
      if (value.trim() !== '') occupied.add(`${row.employeePartyId}|${cell.split('|')[1]}`)
    }
  }
  const skipped = new Set<string>()
  const filled = new Set<string>()
  for (const work of scheduled) {
    if (work.projectId !== input.projectId || !days.has(work.onDate) || cmp(work.hours, '0') <= 0) continue
    const dayKey = `${work.workerPartyId}|${work.onDate}`
    if (occupied.has(dayKey)) { skipped.add(dayKey); continue }
    let row = next.find((candidate) => candidate.employeePartyId === work.workerPartyId
      && candidate.itemId === null && candidate.projectTaskId === work.projectTaskId)
    if (!row) {
      row = { employeePartyId: work.workerPartyId, itemId: null, projectTaskId: work.projectTaskId, cells: {} }
      next.push(row)
    }
    const cell = `${input.timeTypeId}|${work.onDate}`
    row.cells[cell] = add(row.cells[cell] ?? '0', work.hours)
    filled.add(dayKey)
  }
  return { rows: next, filled: filled.size, skipped: skipped.size }
}
