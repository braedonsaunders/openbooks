import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { ListPageLayout } from '../../../../../components/page-layout'
import { requirePermission, can } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { RunDetail, type RunHeader, type StubRow } from './RunDetail'

export const dynamic = 'force-dynamic'

/**
 * One pay run — header + stub roster with the expandable component-line and
 * T4127 factor trace per employee, and the calculate/commit/post actions.
 */
export default async function PayRunPage({ params }: { params: Promise<{ id: string }> }) {
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')
  const { id } = await params
  if (!isUuid(id)) notFound()
  const t = await getTranslations('payroll')

  const runs = (await db.execute(sql`
    select r.document_id, d.document_number, d.status as document_status, d.currency,
           s.name as schedule_name,
           r.period_start::text as period_start, r.period_end::text as period_end,
           r.pay_date::text as pay_date, r.tax_year, r.run_status,
           r.gross_total, r.net_total, r.employer_cost_total, r.employee_count
      from pay_runs r
      join documents d on d.id = r.document_id
      left join pay_schedules s on s.id = r.pay_schedule_id
     where r.org_id = ${orgId} and r.document_id = ${id}`)) as unknown as { rows: RunHeader[] }
  const run = runs.rows[0]
  if (!run) notFound()

  const [stubsRes, linesRes] = (await Promise.all([
    db.execute(sql`
      select st.id, st.employee_party_id, p.display_name as employee_name, st.province,
             st.gross, st.net_pay, st.employer_cost, st.vacation_accrued,
             st.pensionable_earnings, st.insurable_earnings, st.factors
        from pay_stubs st
        join parties p on p.id = st.employee_party_id and p.org_id = st.org_id
       where st.org_id = ${orgId} and st.pay_run_document_id = ${id}
       order by p.display_name`),
    db.execute(sql`
      select l.stub_id, l.kind, l.description, l.hours, l.rate, l.amount, l.sequence,
             c.code as component_code, pr.name as project_name, dep.name as department_name
        from pay_stub_lines l
        join pay_stubs st on st.id = l.stub_id
        left join pay_components c on c.id = l.component_id
        left join projects pr on pr.id = l.project_id
        left join departments dep on dep.id = l.department_id
       where l.org_id = ${orgId} and st.pay_run_document_id = ${id}
       order by l.stub_id, l.sequence`),
  ])) as unknown as [{ rows: StubRow[] }, { rows: StubRow['lines'] }]

  const linesByStub = new Map<string, StubRow['lines']>()
  for (const line of linesRes.rows) {
    const list = linesByStub.get(line.stub_id)
    if (list) list.push(line)
    else linesByStub.set(line.stub_id, [line])
  }
  const stubs = stubsRes.rows.map((stub) => ({ ...stub, lines: linesByStub.get(stub.id) ?? [] }))

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={`${t('run.title')} ${run.document_number}`}
          description={`${run.schedule_name ?? ''} · ${run.period_start} – ${run.period_end}`.replace(/^ · /, '')}
          back={{ href: '/payroll', label: t('title') }}
        />
      }
    >
      <RunDetail run={run} stubs={stubs} canRun={can(authz, 'payroll.run')} />
    </ListPageLayout>
  )
}
