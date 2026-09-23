import 'server-only'

import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { PNL_TYPES } from './account-types'

export const BUDGET_KINDS = ['budget', 'forecast'] as const
export const BUDGET_STATUSES = ['draft', 'pending_approval', 'approved', 'archived'] as const

export type BudgetKind = (typeof BUDGET_KINDS)[number]
export type BudgetStatus = (typeof BUDGET_STATUSES)[number]

export type BudgetDimensions = {
  /** Legal-entity slice. Null resolves to the tenant root (the default entity
   * everywhere else: import, save, and the storage trigger agree). */
  subsidiaryId: string | null
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
  /** Full cell identity: two subsidiaries can budget the same account/period. */
  subsidiaryId: string | null
  departmentId: string | null
  projectId: string | null
  locationId: string | null
  classId: string | null
  amount: string
  note: string | null
}

interface BudgetScenarioRow extends Record<string, unknown> {
  id: string
  name: string
  description: string | null
  fiscal_year: number
  kind: BudgetKind
  status: BudgetStatus
  revision: number
  book_id: string
  book_name: string
  book_code: string
  submitted_at: Date | null
  approved_at: Date | null
  updated_at: Date
}

interface BudgetPeriodRow extends Record<string, unknown> {
  id: string
  name: string
  period_number: number
  starts_on: string
  ends_on: string
}

interface BudgetWorkspaceAccountRow extends Record<string, unknown> {
  id: string
  number: string | null
  name: string
  type: string
}

interface BudgetWorkspaceLineRow extends Record<string, unknown> {
  id: string
  account_id: string
  period_id: string
  subsidiary_id: string | null
  department_id: string | null
  project_id: string | null
  location_id: string | null
  class_id: string | null
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
  /** The entity slice actually loaded (requested id, or the tenant root default). */
  effectiveSubsidiaryId: string | null
  dimensions: {
    subsidiaries: DimensionOption[]
    departments: DimensionOption[]
    projects: DimensionOption[]
    locations: DimensionOption[]
    classes: DimensionOption[]
  }
}

// The single P&L definition (engine records/account-types): the worksheet,
// import, line guard and variances all filter on exactly this list.
const accountTypesSql = sql.raw(`(${PNL_TYPES.map((t) => `'${t}'`).join(',')})`)

function dimensionWhere(alias: string, dims: BudgetDimensions) {
  const col = (name: string) => sql.raw(`${alias}.${name}`)
  return sql`${col('subsidiary_id')} is not distinct from ${dims.subsidiaryId}
    and ${col('department_id')} is not distinct from ${dims.departmentId}
    and ${col('project_id')} is not distinct from ${dims.projectId}
    and ${col('location_id')} is not distinct from ${dims.locationId}
    and ${col('class_id')} is not distinct from ${dims.classId}`
}

