import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'

export const BUDGET_KINDS = ['budget', 'forecast'] as const
export const BUDGET_STATUSES = ['draft', 'pending_approval', 'approved', 'archived'] as const
export const BUDGET_ACCOUNT_TYPES = [
  'income',
  'income_other',
  'cogs',
  'expense',
  'expense_other',
  'expense_deferred',
] as const

export type BudgetKind = (typeof BUDGET_KINDS)[number]
export type BudgetStatus = (typeof BUDGET_STATUSES)[number]

export type BudgetDimensions = {
  departmentId: string | null
  projectId: string | null
  locationId: string | null
  classId: string | null
}

export type BudgetScenario = {
  id: string
  name: string
  description: string | null
  fiscalYear: number
  kind: BudgetKind
  status: BudgetStatus
  revision: number
  bookId: string
  bookName: string
  bookCode: string
  submittedAt: string | null
  approvedAt: string | null
  updatedAt: string
}

export type BudgetPeriod = {
  id: string
  name: string
  periodNumber: number
  startsOn: string
  endsOn: string
}

export type BudgetAccount = {
  id: string
  number: string | null
  name: string
  type: string
}

export type BudgetLineValue = {
  id: string
  accountId: string
  periodId: string
  amount: string
  note: string | null
}

export type DimensionOption = { id: string; code: string | null; name: string }

export type BudgetWorkspace = {
  scenario: BudgetScenario
  periods: BudgetPeriod[]
  accounts: BudgetAccount[]
  lines: BudgetLineValue[]
  totalAccounts: number
  page: number
  perPage: number
  sliceTotal: string
  dimensions: {
    departments: DimensionOption[]
    projects: DimensionOption[]
    locations: DimensionOption[]
    classes: DimensionOption[]
  }
}

const accountTypesSql = sql.raw(`(${BUDGET_ACCOUNT_TYPES.map((t) => `'${t}'`).join(',')})`)

function dimensionWhere(alias: string, dims: BudgetDimensions) {
  const col = (name: string) => sql.raw(`${alias}.${name}`)
  return sql`${col('department_id')} is not distinct from ${dims.departmentId}
    and ${col('project_id')} is not distinct from ${dims.projectId}
    and ${col('location_id')} is not distinct from ${dims.locationId}
    and ${col('class_id')} is not distinct from ${dims.classId}`
}

export async function loadBudgetScenario(id: string, orgId: string): Promise<BudgetScenario | null> {
  const result = (await db.execute<Record<string, any>>(sql`
    select bs.id, bs.name, bs.description, bs.fiscal_year, bs.kind, bs.status,
           bs.revision, bs.book_id, b.name as book_name, b.code as book_code,
           bs.submitted_at, bs.approved_at, bs.updated_at
      from budget_scenarios bs
      join accounting_books b on b.id = bs.book_id and b.org_id = bs.org_id
     where bs.id = ${id} and bs.org_id = ${orgId}
  `))
  const row = result.rows[0]
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    fiscalYear: Number(row.fiscal_year),
    kind: row.kind,
    status: row.status,
    revision: Number(row.revision),
    bookId: row.book_id,
    bookName: row.book_name,
    bookCode: row.book_code,
    submittedAt: row.submitted_at ? new Date(row.submitted_at).toISOString() : null,
    approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null,
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}

