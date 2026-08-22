import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@openbooks/ui'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { ListPageLayout } from '../../../../../components/page-layout'
import { groupTabs } from '../../../../../components/module-home/group-tabs'
import { ModuleHomeTabs } from '../../../../../components/module-home/ui'
import { requirePermission, can } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import {
  payRunChanges,
  payRunFunding,
  payRunReadiness,
  payRunStaleness,
} from '@openbooks/engine/src/payroll-readiness.ts'
import {
  payrollPaymentMethodSettings,
  resolvedPaymentMethodSql,
} from '@openbooks/engine/src/payroll-payment-method.ts'
import { orgYearEndFilings, type YearEndFilingSection } from '@openbooks/engine/src/payroll-yearend.ts'
import { RunWizard, type RemittanceRow, type RosterRow, type RunHeader, type StubRow, type WizardStep } from './RunWizard'

export const dynamic = 'force-dynamic'

const STEPS: readonly WizardStep[] = ['period', 'readiness', 'review', 'gl', 'finish']

/**
 * One pay run — the processing wizard. Five freely-navigable steps (scope →
 * readiness → review stubs → GL preview & commit → post & finish); completion
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

  const runs = (await db.execute<RunHeader>(sql`
    select r.document_id, d.document_number, d.status as document_status, d.currency,
           d.posted_entry_id, s.name as schedule_name,
           r.period_start::text as period_start, r.period_end::text as period_end,
           r.pay_date::text as pay_date, r.tax_year, r.run_status, r.run_type, r.pay_schedule_id,
           r.gross_total, r.net_total, r.employer_cost_total, r.employee_count
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      left join pay_schedules s on s.id = r.pay_schedule_id
     where r.org_id = ${orgId} and r.document_id = ${id}`))
  const run = runs.rows[0]
  if (!run) notFound()

  // The roster resolves each employee's pay rail with the same ladder the
  // engine uses, so the Scope step's "paid by" column can never disagree with
  // what the run will actually do.
  const { eftFallbackToCheque } = await payrollPaymentMethodSettings(orgId)

  const [stubsRes, linesRes, rosterRes, prevRes, remitRes] = (await Promise.all([
    db.execute<StubRow>(sql`
      select st.id, st.employee_party_id, p.display_name as employee_name, st.province,
             st.gross, st.net_pay, st.employer_cost, st.vacation_accrued,
             st.pensionable_earnings, st.insurable_earnings, st.factors
        from pay_stubs st
        join parties p on p.id = st.employee_party_id and p.org_id = st.org_id
       where st.org_id = ${orgId} and st.pay_run_document_id = ${id}
       order by p.display_name`),
    db.execute<(StubRow['lines'])[number]>(sql`
      select l.stub_id, l.kind, l.description, l.hours, l.rate, l.amount, l.sequence,
             c.code as component_code, pr.name as project_name, dep.name as department_name
        from pay_stub_lines l
        join pay_stubs st on st.id = l.stub_id and st.org_id = l.org_id
        left join pay_components c on c.id = l.component_id
        left join projects pr on pr.id = l.project_id and pr.org_id = l.org_id
        left join departments dep on dep.id = l.department_id and dep.org_id = l.org_id
       where l.org_id = ${orgId} and st.pay_run_document_id = ${id}
       order by l.stub_id, l.sequence`),
    // Step 1 roster: everyone the schedule would include, with approved hours
    // in the period and a wage-configured flag (one-table doctrine —
    // labor_cost_rates, employee scope, effective at the pay date).
    db.execute<RosterRow>(sql`
      select p.id as employee_party_id, p.display_name as name, prof.pay_basis,
             coalesce(te.hours, 0)::text as approved_hours,
             -- Every dimension the roster carries, so the scope filters are a
             -- real filter set rather than "department, when there is one".
             dep.name as department, tr.name as trade, er.job_title,
             sub.name as subsidiary,
             ${resolvedPaymentMethodSql({
               profileMethod: sql`prof.payment_method`,
               partyMethod: sql`p.payment_method`,
               hasBank: sql`exists (
                 select 1 from party_bank_accounts b
                  where b.org_id = prof.org_id and b.party_id = p.id
                    and b.is_active and b.approval_status = 'approved')`,
               fallbackToCheque: eftFallbackToCheque,
             })} as payment_method,
             er.terminated_on::text as terminated_on,
             er.hired_on::text as hired_on,
             exists (
               select 1 from labor_cost_rates w
                where w.org_id = prof.org_id and w.employee_party_id = prof.employee_party_id
                  and w.is_active and w.effective_from <= ${run.pay_date}
                  and (w.effective_to is null or w.effective_to >= ${run.pay_date})) as has_wage,
             -- Already covered by another run whose period overlaps this one:
             -- the double-pay guard the scope picker warns on.
             exists (
               select 1 from pay_stubs s2
                 join pay_runs r2 on r2.document_id = s2.pay_run_document_id
                where s2.org_id = prof.org_id and s2.employee_party_id = prof.employee_party_id
                  and s2.pay_run_document_id <> ${id}
                  and r2.run_status = 'committed'
                  and r2.period_start <= ${run.period_end}
                  and r2.period_end >= ${run.period_start}) as paid_in_period
        from employee_payroll_profiles prof
        join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
        left join employee_roles er on er.party_id = p.id and er.org_id = prof.org_id and er.is_active
        left join departments dep on dep.id = er.department_id
        left join trades tr on tr.id = er.trade_id
        left join subsidiaries sub on sub.id = p.subsidiary_id
        left join lateral (
          select sum(te.hours) as hours from time_entries te
           where te.org_id = prof.org_id and te.employee_party_id = prof.employee_party_id
             and te.status = 'approved'
             and te.worked_on between ${run.period_start} and ${run.period_end}) te on true
       where prof.org_id = ${orgId} and prof.pay_schedule_id = ${run.pay_schedule_id} and prof.is_active
       order by p.display_name`),
    // Variance baseline: each employee's most recent committed stub before
    // this run (net pay delta drives the ±15% review flag).
    db.execute<{ employee_party_id: string; net_pay: string; pay_date: string }>(sql`
      select distinct on (st.employee_party_id)
             st.employee_party_id, st.net_pay, st.pay_date::text as pay_date
        from pay_stubs st
        join pay_runs r2 on r2.document_id = st.pay_run_document_id and r2.run_status = 'committed'
       where st.org_id = ${orgId} and st.pay_run_document_id <> ${id}
         and st.pay_date <= ${run.pay_date}
       order by st.employee_party_id, st.pay_date desc, st.created_at desc`),
    // Finish-step remittance summary: the committed projection's credit legs
    // grouped by account (net pay owed + statutory/withholding liabilities).
    db.execute<RemittanceRow>(sql`
      select trim(concat_ws(' · ', a.number, a.name)) as account_label,
             sum(dl.amount)::text as amount
        from document_lines dl
        join accounts a on a.id = dl.account_id and a.org_id = dl.org_id
       where dl.org_id = ${orgId} and dl.document_id = ${id}
       group by a.id, a.number, a.name
       having sum(dl.amount) < 0
       order by sum(dl.amount)`),
  ]))

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
    db.execute<any>(sql`
      select a.id, a.employee_party_id, a.adjustment_type, a.component_id, a.amount::text, a.hours::text,
             a.replace_component, a.note, p.display_name as employee_name, c.name as component_name
        from pay_run_adjustments a
        join parties p on p.id = a.employee_party_id and p.org_id = a.org_id
        left join pay_components c on c.id = a.component_id
       where a.org_id = ${orgId} and a.pay_run_document_id = ${id}
       order by p.display_name, a.created_at`),
    db.execute<any>(sql`
      select id, code, name, kind from pay_components
       where org_id = ${orgId} and is_active
         and (system_key is null or system_key in ('base_pay','overtime','bonus','vacation_payout'))
       order by sequence, code`),
  ]))

  // A termination run's Finish step owns the pack-declared SEPARATION
  // filings (the ROE): due within days of the interruption of earnings, so
  // they surface on the run that pays the employee out — the registry's
  // populations filtered to this run's own employees. Nothing here names a
  // country or a form; a pack that declares no separation filing shows none.
  let separationSections: YearEndFilingSection[] = []
  if (run.run_type === 'termination') {
    const runEmployees = new Set(stubs.map((stub) => stub.employee_party_id))
    separationSections = (await orgYearEndFilings(orgId, run.tax_year))
      .filter((section) => section.cadence === 'separation')
      .map((section) => ({
        ...section,
        data: {
          ...section.data,
          rows: section.data.rows.filter((row) =>
            runEmployees.has(String(row[section.issue?.idColumn ?? section.data.rowKey] ?? ''))),
        },
      }))
      .filter((section) => section.populationRefusal != null || section.data.rows.length > 0)
  }

  const stepParam = sp.step as WizardStep | undefined
  const initialStep: WizardStep =
    stepParam && STEPS.includes(stepParam)
      ? stepParam
      : run.document_status === 'posted' || run.run_status === 'committed'
        ? 'finish'
        : run.run_status === 'calculated'
          ? 'review'
          : 'period'

  const registerReport = ((await db.execute<{ id: string }>(sql`
    select id from report_definitions
     where org_id = ${orgId} and slug = 'payroll-register' limit 1
  `))).rows[0] ?? null

  const bankAccounts = ((await db.execute<{ id: string; label: string }>(sql`
    select id, concat_ws(' · ', number, name) as label from accounts
     where org_id = ${orgId} and type = 'asset_bank' and is_active and not is_summary
     order by number nulls last, name`))).rows

  // Readiness, staleness, funding and the per-employee diff are engine-owned
  // (one source of truth for what blocks a run, what it costs, and what moved).
  const [readiness, staleness, funding, changes] = await Promise.all([
    payRunReadiness(orgId, id),
    payRunStaleness(orgId, id),
    payRunFunding(orgId, id),
    payRunChanges(orgId, id),
  ])

  const moduleTabs = await groupTabs('payroll', '/payroll/runs')

  return (
    <ListPageLayout
      header={
        <PageHeader
          title={`${t('run.title')} ${run.document_number}`}
          description={`${run.schedule_name ?? ''} · ${run.period_start} – ${run.period_end}`.replace(/^ · /, '')}
          back={{ href: '/payroll/runs', label: t('list.title') }}
          actions={<ModuleHomeTabs tabs={moduleTabs} />}
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
        bankAccounts={bankAccounts}
        readiness={readiness}
        staleness={staleness}
        funding={funding}
        changes={changes}
        separationSections={separationSections}
        registerReportId={registerReport?.id ?? null}
        canRun={can(authz, 'payroll.run')}
        initialStep={initialStep}
      />
    </ListPageLayout>
  )
}
