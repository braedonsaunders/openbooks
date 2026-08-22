import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { reportResultToCsv, reportResultToXlsx, type ReportRunResult } from '@openbooks/office'
import { can } from '../../../../../lib/authz'
import { guardFeaturePermission } from '../../../../../lib/feature-gates'
import { csvResponse, xlsxResponse } from '../../../../../lib/export'
import { isUuid } from '../../../../../lib/list-params'

export const runtime = 'nodejs'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await guardFeaturePermission('budgets.read', 'budgets')
  if (gate instanceof NextResponse) return gate
  if (!can(gate, 'data.export')) return NextResponse.json({ error: 'missing permission: data.export' }, { status: 403 })
  const { id } = await params
  if (!isUuid(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const format = new URL(req.url).searchParams.get('format') ?? 'xlsx'
  if (!['csv', 'xlsx'].includes(format)) return NextResponse.json({ error: 'invalid_format' }, { status: 422 })

  const scenario = (await db.execute<{ name: string; fiscal_year: number }>(sql`
    select name, fiscal_year from budget_scenarios where id = ${id} and org_id = ${gate.user.orgId}
  `))
  if (!scenario.rows[0]) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  const lines = (await db.execute<Record<string, any>>(sql`
    select a.number, a.name as account_name, p.name as period,
           d.code as department, pr.code as project, loc.code as location, c.code as class,
           (case when a.type in ('income', 'income_other') then -bl.amount else bl.amount end)::text as amount, bl.note
      from budget_lines bl
      join accounts a on a.id = bl.account_id and a.org_id = bl.org_id
      join accounting_periods p on p.id = bl.period_id and p.org_id = bl.org_id
      left join departments d on d.id = bl.department_id and d.org_id = bl.org_id
      left join projects pr on pr.id = bl.project_id and pr.org_id = bl.org_id
      left join locations loc on loc.id = bl.location_id and loc.org_id = bl.org_id
      left join classes c on c.id = bl.class_id and c.org_id = bl.org_id
     where bl.org_id = ${gate.user.orgId} and bl.scenario_id = ${id}
     order by a.number nulls last, a.name, p.period_number, d.code, pr.code, loc.code, c.code
  `))

  const result: ReportRunResult = {
    groups: [{
      kind: 'results',
      title: scenario.rows[0].name,
      columns: ['Account Number', 'Account Name', 'Period', 'Department', 'Project', 'Location', 'Class', 'Amount', 'Note'],
      rows: lines.rows.map((row) => [
        row.number ?? '', row.account_name, row.period, row.department ?? '', row.project ?? '',
        row.location ?? '', row.class ?? '', row.amount, row.note ?? '',
      ]),
      isEmpty: lines.rows.length === 0,
    }],
    summary: [],
    rowCount: lines.rows.length,
  }
  const filename = `${scenario.rows[0].name}-${scenario.rows[0].fiscal_year}`
  if (format === 'csv') return csvResponse(reportResultToCsv(result), filename)
  return xlsxResponse(await reportResultToXlsx(result, { reportName: scenario.rows[0].name }), filename)
}
