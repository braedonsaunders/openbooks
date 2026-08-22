import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { db } from '@openbooks/engine/src/db.ts'
import { guardFeaturePermission } from '../../../../lib/feature-gates'
import { isUuid } from '../../../../lib/list-params'
import { BUDGET_KINDS } from '../../../../lib/budgets'

export const runtime = 'nodejs'

export async function POST(req: Request) {
  const gate = await guardFeaturePermission('budgets.manage', 'budgets')
  if (gate instanceof NextResponse) return gate
  const user = gate.user
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

  const requestedBook = typeof body.bookId === 'string' && isUuid(body.bookId) ? body.bookId : null
  const requestedYear = Number(body.fiscalYear)
  const kind = BUDGET_KINDS.includes(body.kind as any) ? (body.kind as string) : 'budget'
  const sourceScenarioId = typeof body.sourceScenarioId === 'string' && isUuid(body.sourceScenarioId) ? body.sourceScenarioId : null

  const today = await businessToday(user.orgId)
  const defaults = (await db.execute<{ book_id: string | null; fiscal_year: number | null }>(sql`
    select
      (select id from accounting_books
        where org_id = ${user.orgId} and is_active
        order by is_primary desc, name limit 1) as book_id,
      coalesce(
        (select fiscal_year from accounting_periods
          where org_id = ${user.orgId} and ${today}::date between starts_on and ends_on and not is_adjustment
          order by starts_on desc limit 1),
        (select max(fiscal_year) from accounting_periods where org_id = ${user.orgId})
      ) as fiscal_year
  `))
  const bookId = requestedBook ?? defaults.rows[0]?.book_id
  const fiscalYear = Number.isInteger(requestedYear) && requestedYear >= 1900 && requestedYear <= 9999
    ? requestedYear
    : Number(defaults.rows[0]?.fiscal_year)
  if (!bookId || !Number.isInteger(fiscalYear)) {
    return NextResponse.json({ error: 'configure_an_accounting_book_and_periods_first' }, { status: 409 })
  }

  const valid = (await db.execute(sql`
    select 1 from accounting_books where id = ${bookId} and org_id = ${user.orgId} and is_active
  `))
  const havePeriods = (await db.execute(sql`
    select 1 from accounting_periods
     where org_id = ${user.orgId} and fiscal_year = ${fiscalYear} and not is_adjustment limit 1
  `))
  if (!valid.rows[0] || !havePeriods.rows[0]) {
    return NextResponse.json({ error: 'invalid_book_or_fiscal_year' }, { status: 422 })
  }

  const requestedName = typeof body.name === 'string' ? body.name.trim().slice(0, 200) : ''
  const baseName = requestedName || `FY${fiscalYear} ${kind === 'forecast' ? 'Forecast' : 'Budget'}`

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${user.orgId}:${bookId}:${fiscalYear}:${kind}`}, 0))`)
      const names = (await tx.execute<{ name: string }>(sql`
        select name from budget_scenarios
         where org_id = ${user.orgId} and book_id = ${bookId} and fiscal_year = ${fiscalYear} and kind = ${kind}
           and (name = ${baseName} or name like ${`${baseName} (%`})
      `))
      const used = new Set(names.rows.map((row) => row.name))
      let name = baseName
      for (let i = 2; used.has(name); i++) name = `${baseName} (${i})`

      const inserted = (await tx.execute<{ id: string; revision: number }>(sql`
        insert into budget_scenarios
          (org_id, book_id, fiscal_year, name, kind, status, created_by, updated_by)
        values (${user.orgId}, ${bookId}, ${fiscalYear}, ${name}, ${kind}, 'draft', ${user.id}, ${user.id})
        returning id, revision
      `))
      const scenario = inserted.rows[0]!

      if (sourceScenarioId) {
        const source = (await tx.execute<{ id: string }>(sql`
          select id from budget_scenarios where id = ${sourceScenarioId} and org_id = ${user.orgId}
        `))
        if (!source.rows[0]) throw new Error('source_not_found')
        await tx.execute(sql`
          insert into budget_lines
            (org_id, scenario_id, account_id, period_id, department_id, project_id, location_id, class_id,
             amount, note, created_by, updated_by)
          select ${user.orgId}, ${scenario.id}, bl.account_id, destination.id,
                 bl.department_id, bl.project_id, bl.location_id, bl.class_id,
                 bl.amount, bl.note, ${user.id}, ${user.id}
            from budget_lines bl
            join accounting_periods source_period on source_period.id = bl.period_id
            join accounting_periods destination
              on destination.org_id = ${user.orgId}
             and destination.fiscal_calendar_id = source_period.fiscal_calendar_id
             and destination.fiscal_year = ${fiscalYear}
             and destination.period_number = source_period.period_number
           where bl.org_id = ${user.orgId} and bl.scenario_id = ${sourceScenarioId}
        `)
      }

      await tx.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${user.orgId}, 'budget_scenarios', ${scenario.id}, 'insert',
          ${JSON.stringify({ name, fiscalYear, bookId, kind, sourceScenarioId })}::jsonb, ${user.id})
      `)
      return scenario
    })
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof Error && error.message === 'source_not_found') {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    throw error
  }
}
