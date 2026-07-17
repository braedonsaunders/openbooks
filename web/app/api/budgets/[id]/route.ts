import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { guardPermission } from '../../../../lib/authz'
import { isUuid } from '../../../../lib/list-params'
import { BUDGET_KINDS, loadBudgetScenario } from '../../../../lib/budgets'
import { BudgetMutationError } from '../../../../lib/budget-mutations'

export const runtime = 'nodejs'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('budgets.read')
  if (gate instanceof NextResponse) return gate
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const scenario = await loadBudgetScenario(id, gate.user.orgId)
  return scenario ? NextResponse.json(scenario) : NextResponse.json({ error: 'not_found' }, { status: 404 })
}
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('budgets.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const expectedRevision = Number(body.expectedRevision)
  if (!Number.isInteger(expectedRevision)) return NextResponse.json({ error: 'invalid_revision' }, { status: 422 })

  const name = typeof body.name === 'string' ? body.name.trim() : undefined
  const description = body.description === null
    ? null
    : typeof body.description === 'string'
      ? body.description.trim().slice(0, 4_000) || null
      : undefined
  const kind = body.kind === undefined ? undefined : BUDGET_KINDS.includes(body.kind as any) ? body.kind as string : null
  const bookId = body.bookId === undefined ? undefined : typeof body.bookId === 'string' && isUuid(body.bookId) ? body.bookId : null
  const fiscalYearValue = Number(body.fiscalYear)
  const fiscalYear = body.fiscalYear === undefined
    ? undefined
    : Number.isInteger(fiscalYearValue) && fiscalYearValue >= 1900 && fiscalYearValue <= 9999
      ? fiscalYearValue
      : null
  if (name !== undefined && (name.length === 0 || name.length > 200)) {
    return NextResponse.json({ error: 'invalid_name' }, { status: 422 })
  }
  if (kind === null) return NextResponse.json({ error: 'invalid_kind' }, { status: 422 })
  if (bookId === null || fiscalYear === null) return NextResponse.json({ error: 'invalid_book_or_fiscal_year' }, { status: 422 })

  try {
    const result = await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        select name, description, kind, book_id, fiscal_year, status, revision,
               exists (select 1 from budget_lines where scenario_id = ${id} and org_id = ${user.orgId}) as has_lines
          from budget_scenarios where id = ${id} and org_id = ${user.orgId} for update
      `)) as unknown as { rows: Record<string, any>[] }
      const before = locked.rows[0]
      if (!before) throw new BudgetMutationError('not_found', 404)
      if (before.status !== 'draft') throw new BudgetMutationError('budget_is_locked', 409)
      if (Number(before.revision) !== expectedRevision) throw new BudgetMutationError('revision_conflict', 409)
      const nextBookId = bookId ?? before.book_id
      const nextFiscalYear = fiscalYear ?? Number(before.fiscal_year)
      const scopeChanged = nextBookId !== before.book_id || nextFiscalYear !== Number(before.fiscal_year)
      if (nextBookId !== before.book_id) {
        const validBook = (await tx.execute(sql`
          select 1 from accounting_books where id = ${nextBookId} and org_id = ${user.orgId} and is_active
        `)) as unknown as { rows: unknown[] }
        if (!validBook.rows[0]) throw new BudgetMutationError('invalid_book_or_fiscal_year')
      }
      if (nextFiscalYear !== Number(before.fiscal_year)) {
        if (before.has_lines) throw new BudgetMutationError('budget_scope_has_lines', 409)
        const validYear = (await tx.execute(sql`
          select 1 from accounting_periods
           where org_id = ${user.orgId} and fiscal_year = ${nextFiscalYear} and not is_adjustment limit 1
        `)) as unknown as { rows: unknown[] }
        if (!validYear.rows[0]) throw new BudgetMutationError('invalid_book_or_fiscal_year')
      }
      const nextRevision = expectedRevision + 1
      await tx.execute(sql`
        update budget_scenarios set
          name = ${name !== undefined ? name : sql`name`},
          description = ${description !== undefined ? description : sql`description`},
          kind = ${kind !== undefined ? kind : sql`kind`},
          book_id = ${nextBookId},
          fiscal_year = ${nextFiscalYear},
          revision = ${nextRevision}, updated_at = now(), updated_by = ${user.id}
        where id = ${id} and org_id = ${user.orgId}
      `)
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'budget_scenarios', ${id}, 'update',
          ${JSON.stringify({
            before: { name: before.name, description: before.description, kind: before.kind, bookId: before.book_id, fiscalYear: Number(before.fiscal_year) },
            after: { name: name ?? before.name, description: description === undefined ? before.description : description, kind: kind ?? before.kind, bookId: nextBookId, fiscalYear: nextFiscalYear },
            revisionBefore: expectedRevision,
            revisionAfter: nextRevision,
          })}::jsonb, ${user.id})
      `)
      return { revision: nextRevision, scopeChanged }
    })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof BudgetMutationError) return NextResponse.json({ error: error.message }, { status: error.status })
    const message = error instanceof Error ? `${error.message} ${String((error as any).cause ?? '')}` : String(error)
    if (message.includes('budget_scenarios_identity')) {
      return NextResponse.json({ error: 'scenario_name_already_exists' }, { status: 409 })
    }
    throw error
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('budgets.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  try {
    await db.transaction(async (tx) => {
      const locked = (await tx.execute(sql`
        select name, status, revision from budget_scenarios
         where id = ${id} and org_id = ${user.orgId} for update
      `)) as unknown as { rows: Record<string, any>[] }
      const row = locked.rows[0]
      if (!row) throw new BudgetMutationError('not_found', 404)
      if (row.status !== 'draft') throw new BudgetMutationError('only_drafts_can_be_deleted', 409)
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'budget_scenarios', ${id}, 'delete', ${JSON.stringify(row)}::jsonb, ${user.id})
      `)
      await tx.execute(sql`delete from budget_scenarios where id = ${id} and org_id = ${user.orgId}`)
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof BudgetMutationError) return NextResponse.json({ error: error.message }, { status: error.status })
    throw error
  }
}