/** Load one editable account page for a single dimensional worksheet slice. */
export async function loadBudgetWorkspace(
  id: string,
  orgId: string,
  opts: { q?: string; page: number; perPage: number; dims: BudgetDimensions },
): Promise<BudgetWorkspace | null> {
  const scenario = await loadBudgetScenario(id, orgId)
  if (!scenario) return null

  const search = opts.q?.trim()
  const accountWhere = sql`a.org_id = ${orgId} and a.is_active and not a.is_summary
    and a.type in ${accountTypesSql}
    ${search ? sql`and (a.name ilike ${`%${search}%`} or coalesce(a.number, '') ilike ${`%${search}%`})` : sql``}`

  const [periodRows, accountRows, accountCount, dimensions, total] = await Promise.all([
    db.execute(sql`
      select distinct on (p.period_number)
             p.id, p.name, p.period_number, p.starts_on, p.ends_on
        from accounting_periods p
        join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
       where p.org_id = ${orgId} and p.fiscal_year = ${scenario.fiscalYear} and not p.is_adjustment
       order by p.period_number, fc.is_default desc, p.starts_on
    `) as Promise<{ rows: Record<string, any>[] }>,
    db.execute(sql`
      select a.id, a.number, a.name, a.type
        from accounts a
       where ${accountWhere}
       order by a.number nulls last, a.name
       limit ${opts.perPage} offset ${(opts.page - 1) * opts.perPage}
    `) as Promise<{ rows: Record<string, any>[] }>,
    db.execute(sql`select count(*) as n from accounts a where ${accountWhere}`) as Promise<{
      rows: { n: string }[]
    }>,
    loadBudgetDimensionOptions(orgId),
    db.execute(sql`
      select coalesce(sum(case when a.type in ('income', 'income_other') then -bl.amount else bl.amount end), 0)::text as total
        from budget_lines bl
        join accounts a on a.id = bl.account_id and a.org_id = bl.org_id
       where bl.org_id = ${orgId} and bl.scenario_id = ${id}
         and ${dimensionWhere('bl', opts.dims)}
    `) as Promise<{ rows: { total: string }[] }>,
  ])

  const accountIds = accountRows.rows.map((row) => String(row.id))
  const lineRows = accountIds.length
    ? ((await db.execute<Record<string, any>>(sql`
        select bl.id, bl.account_id, bl.period_id, bl.amount::text, bl.note
          from budget_lines bl
         where bl.org_id = ${orgId} and bl.scenario_id = ${id}
           and bl.account_id = any(${`{${accountIds.join(',')}}`}::uuid[])
           and ${dimensionWhere('bl', opts.dims)}
      `))).rows
    : []

  return {
    scenario,
    periods: periodRows.rows.map((row) => ({
      id: row.id,
      name: row.name,
      periodNumber: Number(row.period_number),
      startsOn: String(row.starts_on),
      endsOn: String(row.ends_on),
    })),
    accounts: accountRows.rows.map((row) => ({
      id: row.id,
      number: row.number,
      name: row.name,
      type: row.type,
    })),
    lines: lineRows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      periodId: row.period_id,
      amount: row.amount,
      note: row.note,
    })),
    totalAccounts: Number(accountCount.rows[0]?.n ?? 0),
    page: opts.page,
    perPage: opts.perPage,
    sliceTotal: total.rows[0]?.total ?? '0.0000',
    dimensions,
  }
}

export async function loadBudgetDimensionOptions(orgId: string): Promise<BudgetWorkspace['dimensions']> {
  const [departments, projects, locations, classes] = (await Promise.all([
    db.execute<DimensionOption>(sql`select id, code, name from departments where org_id = ${orgId} and is_active order by code nulls last, name`),
    db.execute<DimensionOption>(sql`select id, code, name from projects where org_id = ${orgId} and is_active order by code nulls last, name`),
    db.execute<DimensionOption>(sql`select id, code, name from locations where org_id = ${orgId} and is_active order by code nulls last, name`),
    db.execute<DimensionOption>(sql`select id, code, name from classes where org_id = ${orgId} and is_active order by code nulls last, name`),
  ]))
  return {
    departments: departments.rows,
    projects: projects.rows,
    locations: locations.rows,
    classes: classes.rows,
  }
}

export async function loadBudgetBooksAndYears(orgId: string) {
  const [books, years] = await Promise.all([
    db.execute(sql`
      select id, code, name, is_primary from accounting_books
       where org_id = ${orgId} and is_active order by is_primary desc, name
    `) as Promise<{ rows: { id: string; code: string; name: string; is_primary: boolean }[] }>,
    db.execute(sql`
      select distinct fiscal_year from accounting_periods
       where org_id = ${orgId} order by fiscal_year desc
    `) as Promise<{ rows: { fiscal_year: number }[] }>,
  ])
  return { books: books.rows, years: years.rows.map((row) => Number(row.fiscal_year)) }
}
