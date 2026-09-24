import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { businessToday, isIsoCalendarDate } from '@openbooks/engine/src/platform/business-date.ts'
import { db } from '@openbooks/engine/src/platform/db.ts'
import {
  lockProjectForScope,
  ScopeNotFoundError,
  withScopeSnapshot,
} from '@openbooks/engine/src/organization/subsidiary-scope.ts'
import { can, guardPermission, guardSubsidiaryScope, type Authz } from '../../../lib/authz'
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
  // Strict calendar validation: V8's Date.parse rolls February 30 into
  // March, which would pass a naive guard and reach the daterange cast as a
  // 22008 from PostgreSQL (a 500 path) instead of the dates domain error.
  return isIsoCalendarDate(text) ? text : undefined
}

async function projectGate(permission: 'projects.read' | 'projects.manage') {
  const gate = await guardPermission(permission)
  if (gate instanceof NextResponse) return gate
  if (!(await isFeatureEnabled(gate.user.orgId, 'projects'))) {
    return NextResponse.json({ errorCode: 'notFound' }, { status: 404 })
  }
  // Only an explicit null is unrestricted — an absent scope fails closed.
  // Nullish coalescing would collapse null into the empty set, so the
  // undefined check is explicit.
  if (gate.allowedSubsidiaryIds === undefined) {
    return { ...gate, allowedSubsidiaryIds: new Set<string>() }
  }
  return gate
}

/** Uniform not-found for record-level scope denials on this surface. */
function scopeNotFound() {
  return NextResponse.json({ errorCode: 'notFound' }, { status: 404 })
}

/** Labor Pricing assignments embedded on customer and project records. */
export async function GET(req: Request) {
  const gate = await projectGate('projects.read')
  if (gate instanceof NextResponse) return gate
  const { orgId } = gate.user
  const url = new URL(req.url)
  const customerId = url.searchParams.get('customerId')
  const projectId = url.searchParams.get('projectId')
  if ((customerId && projectId) || (!customerId && !projectId)) {
    return NextResponse.json({ errorCode: 'scope' }, { status: 400 })
  }
  const scopeId = (customerId ?? projectId)!
  if (!isUuid(scopeId)) return NextResponse.json({ errorCode: 'notFound' }, { status: 404 })
  const unrestricted = gate.allowedSubsidiaryIds === null
  // Assignments price the customer or project they hang off, so they
  // scope by that record: the project's subsidiary strictly, the
  // customer's party subsidiary under the shared-party policy (a
  // null-subsidiary party is org-wide, never private). A restricted caller
  // probing a hidden or missing record reads the same uniform not-found.
  // Everything below runs in one repeatable-read snapshot with the scope
  // predicate on each query, so a concurrent rehome cannot move rows
  // between the visibility check and the list.
  return withScopeSnapshot(orgId, async () => {
    const today = await businessToday(orgId)
    if (!unrestricted) {
      if (customerId) {
        const party = (await db.execute<{ subsidiaryId: string | null }>(sql`
          select p.subsidiary_id as "subsidiaryId"
            from parties p
           where p.org_id = ${orgId} and p.id = ${scopeId}
             and exists (select 1 from customer_roles
                          where party_id = ${scopeId} and org_id = ${orgId} and is_active)`)).rows[0]
        if (!party || guardSubsidiaryScope(gate, party.subsidiaryId, { orgWideNull: true })) {
          return scopeNotFound()
        }
      } else {
        const project = (await db.execute<{ subsidiaryId: string | null }>(sql`
          select subsidiary_id as "subsidiaryId"
            from projects where org_id = ${orgId} and id = ${scopeId}`)).rows[0]
        if (!project || guardSubsidiaryScope(gate, project.subsidiaryId)) {
          return scopeNotFound()
        }
      }
    }
    const scope = customerId ? sql`a.customer_id = ${scopeId}` : sql`a.project_id = ${scopeId}`
    const q = (url.searchParams.get('q') ?? '').trim().slice(0, 120)
    const status = url.searchParams.get('status') === 'inactive' ? 'inactive' : url.searchParams.get('status') === 'all' ? 'all' : 'active'
    const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1)
    const perPage = 5
    const search = q ? sql`and (b.name ilike ${`%${q}%`} or b.code ilike ${`%${q}%`} or b.currency ilike ${`%${q}%`})` : sql``
    const statusFilter = status === 'all' ? sql`` : status === 'active' ? sql`and a.is_active` : sql`and not a.is_active`

    // Sequential: the snapshot holds one connection, and overlapping
    // queries on it are deprecated by the driver.
    const rateBooks = await db.execute(sql`
      select b.id, b.name, b.currency, b.is_default,
             (select v.id from item_rate_versions v
               join labor_rate_version_policies p on p.version_id = v.id and p.org_id = v.org_id
              where v.rate_book_id = b.id and v.org_id = ${orgId}
              order by (v.effective_from <= ${today} and (v.effective_to is null or v.effective_to >= ${today})) desc,
                       v.effective_from desc limit 1) as latest_version_id
        from item_rate_books b
       where b.org_id = ${orgId} and b.is_active
         and exists (select 1 from item_rate_versions v join labor_rate_version_policies p on p.version_id = v.id and p.org_id = v.org_id where v.rate_book_id = b.id and v.org_id = b.org_id)
       order by b.is_default desc, b.name`)
    const assignments = await db.execute(sql`
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
       limit ${perPage} offset ${(page - 1) * perPage}`)
    const count = await db.execute(sql`
      select count(*)::int as n
        from item_rate_book_assignments a join item_rate_books b on b.id = a.rate_book_id and b.org_id = a.org_id
       where a.org_id = ${orgId} and ${scope} ${statusFilter} ${search}
         and exists (select 1 from item_rate_versions v join labor_rate_version_policies p on p.version_id = v.id and p.org_id = v.org_id where v.rate_book_id = b.id and v.org_id = b.org_id)`)
    return NextResponse.json({
      rateBooks: rateBooks.rows,
      assignments: assignments.rows,
      total: Number(count.rows[0]?.n ?? 0),
      page,
      perPage,
      canManage: can(gate, 'projects.manage'),
      canOpenPricing: can(gate, 'admin.setup.manage'),
    })
  })
}

