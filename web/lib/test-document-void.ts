import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { requestDocumentVoid } from '@openbooks/engine/src/ledger/document-void.ts'
import { db, withBypassContext } from '@openbooks/engine/src/platform/db.ts'
import { createScratchUser } from '@openbooks/engine/src/testing/fixtures.ts'

export async function voidScratchDocument(args: {
  orgId: string
  documentId: string
  actorName: string
  reason: string
  reversalDate: string
}) {
  const [year, month] = args.reversalDate.split('-').map(Number)
  const startsOn = `${args.reversalDate.slice(0, 7)}-01`
  const endsOn = new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10)
  await withBypassContext(async () => {
    const calendar = await db.execute<{ id: string }>(sql`
      select fiscal_calendar_id as id from accounting_periods where org_id = ${args.orgId} limit 1
    `)
    const calendarId = calendar.rows[0]?.id
    if (!calendarId) throw new Error('scratch organization has no fiscal calendar')
    const covering = await db.execute<{ id: string }>(sql`
      select id from accounting_periods
       where org_id = ${args.orgId} and fiscal_calendar_id = ${calendarId}
         and not is_adjustment and starts_on <= ${args.reversalDate} and ends_on >= ${args.reversalDate}
       limit 1
    `)
    if (covering.rows[0]) return
    const inserted = await db.execute<{ id: string }>(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values
        (${randomUUID()}, ${args.orgId}, ${year}, ${month}, ${args.reversalDate.slice(0, 7)},
         ${startsOn}, ${endsOn}, false, ${calendarId})
      returning id
    `)
    if (inserted.rows.length !== 1) throw new Error('the reversal period was not created')
  })
  const actorId = await withBypassContext(() =>
    createScratchUser(args.orgId, args.actorName, 'admin'),
  )
  const result = await requestDocumentVoid({
    documentId: args.documentId,
    orgId: args.orgId,
    actorId,
    reason: args.reason,
    reversalDate: args.reversalDate,
    source: 'api',
    allowedSubsidiaryIds: null,
  })
  if (result.status !== 'voided' || !result.reversalEntryId) {
    throw new Error('the scratch document did not complete its controlled void')
  }
  const persisted = await withBypassContext(() => db.execute<{ voidedDate: string }>(sql`
    select voided_at::date::text as "voidedDate"
      from documents where org_id = ${args.orgId} and id = ${args.documentId}
  `))
  const voidedDate = persisted.rows[0]?.voidedDate
  if (!voidedDate) throw new Error('the controlled void did not persist its event date')
  return { actorId, reversalEntryId: result.reversalEntryId, voidedDate }
}

export function voidReportDocument(orgId: string, documentId: string, reversalDate: string) {
  return voidScratchDocument({
    orgId,
    documentId,
    actorName: 'Report Void Operator',
    reason: 'Document was entered in error',
    reversalDate,
  })
}
