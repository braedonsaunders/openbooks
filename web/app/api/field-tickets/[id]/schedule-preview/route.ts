import { z } from 'zod'
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { calendarDaysBetween, isIsoCalendarDate } from '@openbooks/engine/src/platform/civil-date.ts'
import { scheduledWork } from '@openbooks/engine/src/schedule-boards/prefill.ts'
import { defineRoute } from '@/lib/api/route'
import { guardSubsidiaryScope } from '@/lib/authz'
import { loadFieldTicket } from '@/lib/field-tickets'
import { notFound } from '@/lib/api/responses'

export const runtime = 'nodejs'

const querySchema = z.object({
  projectId: z.string().uuid(),
  from: z.string().refine(isIsoCalendarDate),
  through: z.string().refine(isIsoCalendarDate),
}).refine(({ from, through }) => isIsoCalendarDate(from) && isIsoCalendarDate(through)
  && through >= from && calendarDaysBetween(from, through) < 14)

/** Preview only: the ticket's revision-fenced grid save records actual work. */
export const GET = defineRoute({
  permission: 'time.manage',
  feature: 'fieldTickets',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ request, authz, params }) => {
    const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!parsed.success) return NextResponse.json({ error: 'Choose a project and a ticket period of at most fourteen days.' }, { status: 422 })
    const { projectId, from, through } = parsed.data
    const orgId = authz.user.orgId
    const ticket = await loadFieldTicket(orgId, params.id, { allowedSubsidiaryIds: authz.allowedSubsidiaryIds })
    if (ticket.status !== 'draft') return NextResponse.json({ error: 'Only draft field tickets can be filled from the schedule.' }, { status: 409 })
    const project = (await db.execute<{ subsidiary_id: string | null }>(sql`
      select subsidiary_id from projects where org_id = ${orgId} and id = ${projectId} and is_active
    `)).rows[0]
    if (!project) return notFound('record')
    const denied = guardSubsidiaryScope(authz, project.subsidiary_id)
    if (denied) return denied
    if (ticket.subsidiaryId && ticket.subsidiaryId !== project.subsidiary_id) return notFound('record')
    const scheduled = await scheduledWork({ orgId, use: 'fieldTickets', projectId, from, through })
    const timeTypes = (await db.execute<{ id: string; name: string }>(sql`
      select id, name from time_types where org_id = ${orgId} and is_active and show_on_field_ticket
        and classification = 'regular' and not exclude_from_wages order by name, id
    `)).rows
    if (scheduled.length > 0 && timeTypes.length === 0) {
      return NextResponse.json({ error: 'Set up an active regular time type shown on field tickets before filling from the schedule.' }, { status: 422 })
    }
    const workers = (await db.execute<{ id: string }>(sql`
      select p.id from parties p where p.org_id = ${orgId} and p.is_active
        ${project.subsidiary_id ? sql`and p.subsidiary_id = ${project.subsidiary_id}` : sql``}
        and exists (select 1 from employee_roles r where r.org_id = p.org_id and r.party_id = p.id and r.is_active)
    `)).rows
    const eligible = new Set(workers.map((worker) => worker.id))
    if (scheduled.some((work) => !eligible.has(work.workerPartyId))) {
      return NextResponse.json({ error: 'Some scheduled people are no longer active employees in this project’s legal entity. Update those bookings before filling the ticket.' }, { status: 422 })
    }
    return NextResponse.json({ scheduled, timeTypes })
  },
})