type SqlExecutor = Pick<typeof db, 'execute'>

function postgresErrorCode(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Prove an assignment's customer/project visible to the caller, locking the
 * parent rows so a concurrent rehome cannot move the assignment between
 * the check and the write. Scope only — record validity (an active
 * customer role, a priced book) stays in the refs check below, exactly as
 * before. Returns 'missing' when the record is absent, 'hidden' when it
 * sits outside the caller's subsidiaries, and 'visible' otherwise.
 * Projects scope strictly; parties scope under the shared-party policy
 * (null-subsidiary parties are org-wide, never private).
 */
async function assignmentParentVisibility(
  tx: SqlExecutor,
  orgId: string,
  gate: Authz,
  scope: ReadonlySet<string> | null,
  customerId: string | null,
  projectId: string | null,
): Promise<'visible' | 'missing' | 'hidden'> {
  if (customerId) {
    const party = (await tx.execute<{ subsidiaryId: string | null }>(sql`
      select p.subsidiary_id as "subsidiaryId"
        from parties p
       where p.org_id = ${orgId} and p.id = ${customerId}
       for share of p`)).rows[0]
    if (!party) return 'missing'
    return guardSubsidiaryScope(gate, party.subsidiaryId, { orgWideNull: true }) ? 'hidden' : 'visible'
  }
  if (projectId) {
    try {
      await lockProjectForScope(tx, orgId, projectId, scope, 'share')
    } catch (error) {
      if (error instanceof ScopeNotFoundError) {
        // Missing and hidden are indistinguishable under the lock; the
        // caller maps them uniformly below.
        return 'missing'
      }
      throw error
    }
    return 'visible'
  }
  return 'missing'
}

async function normalizedInput(
  body: AssignmentInput,
  orgId: string,
  gate: Authz,
  allowed: ReadonlySet<string> | null,
  rowId: string | undefined,
  tx: SqlExecutor,
) {
  const unrestricted = allowed === null
  let values = body
  if (rowId) {
    const current = ((await tx.execute(sql`
      select rate_book_id as "rateBookId", customer_id as "customerId", project_id as "projectId",
             effective_from as "effectiveFrom", effective_to as "effectiveTo", date_basis as "dateBasis",
             is_active as "isActive"
        from item_rate_book_assignments where id = ${rowId} and org_id = ${orgId} for update`)))
    if (!current.rows[0]) return { errorCode: 'save' } as const
    values = { ...current.rows[0], ...body }
    // The stored row's own customer/project must already be visible — a
    // restricted caller alters only their own subsidiaries' pricing, and
    // the uniform 'save' answers exactly like a missing row. An
    // unrestricted caller keeps the existing references remedy for a
    // stored record that is gone or no longer an active customer.
    const stored = await assignmentParentVisibility(
      tx, orgId, gate, allowed,
      current.rows[0].customerId ? String(current.rows[0].customerId) : null,
      current.rows[0].projectId ? String(current.rows[0].projectId) : null,
    )
    if (stored === 'hidden') return { errorCode: 'save' } as const
    if (stored === 'missing') {
      if (unrestricted) return { errorCode: 'references' } as const
      return { errorCode: 'save' } as const
    }
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
  // The requested customer/project must be visible first: a restricted
  // caller probing a hidden or missing record reads the same uniform
  // not-found, while an unrestricted caller is unaffected. Visibility runs
  // before validity so a hidden record never falls through to the
  // references remedy below (which would oracle its absence).
  const requested = await assignmentParentVisibility(tx, orgId, gate, allowed, customerId, projectId)
  if (requested !== 'visible') {
    if (unrestricted) return { errorCode: 'references' } as const
    return { errorCode: 'notFound' } as const
  }
  // Record validity, unchanged: the book is org-wide pricing configuration
  // with no subsidiary of its own, and the customer role must be active —
  // both refuse by name for every caller alike. A restricted caller never
  // reaches here with a hidden record (proven visible above), so these
  // remedies cannot oracle another subsidiary's rows.
  const refs = ((await tx.execute(sql`
    select
      exists(select 1 from item_rate_books b where b.id = ${rateBookId} and b.org_id = ${orgId}
        and exists (select 1 from item_rate_versions v join labor_rate_version_policies p on p.version_id = v.id and p.org_id = v.org_id where v.rate_book_id = b.id and v.org_id = b.org_id)) as book_ok,
      ${customerId ? sql`exists(select 1 from customer_roles where party_id = ${customerId} and org_id = ${orgId} and is_active)` : sql`true`} as customer_ok,
      ${projectId ? sql`exists(select 1 from projects where id = ${projectId} and org_id = ${orgId})` : sql`true`} as project_ok`)))
  if (!refs.rows[0]?.book_ok || !refs.rows[0]?.customer_ok || !refs.rows[0]?.project_ok) return { errorCode: 'references' } as const
  const scope = projectId ? sql`project_id = ${projectId}` : sql`customer_id = ${customerId}`
  const overlap = ((await tx.execute(sql`
    select 1 from item_rate_book_assignments
     where org_id = ${orgId} and id is distinct from ${rowId ?? null} and is_active and ${scope}
       and daterange(coalesce(effective_from, '-infinity'::date), effective_to, '[]') &&
           daterange(coalesce(${effectiveFrom}::date, '-infinity'::date), ${effectiveTo}::date, '[]')
     limit 1`)))
  if (isActive && overlap.rows.length) return { errorCode: 'overlap' } as const
  return { values: { rateBookId, customerId, projectId, effectiveFrom, effectiveTo, dateBasis, isActive } } as const
}

export async function POST(req: Request) {
  const gate = await projectGate('projects.manage')
  if (gate instanceof NextResponse) return gate
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  const body = (parsedBody.data) as AssignmentInput
  try {
    const outcome = await db.transaction(async (tx) => {
      const parsed = await normalizedInput(body, gate.user.orgId, gate, gate.allowedSubsidiaryIds, undefined, tx)
      if ('errorCode' in parsed) return parsed
      const v = parsed.values
      const inserted = await tx.execute(sql`
        insert into item_rate_book_assignments
          (org_id, rate_book_id, customer_id, project_id, effective_from, effective_to, date_basis, is_active, created_by, updated_by)
        values (${gate.user.orgId}, ${v.rateBookId}, ${v.customerId}, ${v.projectId}, ${v.effectiveFrom}, ${v.effectiveTo}, ${v.dateBasis}, ${v.isActive}, ${gate.user.id}, ${gate.user.id})
        returning *`)
      const after = inserted.rows[0]
      if (!after) throw new Error('rate-book assignment insert returned no row')
      const id = String(after.id)
      await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.user.orgId}, 'item_rate_book_assignments', ${id}, 'insert', ${JSON.stringify({ before: null, after })}::jsonb, ${gate.user.id})`)
      return { id } as const
    })
    if (!('id' in outcome)) {
      return outcome.errorCode === 'notFound'
        ? scopeNotFound()
        : NextResponse.json({ errorCode: outcome.errorCode }, { status: 400 })
    }
    return NextResponse.json({ id: outcome.id })
  } catch (error) {
    if (postgresErrorCode(error) === '23P01') {
      return NextResponse.json({ errorCode: 'overlap' }, { status: 400 })
    }
    throw error
  }
}

export async function PATCH(req: Request) {
  const gate = await projectGate('projects.manage')
  if (gate instanceof NextResponse) return gate
  const parsedBody2 = await parseJsonBody(req, jsonObject);
  if (!parsedBody2.ok) return parsedBody2.response;
  const body = (parsedBody2.data) as AssignmentInput
  const id = String(body.id ?? '')
  if (!isUuid(id)) return NextResponse.json({ errorCode: 'save' }, { status: 404 })
  try {
    const outcome = await db.transaction(async (tx) => {
      const parsed = await normalizedInput(body, gate.user.orgId, gate, gate.allowedSubsidiaryIds, id, tx)
      if ('errorCode' in parsed) return parsed
      const v = parsed.values
      const before = (await tx.execute(sql`
        select * from item_rate_book_assignments where id = ${id} and org_id = ${gate.user.orgId} for update`)).rows[0]
      if (!before) return { errorCode: 'save' } as const
      const updated = (await tx.execute(sql`update item_rate_book_assignments set rate_book_id = ${v.rateBookId}, customer_id = ${v.customerId},
        project_id = ${v.projectId}, effective_from = ${v.effectiveFrom}, effective_to = ${v.effectiveTo}, date_basis = ${v.dateBasis},
        is_active = ${v.isActive}, updated_at = now(), updated_by = ${gate.user.id} where id = ${id} and org_id = ${gate.user.orgId}
        returning *`)).rows[0]
      if (!updated) throw new Error('rate-book assignment update returned no row')
      await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${gate.user.orgId}, 'item_rate_book_assignments', ${id}, 'update', ${JSON.stringify({ before, after: updated })}::jsonb, ${gate.user.id})`)
      return { id } as const
    })
    if (!('id' in outcome)) {
      const status = outcome.errorCode === 'save' || outcome.errorCode === 'notFound' ? 404 : 400
      return NextResponse.json({ errorCode: outcome.errorCode }, { status })
    }
    return NextResponse.json({ id: outcome.id })
  } catch (error) {
    if (postgresErrorCode(error) === '23P01') {
      return NextResponse.json({ errorCode: 'overlap' }, { status: 400 })
    }
    throw error
  }
}

