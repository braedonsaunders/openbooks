import { type NextRequest, NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { can, getAuthz } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'

const ACTIONS = ['insert', 'update', 'delete', 'post', 'void', 'approve', 'reject'] as const

function documentReadPermission(kind: string): string {
  if (kind === 'expense_report') return 'expenses.read'
  if (kind === 'journal' || kind === 'deposit' || kind === 'transfer') return 'gl.read'
  if (kind === 'customer_invoice' || kind === 'customer_credit' || kind === 'customer_payment'
    || kind === 'quote' || kind === 'sales_order') return 'ar.read'
  return 'ap.read'
}

export async function GET(request: NextRequest) {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const table = request.nextUrl.searchParams.get('table')
  const recordId = request.nextUrl.searchParams.get('id')
  if ((table !== 'documents' && table !== 'parties') || !recordId || !isUuid(recordId)) {
    return NextResponse.json({ error: 'invalid record' }, { status: 400 })
  }

  const record = table === 'documents'
    ? await db.execute(sql`
        select org_id, kind, created_at, created_by, updated_at, updated_by
          from documents where id = ${recordId} and org_id = ${authz.user.orgId}`) as any
    : await db.execute(sql`
        select org_id, 'party' as kind, created_at, created_by, updated_at, updated_by
          from parties where id = ${recordId} and org_id = ${authz.user.orgId}`) as any
  const metadata = record.rows[0]
  if (!metadata) return NextResponse.json({ error: 'not found' }, { status: 404 })
  const permission = table === 'parties' ? 'parties.read' : documentReadPermission(String(metadata.kind))
  if (!can(authz, permission)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const q = request.nextUrl.searchParams.get('q')?.trim().slice(0, 120) ?? ''
  const requestedAction = request.nextUrl.searchParams.get('action') ?? ''
  const action = (ACTIONS as readonly string[]).includes(requestedAction) ? requestedAction : ''
  const page = Math.max(1, Number.parseInt(request.nextUrl.searchParams.get('page') ?? '1', 10) || 1)
  const perPage = 15

  const events = sql`
    select a.id::text as id, a.action, a.changes, a.actor_id, a.at
      from audit_log a
     where a.org_id = ${authz.user.orgId} and a.table_name = ${table} and a.row_id = ${recordId}
    union all
    select ${`${recordId}:created`} as id, 'insert' as action,
           jsonb_build_object('source', 'record_metadata') as changes,
           ${metadata.created_by}::uuid as actor_id, ${metadata.created_at}::timestamptz as at
    union all
    select ${`${recordId}:updated`} as id, 'update' as action,
           jsonb_build_object('source', 'record_metadata') as changes,
           ${metadata.updated_by}::uuid as actor_id, ${metadata.updated_at}::timestamptz as at
     where ${metadata.updated_at}::timestamptz > ${metadata.created_at}::timestamptz + interval '1 second'
  `
  const filters = sql`
    ${action ? sql`and e.action = ${action}` : sql``}
    ${q ? sql`and (e.action ilike ${`%${q}%`} or coalesce(u.name, '') ilike ${`%${q}%`} or e.changes::text ilike ${`%${q}%`})` : sql``}
  `

  const [rows, count] = await Promise.all([
    db.execute(sql`
      with events as (${events})
      select e.id, e.action, e.changes, e.at, u.name as actor_name
        from events e left join users u on u.id = e.actor_id
       where true ${filters}
       order by e.at desc, e.id desc
       limit ${perPage} offset ${(page - 1) * perPage}`) as any,
    db.execute(sql`
      with events as (${events})
      select count(*) as n from events e left join users u on u.id = e.actor_id
       where true ${filters}`) as any,
  ])

  return NextResponse.json({
    rows: rows.rows,
    total: Number(count.rows[0]?.n ?? 0),
    page,
    perPage,
    actions: ACTIONS,
  })
}
