import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { fromUnits, toUnits } from '@openbooks/engine/src/money.ts'
import { guardPermission } from '../../../../../lib/authz'
import { isUuid } from '../../../../../lib/list-params'
import { parseImportFile } from '../../../../../lib/data-io/parse'
import type { ImportFormat } from '../../../../../lib/data-io/types'
import { BudgetMutationError, normalizeBudgetAmount, type BudgetCellInput } from '../../../../../lib/budget-mutations'

export const runtime = 'nodejs'

const FORMATS = ['csv', 'xlsx'] as const
const MAX_ROWS = 20_000

type Lookup = { id: string; key: string; name: string; type?: string }

function norm(value: unknown) {
  return String(value ?? '').trim().toLowerCase()
}

function lookup(rows: Lookup[]) {
  const map = new Map<string, string>()
  for (const row of rows) {
    if (row.key) map.set(norm(row.key), row.id)
    map.set(norm(row.name), row.id)
  }
  return map
}

function first(row: Record<string, unknown>, ...headers: string[]) {
  for (const header of headers) if (row[header] !== undefined) return row[header]
  return ''
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardPermission('budgets.manage')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
  const format = FORMATS.includes(body.format as any) ? body.format as ImportFormat : null
  if (!format) return NextResponse.json({ error: 'invalid_format' }, { status: 422 })
  const expectedRevision = Number(body.expectedRevision)
  if (!Number.isInteger(expectedRevision)) return NextResponse.json({ error: 'invalid_revision' }, { status: 422 })

  const parsed = await parseImportFile(format, {
    text: typeof body.text === 'string' ? body.text : undefined,
    base64: typeof body.base64 === 'string' ? body.base64 : undefined,
  })
  if (parsed.rows.length === 0) return NextResponse.json({ error: 'file_has_no_rows' }, { status: 422 })
  if (parsed.rows.length > MAX_ROWS) return NextResponse.json({ error: 'too_many_rows' }, { status: 422 })

  const scenarioResult = (await db.execute<{ fiscal_year: number; status: string; revision: number }>(sql`
    select fiscal_year, status, revision from budget_scenarios where id = ${id} and org_id = ${user.orgId}
  `))
  const scenario = scenarioResult.rows[0]
  if (!scenario) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (scenario.status !== 'draft') return NextResponse.json({ error: 'budget_is_locked' }, { status: 409 })

  const [accountsResult, periodsResult, departmentsResult, projectsResult, locationsResult, classesResult] = (await Promise.all([
    db.execute<Lookup>(sql`select id, coalesce(number, '') as key, name, type from accounts where org_id = ${user.orgId} and is_active and not is_summary`),
    db.execute<Lookup>(sql`select id, name as key, name from accounting_periods where org_id = ${user.orgId} and fiscal_year = ${scenario.fiscal_year} and not is_adjustment`),
    db.execute<Lookup>(sql`select id, coalesce(code, '') as key, name from departments where org_id = ${user.orgId} and is_active`),
    db.execute<Lookup>(sql`select id, coalesce(code, '') as key, name from projects where org_id = ${user.orgId} and is_active`),
    db.execute<Lookup>(sql`select id, coalesce(code, '') as key, name from locations where org_id = ${user.orgId} and is_active`),
    db.execute<Lookup>(sql`select id, coalesce(code, '') as key, name from classes where org_id = ${user.orgId} and is_active`),
  ]))
  const accounts = lookup(accountsResult.rows)
  const creditAccounts = new Set(accountsResult.rows.filter((row) => row.type === 'income' || row.type === 'income_other').map((row) => row.id))
  const periods = lookup(periodsResult.rows)
  const dimensions = {
    departmentId: lookup(departmentsResult.rows),
    projectId: lookup(projectsResult.rows),
    locationId: lookup(locationsResult.rows),
    classId: lookup(classesResult.rows),
  }

  const errors: { row: number; field: string; message: string }[] = []
  const cells: BudgetCellInput[] = []
  const seen = new Set<string>()
  parsed.rows.forEach((row, index) => {
    const rowNumber = index + 2
    const accountKey = first(row, 'Account Number', 'Account', 'accountNumber', 'account')
    const periodKey = first(row, 'Period', 'period')
    const accountId = accounts.get(norm(accountKey))
    const periodId = periods.get(norm(periodKey))
    if (!accountId) errors.push({ row: rowNumber, field: 'Account Number', message: 'unknown_account' })
    if (!periodId) errors.push({ row: rowNumber, field: 'Period', message: 'unknown_period' })

    const resolvedDims: Record<keyof typeof dimensions, string | null> = {
      departmentId: null,
      projectId: null,
      locationId: null,
      classId: null,
    }
    const dimHeaders: [keyof typeof dimensions, string][] = [
      ['departmentId', 'Department'],
      ['projectId', 'Project'],
      ['locationId', 'Location'],
      ['classId', 'Class'],
    ]
    for (const [key, header] of dimHeaders) {
      const raw = first(row, header, header.toLowerCase(), key)
      if (String(raw ?? '').trim()) {
        const resolved = dimensions[key].get(norm(raw))
        if (!resolved) errors.push({ row: rowNumber, field: header, message: 'unknown_dimension' })
        else resolvedDims[key] = resolved
      }
    }
    let amount = '0.0000'
    try {
      amount = normalizeBudgetAmount(first(row, 'Amount', 'amount'))
      if (accountId && creditAccounts.has(accountId)) amount = fromUnits(-toUnits(amount))
    } catch {
      errors.push({ row: rowNumber, field: 'Amount', message: 'invalid_amount' })
    }
    if (accountId && periodId) {
      const key = [accountId, periodId, ...Object.values(resolvedDims).map((value) => value ?? '')].join('|')
      if (seen.has(key)) errors.push({ row: rowNumber, field: 'Account Number', message: 'duplicate_cell' })
      seen.add(key)
      cells.push({
        accountId,
        periodId,
        ...resolvedDims,
        amount,
        note: String(first(row, 'Note', 'note') ?? '').trim().slice(0, 2_000) || null,
      })
    }
  })

  if (body.commit !== true || errors.length > 0) {
    return NextResponse.json({ valid: errors.length === 0, rows: parsed.rows.length, errors: errors.slice(0, 200), sample: cells.slice(0, 10) })
  }

  try {
    const result = await db.transaction(async (tx) => {
      const locked = (await tx.execute<{ status: string; revision: number }>(sql`
        select status, revision from budget_scenarios where id = ${id} and org_id = ${user.orgId} for update
      `))
      const current = locked.rows[0]
      if (!current) throw new BudgetMutationError('not_found', 404)
      if (current.status !== 'draft') throw new BudgetMutationError('budget_is_locked', 409)
      if (Number(current.revision) !== expectedRevision) throw new BudgetMutationError('revision_conflict', 409)

      const rows = cells.map((cell) => ({
        account_id: cell.accountId,
        period_id: cell.periodId,
        department_id: cell.departmentId,
        project_id: cell.projectId,
        location_id: cell.locationId,
        class_id: cell.classId,
        amount: cell.amount,
        note: cell.note ?? null,
      }))
      await tx.execute(sql`
        insert into budget_lines
          (org_id, scenario_id, account_id, period_id, department_id, project_id, location_id, class_id,
           amount, note, created_by, updated_by)
        select ${user.orgId}, ${id}, x.account_id, x.period_id, x.department_id, x.project_id, x.location_id,
               x.class_id, x.amount, x.note, ${user.id}, ${user.id}
          from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(
            account_id uuid, period_id uuid, department_id uuid, project_id uuid,
            location_id uuid, class_id uuid, amount numeric(19,4), note text
          )
         where x.amount <> 0 or x.note is not null
        on conflict on constraint budget_lines_cell do update set
          amount = excluded.amount, note = excluded.note, updated_at = now(), updated_by = excluded.updated_by
      `)
      await tx.execute(sql`
        delete from budget_lines bl using jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as x(
          account_id uuid, period_id uuid, department_id uuid, project_id uuid,
          location_id uuid, class_id uuid, amount numeric(19,4), note text
        )
        where bl.org_id = ${user.orgId} and bl.scenario_id = ${id}
          and x.amount = 0 and x.note is null
          and bl.account_id = x.account_id and bl.period_id = x.period_id
          and bl.department_id is not distinct from x.department_id
          and bl.project_id is not distinct from x.project_id
          and bl.location_id is not distinct from x.location_id
          and bl.class_id is not distinct from x.class_id
      `)
      const revision = expectedRevision + 1
      await tx.execute(sql`
        update budget_scenarios set revision = ${revision}, updated_at = now(), updated_by = ${user.id}
         where id = ${id} and org_id = ${user.orgId}
      `)
      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'budget_scenarios', ${id}, 'update',
          ${JSON.stringify({ source: `import:${format}`, revisionBefore: expectedRevision, revisionAfter: revision, cells: rows })}::jsonb,
          ${user.id})
      `)
      return { revision, imported: rows.length }
    })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof BudgetMutationError) return NextResponse.json({ error: error.message }, { status: error.status })
    throw error
  }
}