export async function loadBudgetScenario(id: string, orgId: string): Promise<BudgetScenario | null> {
  const result = (await db.execute<BudgetScenarioRow>(sql`
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

  // The entity slice defaults to the tenant root — the same default the
  // import, the save path and the storage trigger apply to an omitted
  // entity. Without this, one account/period cell would collapse every
  // subsidiary's line into a single input (and an edit would overwrite the
  // root line while the hidden entity lines still counted in totals).
  const rootSubsidiaryId = opts.dims.subsidiaryId ?? (await db.execute<{ id: string }>(sql`
    select id from subsidiaries
     where org_id = ${orgId}
       and parent_id is null and is_active and not is_elimination
     order by created_at, id
     limit 1
  `)).rows[0]?.id ?? null
  const dims: BudgetDimensions = { ...opts.dims, subsidiaryId: rootSubsidiaryId }

  const search = opts.q?.trim()
  const accountWhere = sql`a.org_id = ${orgId} and a.is_active and not a.is_summary
    and a.type in ${accountTypesSql}
    ${search ? sql`and (a.name ilike ${`%${search}%`} or coalesce(a.number, '') ilike ${`%${search}%`})` : sql``}`

  const [periodRows, accountRows, accountCount, dimensions, total] = await Promise.all([
    // A budget is pinned to ONE calendar — the org default. The line guard
    // admits default-calendar periods only, so the worksheet, the line query
    // and the totals below all read that same set: a line on another calendar
    // can be neither written nor hidden-yet-counted.
    db.execute<BudgetPeriodRow>(sql`
      select p.id, p.name, p.period_number, p.starts_on, p.ends_on
        from accounting_periods p
        join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
       where p.org_id = ${orgId} and p.fiscal_year = ${scenario.fiscalYear} and not p.is_adjustment
         and fc.is_default
       order by p.period_number
    `),
    db.execute<BudgetWorkspaceAccountRow>(sql`
      select a.id, a.number, a.name, a.type
        from accounts a
       where ${accountWhere}
       order by a.number nulls last, a.name
       limit ${opts.perPage} offset ${(opts.page - 1) * opts.perPage}
    `),
    db.execute(sql`select count(*) as n from accounts a where ${accountWhere}`) as Promise<{
      rows: { n: string }[]
    }>,
    loadBudgetDimensionOptions(orgId),
    db.execute(sql`
      select coalesce(sum(case when a.type in ('income', 'income_other') then -bl.amount else bl.amount end), 0)::text as total
        from budget_lines bl
        join accounts a on a.id = bl.account_id and a.org_id = bl.org_id
        join accounting_periods p on p.id = bl.period_id and p.org_id = bl.org_id
        join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
       where bl.org_id = ${orgId} and bl.scenario_id = ${id}
         and fc.is_default
         and ${dimensionWhere('bl', dims)}
    `) as Promise<{ rows: { total: string }[] }>,
  ])

  const accountIds = accountRows.rows.map((row) => String(row.id))
  const lineRows = accountIds.length
    ? ((await db.execute<BudgetWorkspaceLineRow>(sql`
        select bl.id, bl.account_id, bl.period_id, bl.subsidiary_id, bl.department_id,
               bl.project_id, bl.location_id, bl.class_id, bl.amount::text, bl.note
          from budget_lines bl
          join accounting_periods p on p.id = bl.period_id and p.org_id = bl.org_id
          join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
         where bl.org_id = ${orgId} and bl.scenario_id = ${id}
           and fc.is_default
           and bl.account_id = any(${`{${accountIds.join(',')}}`}::uuid[])
           and ${dimensionWhere('bl', dims)}
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
      subsidiaryId: row.subsidiary_id,
      departmentId: row.department_id,
      projectId: row.project_id,
      locationId: row.location_id,
      classId: row.class_id,
      amount: row.amount,
      note: row.note,
    })),
    totalAccounts: Number(accountCount.rows[0]?.n ?? 0),
    page: opts.page,
    perPage: opts.perPage,
    sliceTotal: total.rows[0]?.total ?? '0.0000',
    dimensions,
    effectiveSubsidiaryId: dims.subsidiaryId,
  }
}

export async function loadBudgetDimensionOptions(orgId: string): Promise<BudgetWorkspace['dimensions']> {
  const [subsidiaries, departments, projects, locations, classes] = (await Promise.all([
    db.execute<DimensionOption>(sql`select id, null as code, name from subsidiaries where org_id = ${orgId} and is_active and not is_elimination order by name`),
    db.execute<DimensionOption>(sql`select id, code, name from departments where org_id = ${orgId} and is_active order by code nulls last, name`),
    db.execute<DimensionOption>(sql`select id, code, name from projects where org_id = ${orgId} and is_active order by code nulls last, name`),
    db.execute<DimensionOption>(sql`select id, code, name from locations where org_id = ${orgId} and is_active order by code nulls last, name`),
    db.execute<DimensionOption>(sql`select id, code, name from classes where org_id = ${orgId} and is_active order by code nulls last, name`),
  ]))
  return {
    subsidiaries: subsidiaries.rows,
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
