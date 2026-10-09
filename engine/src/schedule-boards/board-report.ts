import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { configuredSchedulePdfLayout, schedulePdfLayoutSchema, type SchedulePdfLayout } from '@openbooks/forms-core'
import { db, withOrgTransaction } from '../platform/db.ts'
import { canonicalJson } from '../platform/canonical-json.ts'
import { getBoard, boardAuthority, type ScheduleActor } from './boards.ts'
import { loadBoardWindow } from './window.ts'
import { scheduleReportLines } from './distribution.ts'
import { renderSchedulePdf, type ScheduleReportPreview } from './distribution-report.ts'
import { ScheduleError } from './errors.ts'
import type { ScheduleEmailLine } from '@openbooks/emails'

export interface ScheduleBoardReportPreview extends ScheduleReportPreview {
  layout: SchedulePdfLayout
  lines: readonly ScheduleEmailLine[]
}
async function readReport(actor: ScheduleActor, input: {boardId: string; from: string; through: string; layout?: SchedulePdfLayout}): Promise<ScheduleBoardReportPreview> {
  const board = await getBoard(actor, input.boardId)
  // Exporting the whole addressed board requires operator authority, independently of email sharing/audience settings.
  await boardAuthority(actor, board, 'manage')
  let configured: SchedulePdfLayout | undefined
  try { configured = input.layout ?? configuredSchedulePdfLayout(board.automaticDeliveryPolicy) }
  catch { throw new ScheduleError('The board PDF layout is invalid.', {code: 'schedule_pdf_refused', remedy: 'Correct the report layout in Board Settings or choose an explicit valid layout.'}) }
  const parsed = schedulePdfLayoutSchema.safeParse(configured)
  if (!parsed.success) throw new ScheduleError('The PDF layout is invalid.', {code: 'schedule_pdf_refused', remedy: 'Review the native page layout choices.'})
  const window = await loadBoardWindow({...actor, ...input})
  const relevant = new Set([
    ...window.entries.filter(entry => entry.boardId === board.id && entry.status === 'published').map(entry => entry.subjectId),
    ...(window.sourceRecords ?? []).map(record => record.workerPartyId),
    ...window.rows.filter(row => row.inScope).map(row => row.subjectId),
  ])
  const lines = scheduleReportLines(window, relevant, window.rows.filter(row => relevant.has(row.subjectId)))
  const organizationName = (await db.execute<{name: string}>(sql`select name from orgs where id=${actor.orgId}`)).rows[0]!.name
  const evidence = {
    boardId: board.id, boardName: board.name, organizationName,
    from: window.from, through: window.through, timeZone: board.timeZone,
    weekendDays: board.weekendDays, layout: parsed.data, lines,
    entries: window.entries.filter(entry => entry.boardId === board.id).map(entry => ({id: entry.id, revision: entry.revision, status: entry.status})).sort((a,b) => a.id.localeCompare(b.id)),
    sourceIds: (window.sourceRecords ?? []).map(record => record.id).sort(),
  }
  return {...evidence, generatedAt: new Date().toISOString(), version: createHash('sha256').update(canonicalJson(evidence)).digest('hex'), audience: {visibility: 'board', pdfLayout: parsed.data}}
}
/** Read-only report preview has no provider, employee email, Flows or recipient eligibility dependency. */
export function previewScheduleBoardReport(actor: ScheduleActor, input: {boardId: string; from: string; through: string; layout?: SchedulePdfLayout}) {
  return withOrgTransaction(actor.orgId, () => readReport(actor, input), {isolationLevel: 'REPEATABLE READ'})
}
export function downloadScheduleBoardReport(actor: ScheduleActor, input: {boardId: string; from: string; through: string; layout: SchedulePdfLayout; version: string}) {
  return withOrgTransaction(actor.orgId, async () => {
    const report = await readReport(actor, input)
    if (report.version !== input.version) throw new ScheduleError('The board report changed after preview.', {code: 'schedule_pdf_refused', remedy: 'Preview the current board window and layout again before downloading.'})
    return renderSchedulePdf(report, {lines: report.lines})
  }, {isolationLevel: 'REPEATABLE READ'})
}
