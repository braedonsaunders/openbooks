import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

const PAGE_SIZE = 15
const KINDS = new Set(['task', 'call', 'event', 'email', 'note'])
const STATUSES = new Set(['planned', 'in_progress', 'completed', 'cancelled'])

/** Searchable, filtered CRM activity sublist for a customer flyout. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('crm.activities.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({}, { status: 404 })

  const party = (await db.execute(sql`
    select 1 from parties where id=${id} and org_id=${gate.user.orgId} limit 1`))
  if (!party.rows[0]) return NextResponse.json({}, { status: 404 })

  const url = new URL(request.url)
  const q = url.searchParams.get('q')?.trim().slice(0, 100) ?? ''
  const requestedKind = url.searchParams.get('kind') ?? ''
  const requestedStatus = url.searchParams.get('status') ?? ''
  const kind = KINDS.has(requestedKind) ? requestedKind : ''
  const status = STATUSES.has(requestedStatus) ? requestedStatus : ''
  const requestedPage = Number(url.searchParams.get('page') ?? '1')
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1

  const where = sql`a.org_id=${gate.user.orgId}
    and exists (
      select 1 from crm_activity_links l
       where l.org_id=a.org_id and l.activity_id=a.id
         and l.subject_kind='account' and l.subject_id=${id}
    )
    ${q ? sql`and (a.subject ilike ${`%${q}%`} or coalesce(a.body,'') ilike ${`%${q}%`})` : sql``}
    ${kind ? sql`and a.kind=${kind}` : sql``}
    ${status ? sql`and a.status=${status}` : sql``}`

  const [rows, total, filters] = (await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select a.id,a.kind,a.status,a.subject,coalesce(a.starts_at,a.due_at,a.created_at) activity_date
        from crm_activities a where ${where}
       order by coalesce(a.starts_at,a.due_at,a.created_at) desc,a.created_at desc
       limit ${PAGE_SIZE} offset ${(page - 1) * PAGE_SIZE}`),
    db.execute<Record<string, unknown>>(sql`select count(*)::int count from crm_activities a where ${where}`),
    db.execute<Record<string, unknown>>(sql`
      select array_remove(array_agg(distinct a.kind order by a.kind),null) kinds,
             array_remove(array_agg(distinct a.status order by a.status),null) statuses
        from crm_activities a
       where a.org_id=${gate.user.orgId}
         and exists (
           select 1 from crm_activity_links l
            where l.org_id=a.org_id and l.activity_id=a.id
              and l.subject_kind='account' and l.subject_id=${id}
         )`),
  ]))

  return NextResponse.json({
    rows: rows.rows,
    total: Number(total.rows[0]?.count ?? 0),
    page,
    perPage: PAGE_SIZE,
    kinds: filters.rows[0]?.kinds ?? [],
    statuses: filters.rows[0]?.statuses ?? [],
  })
}
