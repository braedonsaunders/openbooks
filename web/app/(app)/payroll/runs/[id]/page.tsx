import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { ListPageLayout } from '../../../../../components/page-layout'
import { requirePermission, can } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { RunWizard, type RemittanceRow, type RosterRow, type RunHeader, type StubRow, type WizardStep } from './RunWizard'

export const dynamic = 'force-dynamic'

const STEPS: readonly WizardStep[] = ['period', 'review', 'gl', 'finish']

/**
 * One pay run — the processing wizard. Four freely-navigable steps (period &
 * employees → review stubs → GL preview & commit → post & finish); completion
 * derives from run_status + the document's posted state, never from a forced
 * linear march. Wage data — the whole page sits behind payroll.read.
 */
export default async function PayRunPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')
  const { id } = await params
  if (!isUuid(id)) notFound()
  const sp = await searchParams
  const t = await getTranslations('payroll')

  const runs = (await db.execute(sql`
    select r.document_id, d.document_number, d.status as document_status, d.currency,
           d.posted_entry_id, s.name as schedule_name,
           r.period_start::text as period_start, r.period_end::text as period_end,
           r.pay_date::text as pay_date, r.tax_year, r.run_status, r.pay_schedule_id,
           r.gross_total, r.net_total, r.employer_cost_total, r.employee_count
      from pay_runs r
      join documents d on d.id = r.document_id
      left join pay_schedules s on s.id = r.pay_schedule_id
     where r.org_id = ${orgId} and r.document_id = ${id}`)) as unknown as { rows: RunHeader[] }
  const run = runs.rows[0]
  if (!run) notFound()

  const [stubsRes, linesRes, rosterRes, prevRes, remitRes] = (await Promise.all([
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
    // Step 1 roster: everyone the schedule would include, with approved hours
    // in the period and a wage-configured flag (one-table doctrine —
    // labor_cost_rates, employee scope, effective at the pay date).
    db.execute(sql`
      select p.id as employee_party_id, p.display_name as name, prof.pay_basis,
             coalesce(te.hours, 0)::text as approved_hours,
             exists (
               select 1 from labor_cost_rates w
                where w.org_id = prof.org_id and w.employee_party_id = prof.employee_party_id
                  and w.is_active and w.effective_from <= ${run.pay_date}
                  and (w.effective_to is null or w.effective_to >= ${run.pay_date})) as has_wage
        from employee_payroll_profiles prof
        join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
        left join lateral (
          select sum(te.hours) as hours from time_entries te
           where te.org_id = prof.org_id and te.employee_party_id = prof.employee_party_id
             and te.status = 'approved'
             and te.worked_on between ${run.period_start} and ${run.period_end}) te on true
       where prof.org_id = ${orgId} and prof.pay_schedule_id = ${run.pay_schedule_id} and prof.is_active
       order by p.display_name`),
    // Variance baseline: each employee's most recent committed stub before
    // this run (net pay delta drives the ±15% review flag).
    db.execute(sql`
      select distinct on (st.employee_party_id)
             st.employee_party_id, st.net_pay, st.pay_date::text as pay_date
        from pay_stubs st
        join pay_runs r2 on r2.document_id = st.pay_run_document_id and r2.run_status = 'committed'
       where st.org_id = ${orgId} and st.pay_run_document_id <> ${id}
         and st.pay_date <= ${run.pay_date}
       order by st.employee_party_id, st.pay_date desc, st.created_at desc`),
    // Finish-step remittance summary: the committed projection's credit legs
    // grouped by account (net pay owed + statutory/withholding liabilities).
    db.execute(sql`
      select trim(concat_ws(' · ', a.number, a.name)) as account_label,
             sum(dl.amount)::text as amount
        from document_lines dl
        join accounts a on a.id = dl.account_id
       where dl.org_id = ${orgId} and dl.document_id = ${id}
       group by a.id, a.number, a.name
       having sum(dl.amount) < 0
       order by sum(dl.amount)`),
  ])) as unknown as [
    { rows: StubRow[] },
    { rows: StubRow['lines'] },
    { rows: RosterRow[] },
    { rows: { employee_party_id: string; net_pay: string; pay_date: string }[] },
    { rows: RemittanceRow[] },
  ]

  const linesByStub = new Map<string, StubRow['lines']>()
  for (const line of linesRes.rows) {
    const list = linesByStub.get(line.stub_id)
    if (list) list.push(line)
    else linesByStub.set(line.stub_id, [line])
  }
  const stubs = stubsRes.rows.map((stub) => ({ ...stub, lines: linesByStub.get(stub.id) ?? [] }))

  const previousNet: Record<string, string> = {}
  for (const row of prevRes.rows) previousNet[row.employee_party_id] = row.net_pay

  const [adjustmentsRes, adjustableRes] = (await Promise.all([
    db.execute(sql`
      select a.id, a.employee_party_id, a.adjustment_type, a.component_id, a.amount::text, a.hours::text,
             a.replace_component, a.note, p.display_name as employee_name, c.name as component_name
        from pay_run_adjustments a
        join parties p on p.id = a.employee_party_id and p.org_id = a.org_id
        left join pay_components c on c.id = a.component_id
       where a.org_id = ${orgId} and a.pay_run_document_id = ${id}
       order by p.display_name, a.created_at`),
    db.execute(sql`
      select id, code, name, kind from pay_components
       where org_id = ${orgId} and is_active
         and (system_key is null or system_key in ('base_pay','overtime','bonus','vacation_payout'))
       order by sequence, code`),
  ])) as unknown as [{ rows: any[] }, { rows: any[] }]

  const stepParam = sp.step as WizardStep | undefined
  const initialStep: WizardStep =
    stepParam && STEPS.includes(stepParam)
      ? stepParam
      : run.document_status === 'posted' || run.run_status === 'committed'
        ? 'finish'
        : run.run_status === 'calculated'
          ? 'review'
          : 'period'

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={`${t('run.title')} ${run.document_number}`}
          description={`${run.schedule_name ?? ''} · ${run.period_start} – ${run.period_end}`.replace(/^ · /, '')}
          back={{ href: '/payroll/runs', label: t('list.title') }}
        />
      }
    >
      <RunWizard
        run={run}
        stubs={stubs}
        roster={rosterRes.rows}
        previousNet={previousNet}
        adjustments={adjustmentsRes.rows}
        adjustableComponents={adjustableRes.rows}
        remittance={run.run_status === 'committed' ? remitRes.rows : []}
        canRun={can(authz, 'payroll.run')}
        initialStep={initialStep}
      />
    </ListPageLayout>
  )
}
