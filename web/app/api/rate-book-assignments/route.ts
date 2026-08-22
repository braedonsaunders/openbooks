import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { can, guardPermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { isUuid } from '../../../lib/list-params'

export const runtime = 'nodejs'

type AssignmentInput = {
  id?: unknown
  rateBookId?: unknown
  customerId?: unknown
  projectId?: unknown
  effectiveFrom?: unknown
  effectiveTo?: unknown
  dateBasis?: unknown
  isActive?: unknown
}

function dateValue(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  const text = String(value)
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? text : undefined
}

async function projectGate(permission: 'projects.read' | 'projects.manage') {
  const gate = await guardPermission(permission)
  if (gate instanceof NextResponse) return gate
  if (!(await isFeatureEnabled(gate.user.orgId, 'projects'))) {
    return NextResponse.json({ errorCode: 'notFound' }, { status: 404 })
  }
  return gate
}

/** Labor Pricing assignments embedded on customer and project records. */
export async function GET(req: Request) {
  const gate = await projectGate('projects.read')
  if (gate instanceof NextResponse) return gate
  const { orgId } = gate.user
  const today = await businessToday(orgId)
  const url = new URL(req.url)
  const customerId = url.searchParams.get('customerId')
  const projectId = url.searchParams.get('projectId')
  if ((customerId && projectId) || (!customerId && !projectId)) {
    return NextResponse.json({ errorCode: 'scope' }, { status: 400 })
  }
  const scopeId = (customerId ?? projectId)!
  if (!isUuid(scopeId)) return NextResponse.json({ errorCode: 'notFound' }, { status: 404 })
  const scope = customerId ? sql`a.customer_id = ${scopeId}` : sql`a.project_id = ${scopeId}`
  const q = (url.searchParams.get('q') ?? '').trim().slice(0, 120)
  const status = url.searchParams.get('status') === 'inactive' ? 'inactive' : url.searchParams.get('status') === 'all' ? 'all' : 'active'
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
  const perPage = 5
  const search = q ? sql`and (b.name ilike ${`%${q}%`} or b.code ilike ${`%${q}%`} or b.currency ilike ${`%${q}%`})` : sql``
  const statusFilter = status === 'all' ? sql`` : status === 'active' ? sql`and a.is_active` : sql`and not a.is_active`

  const [rateBooks, assignments, count] = await Promise.all([
    db.execute(sql`
      select b.id, b.name, b.currency, b.is_default,
             (select v.id from item_rate_versions v
               join labor_rate_version_policies p on p.version_id = v.id and p.org_id = v.org_id
              where v.rate_book_id = b.id and v.org_id = ${orgId}
              order by (v.effective_from <= ${today} and (v.effective_to is null or v.effective_to >= ${today})) desc,
                       v.effective_from desc limit 1) as latest_version_id
        from item_rate_books b
       where b.org_id = ${orgId} and b.is_active
         and exists (select 1 from item_rate_versions v join labor_rate_version_policies p on p.version_id = v.id and p.org_id = v.org_id where v.rate_book_id = b.id and v.org_id = b.org_id)
       order by b.is_default desc, b.name`) as any,
    db.execute(sql`
      select a.id, a.rate_book_id, b.name as rate_book_name, b.currency,
             a.effective_from, a.effective_to, a.date_basis, a.is_active,
             coalesce(a.rate_version_id,
               (select v.id from item_rate_versions v
                 join labor_rate_version_policies p on p.version_id = v.id and p.org_id = v.org_id
                where v.rate_book_id = b.id and v.org_id = ${orgId}
                order by (v.effective_from <= ${today} and (v.effective_to is null or v.effective_to >= ${today})) desc,
                         v.effective_from desc limit 1)) as rate_version_id
        from item_rate_book_assignments a
        join item_rate_books b on b.id = a.rate_book_id and b.org_id = a.org_id
       where a.org_id = ${orgId} and ${scope} ${statusFilter} ${search}
         and exists (select 1 from item_rate_versions v join labor_rate_version_policies p on p.version_id = v.id and p.org_id = v.org_id where v.rate_book_id = b.id and v.org_id = b.org_id)
       order by a.is_active desc, a.effective_from desc nulls last, b.name
       limit ${perPage} offset ${(page - 1) * perPage}`) as any,
    db.execute(sql`
      select count(*)::int as n
        from item_rate_book_assignments a join item_rate_books b on b.id = a.rate_book_id and b.org_id = a.org_id
       where a.org_id = ${orgId} and ${scope} ${statusFilter} ${search}
         and exists (select 1 from item_rate_versions v join labor_rate_version_policies p on p.version_id = v.id and p.org_id = v.org_id where v.rate_book_id = b.id and v.org_id = b.org_id)`) as any,
  ])
  return NextResponse.json({
    rateBooks: rateBooks.rows,
    assignments: assignments.rows,
    total: Number(count.rows[0]?.n ?? 0),
    page,
    perPage,
    canManage: can(gate, 'projects.manage'),
    canOpenPricing: can(gate, 'admin.setup.manage'),
  })
}

async function normalizedInput(body: AssignmentInput, orgId: string, rowId?: string) {
  let values = body
  if (rowId) {
    const current = (await db.execute(sql`
      select rate_book_id as "rateBookId", customer_id as "customerId", project_id as "projectId",
             effective_from as "effectiveFrom", effective_to as "effectiveTo", date_basis as "dateBasis",
             is_active as "isActive"
        from item_rate_book_assignments where id = ${rowId} and org_id = ${orgId}`)) as any
    if (!current.rows[0]) return { errorCode: 'save' } as const
    values = { ...current.rows[0], ...body }
  }
  const rateBookId = String(values.rateBookId ?? '')
  const customerId = values.customerId ? String(values.customerId) : null
  const projectId = values.projectId ? String(values.projectId) : null
  const effectiveFrom = dateValue(values.effectiveFrom)
  const effectiveTo = dateValue(values.effectiveTo)
  const dateBasis = String(values.dateBasis ?? 'usage_date')
  const isActive = values.isActive !== false
  if (!isUuid(rateBookId) || (customerId && !isUuid(customerId)) || (projectId && !isUuid(projectId))) return { errorCode: 'invalidRecord' } as const
  if ((customerId && projectId) || (!customerId && !projectId)) return { errorCode: 'scope' } as const
  if (effectiveFrom === undefined || effectiveTo === undefined) return { errorCode: 'dates' } as const
  if (effectiveFrom && effectiveTo && effectiveTo < effectiveFrom) return { errorCode: 'dateOrder' } as const
  if (dateBasis !== 'usage_date' && dateBasis !== 'project_start') return { errorCode: 'dateBasis' } as const
  const refs = (await db.execute(sql`
    select
      exists(select 1 from item_rate_books b where b.id = ${rateBookId} and b.org_id = ${orgId}
        and exists (select 1 from item_rate_versions v join labor_rate_version_policies p on p.version_id = v.id and p.org_id = v.org_id where v.rate_book_id = b.id and v.org_id = b.org_id)) as book_ok,
      ${customerId ? sql`exists(select 1 from customer_roles where party_id = ${customerId} and org_id = ${orgId} and is_active)` : sql`true`} as customer_ok,
      ${projectId ? sql`exists(select 1 from projects where id = ${projectId} and org_id = ${orgId})` : sql`true`} as project_ok`)) as any
  if (!refs.rows[0]?.book_ok || !refs.rows[0]?.customer_ok || !refs.rows[0]?.project_ok) return { errorCode: 'references' } as const
  const scope = projectId ? sql`project_id = ${projectId}` : sql`customer_id = ${customerId}`
  const overlap = (await db.execute(sql`
    select 1 from item_rate_book_assignments
     where org_id = ${orgId} and id is distinct from ${rowId ?? null} and is_active and ${scope}
       and daterange(effective_from, effective_to, '[]') && daterange(${effectiveFrom}::date, ${effectiveTo}::date, '[]')
     limit 1`)) as any
  if (isActive && overlap.rows.length) return { errorCode: 'overlap' } as const
  return { values: { rateBookId, customerId, projectId, effectiveFrom, effectiveTo, dateBasis, isActive } } as const
}

export async function POST(req: Request) {
  const gate = await projectGate('projects.manage')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json().catch(() => ({}))) as AssignmentInput
  const parsed = await normalizedInput(body, gate.user.orgId)
  if ('errorCode' in parsed) return NextResponse.json({ errorCode: parsed.errorCode }, { status: 400 })
  const v = parsed.values
  const inserted = (await db.execute(sql`
    insert into item_rate_book_assignments
      (org_id, rate_book_id, customer_id, project_id, effective_from, effective_to, date_basis, is_active, created_by, updated_by)
    values (${gate.user.orgId}, ${v.rateBookId}, ${v.customerId}, ${v.projectId}, ${v.effectiveFrom}, ${v.effectiveTo}, ${v.dateBasis}, ${v.isActive}, ${gate.user.id}, ${gate.user.id})
    returning id`)) as any
  const id = String(inserted.rows[0].id)
  await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${gate.user.orgId}, 'item_rate_book_assignments', ${id}, 'insert', ${JSON.stringify(v)}, ${gate.user.id})`)
  return NextResponse.json({ id })
}

export async function PATCH(req: Request) {
  const gate = await projectGate('projects.manage')
  if (gate instanceof NextResponse) return gate
  const body = (await req.json().catch(() => ({}))) as AssignmentInput
  const id = String(body.id ?? '')
  if (!isUuid(id)) return NextResponse.json({ errorCode: 'save' }, { status: 404 })
  const parsed = await normalizedInput(body, gate.user.orgId, id)
  if ('errorCode' in parsed) return NextResponse.json({ errorCode: parsed.errorCode }, { status: parsed.errorCode === 'save' ? 404 : 400 })
  const v = parsed.values
  await db.execute(sql`update item_rate_book_assignments set rate_book_id = ${v.rateBookId}, customer_id = ${v.customerId},
    project_id = ${v.projectId}, effective_from = ${v.effectiveFrom}, effective_to = ${v.effectiveTo}, date_basis = ${v.dateBasis},
    is_active = ${v.isActive}, updated_at = now(), updated_by = ${gate.user.id} where id = ${id} and org_id = ${gate.user.orgId}`)
  await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${gate.user.orgId}, 'item_rate_book_assignments', ${id}, 'update', ${JSON.stringify(v)}, ${gate.user.id})`)
  return NextResponse.json({ id })
}

export async function DELETE(req: Request) {
  const gate = await projectGate('projects.manage')
  if (gate instanceof NextResponse) return gate
  const id = new URL(req.url).searchParams.get('id') ?? ''
  if (!isUuid(id)) return NextResponse.json({ errorCode: 'save' }, { status: 404 })
  const removed = (await db.execute(sql`delete from item_rate_book_assignments where id = ${id} and org_id = ${gate.user.orgId} returning id`)) as any
  if (!removed.rows.length) return NextResponse.json({ errorCode: 'save' }, { status: 404 })
  await db.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${gate.user.orgId}, 'item_rate_book_assignments', ${id}, 'delete', ${JSON.stringify({ deleted: true })}, ${gate.user.id})`)
  return NextResponse.json({ ok: true })
}