export async function DELETE(req: Request) {
  const gate = await projectGate('projects.manage')
  if (gate instanceof NextResponse) return gate
  const id = new URL(req.url).searchParams.get('id') ?? ''
  if (!isUuid(id)) return NextResponse.json({ errorCode: 'save' }, { status: 404 })
  const outcome = await db.transaction(async (tx) => {
    const before = (await tx.execute(sql`
      select * from item_rate_book_assignments where id = ${id} and org_id = ${gate.user.orgId} for update`)).rows[0] as
      | { customer_id: string | null; project_id: string | null }
      | undefined
    if (!before) return { errorCode: 'save' } as const
    // A restricted caller deletes only their own subsidiaries' pricing —
    // the uniform 'save' answers exactly like a missing row.
    const stored = await assignmentParentVisibility(
      tx, gate.user.orgId, gate, gate.allowedSubsidiaryIds,
      before.customer_id ? String(before.customer_id) : null,
      before.project_id ? String(before.project_id) : null,
    )
    if (stored !== 'visible') return { errorCode: 'save' } as const
    const removed = (await tx.execute(sql`delete from item_rate_book_assignments where id = ${id} and org_id = ${gate.user.orgId} returning id`)).rows[0]
    if (!removed) throw new Error('rate-book assignment delete returned no row')
    await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${gate.user.orgId}, 'item_rate_book_assignments', ${id}, 'delete', ${JSON.stringify({ before, after: null })}::jsonb, ${gate.user.id})`)
    return { ok: true } as const
  })
  if ('errorCode' in outcome) return NextResponse.json({ errorCode: outcome.errorCode }, { status: 404 })
  return NextResponse.json({ ok: true })
}
