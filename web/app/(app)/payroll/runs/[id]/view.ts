import 'server-only'

import { PayrollError } from '@openbooks/engine/src/payroll/error.ts'
import { parsePayRunCalculationErrors, parsePayRunRefusalAcknowledgement, payRunCalculationRefusals, payRunRefusalDigest, type PayRunCalculationError, type PayRunRefusalAcknowledgement } from "@openbooks/engine/src/payroll/run-calculation-evidence.ts";
import {
  lockAndCheckPayrollRunPopulation,
  payrollSubsidiaryScopeFilter,
} from '@openbooks/engine/src/payroll/scope.ts'
import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import { page, pageHeader, ref, widget, widgetBlock, type PageSpec } from '@braedonsaunders/appkit-viewspec'
import {
  payRunChanges,
  payRunFunding,
  payRunReadiness,
  payRunStaleness,
  type PayRunFunding,
  type PayRunReadiness,
  type PayRunStaleness,
  type StubChange,
} from '@openbooks/engine/src/payroll/readiness.ts'
import {
  payrollPaymentMethodSettings,
  resolvedPaymentMethodSql,
} from '@openbooks/engine/src/payroll/payment-method.ts'
import { orgYearEndFilings, type YearEndFilingSection } from '@openbooks/engine/src/payroll/yearend.ts'
import { factorLabelForPack, PAYROLL_COUNTRY_PACKS } from '@openbooks/engine/src/payroll/packs.ts'
import { buildRegisterBuckets, type RegisterBucket } from '../../../../../lib/payroll-register-buckets.ts'
import { can, requirePermission } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { isUuid } from '../../../../../lib/list-params'
import { groupTabs } from '../../../../../components/module-home/group-tabs'
import type {
  AdjustmentRow,
  ComponentOption,
  RemittanceRow,
  RosterRow,
  RunHeader,
  StubRow,
  WizardStep,
} from './RunWizard'

/**
 * One pay run — the processing wizard — split into a loader and a spec.
 *
 * The wizard is one client component with five freely-navigable steps whose
 * every control is an interactive fetch flow (calculate/commit/post,
 * dry-run, scope and adjustment mutations, GL preview, email stubs, bank
 * file download, record-payment) plus client state (active step, busy,
 * dialogs) a spec cannot name. Like the /tax page, the spec is coarse by
 * necessity: a single `pay-run-wizard` widget binds loader data to the
 * shared `RunWizard` this page has always rendered, and the spec draws no
 * chrome of its own beyond the `pageHeader` shell.
 *
 * Everything else here is loader work copied verbatim from page.tsx: the
 * `payroll.read` gate, the `payroll` feature gate (404 when disabled), the
 * uuid check, the header run query with the subsidiary scope filter, the
 * population lock check (`PayrollError` → 404), the roster/stubs/lines/
 * previous-net/remittance/adjustments/component queries, the loader-derived
 * `?step=` initial step, the register-report lookup, and the four engine
 * reads (readiness, staleness, funding, changes). Authz stays server-side:
 * `canRun` (`payroll.run`) is a loader-derived boolean, never a capability
 * object, and the `finish`-step remittance rows only travel when the run is
 * committed, exactly as the native `run.run_status === 'committed' ? … : []`
 * does.
 */

const STEPS: readonly WizardStep[] = ['period', 'readiness', 'review', 'gl', 'finish']

export interface PayRunWizardData {
  title: string
  description: string
  backHref: string
  backLabel: string
  viewTabs: { href: string; label: string; active?: boolean }[]
  run: RunHeader
  stubs: StubRow[]
  roster: RosterRow[]
  previousNet: Record<string, string>
  adjustments: AdjustmentRow[]
  adjustableComponents: ComponentOption[]
  remittance: RemittanceRow[]
  bankAccounts: { id: string; label: string }[]
  readiness: PayRunReadiness
  staleness: PayRunStaleness
  funding: PayRunFunding
  changes: StubChange[]
  separationSections: YearEndFilingSection[]
  registerReportId: string | null
  /** Pack-declared withholding buckets for the review grid and stub header. */
  registerBuckets: RegisterBucket[]
  /** Pack-language region column header ("Province" / "State" / "Region"). */
  regionLabel: string
  /** Statutory engine names by stub country for the trace heading. */
  traceEngines: Record<string, string>
  /**
   * Pack-declared trace-factor labels by stub country, resolved through the
   * pack registry exactly like traceEngines. Dynamic keys the run actually
   * carries (SIT_/LIT_ mirrors) are pre-resolved server-side through the
   * pack's describeFactor, so the client payload stays plain data.
   */
  factorLabels: Record<string, Record<string, string>>
  canRun: boolean
  initialStep: WizardStep
  /**
   * The latest calculate's per-employee outcomes, persisted wholesale at
   * calculate time — what commit gates on and the wizard renders. Loader
   * state, not client memory, so the first calculate's exceptions survive a
   * refresh that used to wipe them.
   */
  calculationErrors: PayRunCalculationError[]
  /** Recorded decision to commit despite refusals, if one was taken. */
  refusalAcknowledgement: PayRunRefusalAcknowledgement | null
  /** Whether the recorded acknowledgement binds to the current refusal set. */
  refusalsAcknowledged: boolean
}

export async function loadPayRunWizard(
  id: string,
  sp: Record<string, string | string[] | undefined>,
): Promise<PayRunWizardData> {
  const authz = await requirePermission('payroll.read')
  const orgId = authz.user.orgId
  await requireFeatureEnabled(orgId, 'payroll')
  if (!isUuid(id)) notFound()
  const t = await getTranslations('payroll')

  return db.transaction(async () => {
    const runs = (await db.execute<RunHeader & { calculation_errors: unknown; refusal_acknowledgement: unknown }>(sql`
      select r.document_id, d.document_number, d.status as document_status, d.currency,
             d.posted_entry_id, s.name as schedule_name,
             r.period_start::text as period_start, r.period_end::text as period_end,
             r.pay_date::text as pay_date, r.tax_year, r.run_status, r.run_type, r.pay_schedule_id,
             r.gross_total, r.net_total, r.employer_cost_total, r.employee_count,
             r.calculation_errors, r.refusal_acknowledgement
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
        left join pay_schedules s on s.id = r.pay_schedule_id and s.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${id}
         ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, authz.allowedSubsidiaryIds)}
         for share of r,d`))
    const run = runs.rows[0]
    if (!run) notFound()

    try {
      await lockAndCheckPayrollRunPopulation(db, orgId, id, authz.allowedSubsidiaryIds)
    } catch (error) {
      if (error instanceof PayrollError) notFound()
      throw error
    }

    // The roster resolves each employee's pay rail with the same ladder the
    // engine uses, so the Scope step's "paid by" column can never disagree with
    // what the run will actually do.
    const { eftFallbackToCheque } = await payrollPaymentMethodSettings(orgId)

    const [stubsRes, linesRes, rosterRes, prevRes, remitRes] = (await Promise.all([
      db.execute<StubRow>(sql`
        select st.id, st.employee_party_id, p.display_name as employee_name, st.province,
               prof.country as country,
               st.gross, st.net_pay, st.employer_cost, st.vacation_accrued,
               st.pensionable_earnings, st.insurable_earnings, st.factors
          from pay_stubs st
          join parties p on p.id = st.employee_party_id and p.org_id = st.org_id
          left join employee_payroll_profiles prof
            on prof.employee_party_id = st.employee_party_id and prof.org_id = st.org_id
         where st.org_id = ${orgId} and st.pay_run_document_id = ${id}
         order by p.display_name`),
      db.execute<(StubRow['lines'])[number]>(sql`
        select l.stub_id, l.kind, l.description, l.hours, l.rate, l.amount, l.sequence,
               c.code as component_code, pr.name as project_name, dep.name as department_name
          from pay_stub_lines l
          join pay_stubs st on st.id = l.stub_id and st.org_id = l.org_id
          left join pay_components c on c.id = l.component_id and c.org_id = l.org_id
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
                   join pay_runs r2 on r2.document_id = s2.pay_run_document_id and r2.org_id = s2.org_id
                  where s2.org_id = prof.org_id and s2.employee_party_id = prof.employee_party_id
                    and s2.pay_run_document_id <> ${id}
                    and r2.run_status = 'committed'
                    and r2.period_start <= ${run.period_end}
                    and r2.period_end >= ${run.period_start}) as paid_in_period
          from employee_payroll_profiles prof
          join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
          left join employee_roles er on er.party_id = p.id and er.org_id = prof.org_id and er.is_active
          left join departments dep on dep.id = er.department_id and dep.org_id = er.org_id
          left join trades tr on tr.id = er.trade_id and tr.org_id = er.org_id
          left join subsidiaries sub on sub.id = p.subsidiary_id and sub.org_id = p.org_id
          left join lateral (
            select sum(te.hours) as hours from time_entries te
             where te.org_id = prof.org_id and te.employee_party_id = prof.employee_party_id
               and te.status = 'approved'
               and te.worked_on between ${run.period_start} and ${run.period_end}) te on true
         where prof.org_id = ${orgId} and prof.pay_schedule_id = ${run.pay_schedule_id} and prof.is_active
           ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds)}
         order by p.display_name`),
      // Variance baseline: each employee's most recent committed stub before
      // this run (net pay delta drives the ±15% review flag).
      db.execute<{ employee_party_id: string; net_pay: string; pay_date: string }>(sql`
        select distinct on (st.employee_party_id)
               st.employee_party_id, st.net_pay, st.pay_date::text as pay_date
          from pay_stubs st
          join pay_runs r2 on r2.document_id = st.pay_run_document_id and r2.org_id = st.org_id and r2.run_status = 'committed'
          join parties p on p.id=st.employee_party_id and p.org_id=st.org_id
         where st.org_id = ${orgId} and st.pay_run_document_id <> ${id}
           and st.pay_date <= ${run.pay_date}
           ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, authz.allowedSubsidiaryIds)}
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

    // Register buckets (F-t08-012): the review grid and stub header columns
    // come from the installed packs' declared statutory components — labels
    // and order from the declarations, presence from the run's own nonzero
    // deduction lines — never from hardcoded CA factor keys. A run whose
    // stubs carry no determinable country falls back to every installable
    // pack rather than to any one country's buckets.
    const countriesInRun = [...new Set(stubs.map((stub) => stub.country).filter((c): c is string => !!c))]
    const packsInRun = Object.values(PAYROLL_COUNTRY_PACKS).filter((pack) =>
      countriesInRun.length > 0 ? countriesInRun.includes(pack.country) : pack.installable,
    )
    const seenBucketCodes = new Set<string>()
    const declaredBuckets = packsInRun.flatMap((pack) =>
      pack.statutorySlots.flatMap((slot) =>
        slot.components
          .filter((component) => component.kind === 'deduction')
          .filter((component) => {
            const key = component.code.toUpperCase()
            if (seenBucketCodes.has(key)) return false
            seenBucketCodes.add(key)
            return true
          })
          .map((component) => ({ code: component.code, label: component.name, sequence: component.sequence })),
      ),
    )
    const registerBuckets: RegisterBucket[] = buildRegisterBuckets(
      linesRes.rows.map((line) => ({ componentCode: line.component_code, kind: line.kind, amount: line.amount })),
      declaredBuckets,
    )
    // The region column speaks the pack's language ("Province" for CA,
    // "State" for US); a mixed-country run falls back to neutral "Region".
    // Non-English locales fall back to English for the whole run.stub
    // namespace, so a server-composed label here is no worse than before.
    const regionLabel = packsInRun.length === 1
      ? packsInRun[0]!.regions.label.slice(0, 1).toUpperCase() + packsInRun[0]!.regions.label.slice(1)
      : 'Region'
    // Trace-engine names by stub country ("T4127" / "Pub 15-T"), so the stub
    // calculation trace heads the filing regime the numbers came from.
    const traceEngines: Record<string, string> = Object.fromEntries(
      packsInRun.map((pack) => [pack.country, pack.statutoryEngineLabel]),
    )
    // Trace-factor labels by stub country, from each pack's own declaration
    // — never a web-layer map, which cannot tell California's CA_TAX from
    // Canada's CA. Keys the static map misses but the run carries (the
    // SIT_/LIT_ stub-line mirrors, whose codes include operator-entered
    // sub-regions) resolve here through the pack's describeFactor; anything
    // still unresolved renders raw, exactly as before.
    const factorLabels: Record<string, Record<string, string>> = Object.fromEntries(
      packsInRun.map((pack) => {
        const labels: Record<string, string> = { ...pack.factorLabels }
        for (const stub of stubs) {
          if (stub.country !== pack.country) continue
          for (const key of Object.keys(stub.factors ?? {})) {
            if (labels[key] === undefined) {
              const resolved = factorLabelForPack(pack, key)
              if (resolved !== key) labels[key] = resolved
            }
          }
        }
        return [pack.country, labels]
      }),
    )

    const previousNet: Record<string, string> = {}
    for (const row of prevRes.rows) previousNet[row.employee_party_id] = row.net_pay

    const [adjustmentsRes, adjustableRes] = (await Promise.all([
      db.execute(sql`
        select a.id, a.employee_party_id, a.adjustment_type, a.component_id, a.amount::text, a.hours::text,
               a.replace_component, a.note, p.display_name as employee_name, c.name as component_name
          from pay_run_adjustments a
          join parties p on p.id = a.employee_party_id and p.org_id = a.org_id
          left join pay_components c on c.id = a.component_id and c.org_id = a.org_id
         where a.org_id = ${orgId} and a.pay_run_document_id = ${id}
         order by p.display_name, a.created_at`),
      db.execute(sql`
        select id, code, name, kind from pay_components
         where org_id = ${orgId} and is_active
           and (system_key is null or system_key in ('base_pay','overtime','bonus','vacation_payout'))
         order by sequence, code`),
    ]))
    const adjustmentRows = adjustmentsRes.rows as unknown as AdjustmentRow[]
    const componentRows = adjustableRes.rows as unknown as ComponentOption[]

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

    // The refusal record the commit gate binds to, parsed once for every
    // consumer below: the wizard's exception list, the GL-step acknowledgement
    // panel, and the acknowledged flag that enables the commit button.
    const calculationErrors = parsePayRunCalculationErrors(run.calculation_errors) ?? []
    const refusalAcknowledgement = parsePayRunRefusalAcknowledgement(run.refusal_acknowledgement)
    const currentRefusals = payRunCalculationRefusals(calculationErrors)
    const refusalsAcknowledged = currentRefusals.length === 0
      || (refusalAcknowledgement != null
        && refusalAcknowledgement.errorsDigest === payRunRefusalDigest(currentRefusals))

    // Readiness, staleness, funding and the per-employee diff are engine-owned
    // (one source of truth for what blocks a run, what it costs, and what moved).
    const [readiness, staleness, funding, changes] = await Promise.all([
      payRunReadiness(orgId, id, authz.allowedSubsidiaryIds),
      payRunStaleness(orgId, id, db, authz.allowedSubsidiaryIds),
      payRunFunding(orgId, id, authz.allowedSubsidiaryIds),
      payRunChanges(orgId, id, authz.allowedSubsidiaryIds),
    ])
    // The funding service is the authority for both the account scope and its
    // current book balances. Reuse its scoped rows for the settlement picker so
    // a restricted caller cannot select an account the funding panel omitted.
    const bankAccounts = funding.accounts.map(({ id, label }) => ({ id, label }))

    const moduleTabs = await groupTabs('payroll', '/payroll/runs', { orgId })

    return {
      title: `${t('run.title')} ${run.document_number}`,
      description: `${run.schedule_name ?? ''} · ${run.period_start} – ${run.period_end}`.replace(
        /^ · /,
        '',
      ),
      backHref: '/payroll/runs',
      backLabel: t('list.title'),
      viewTabs: moduleTabs,
      run,
      stubs,
      roster: rosterRes.rows,
      previousNet,
      adjustments: adjustmentRows,
      adjustableComponents: componentRows,
      remittance: run.run_status === 'committed' ? remitRes.rows : [],
      bankAccounts,
      readiness,
      staleness,
      funding,
      changes,
      separationSections,
      registerReportId: registerReport?.id ?? null,
      registerBuckets,
      regionLabel,
      traceEngines,
      factorLabels,
      canRun: can(authz, 'payroll.run'),
      initialStep,
      calculationErrors,
      refusalAcknowledgement,
      refusalsAcknowledged,
    }
  })
}

const f = ref<PayRunWizardData>()

export function payRunWizardSpec(data: PayRunWizardData): PageSpec {
  return page({
    route: '/payroll/runs/[id]',
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        back: { href: f('backHref'), label: f('backLabel') },
        actions: [widget('module-home-tabs', { tabs: data.viewTabs })],
      }),
    ],
    body: [
      // The wizard is one client component: five freely-navigable steps whose
      // every control is an interactive fetch flow a spec cannot name. The
      // entry binds the identical loader data to the shared RunWizard the
      // wizard renders; the loader-derived initialStep chooses the
      // opening step wherever it renders.
      widgetBlock('pay-run-wizard', {
        run: data.run,
        stubs: data.stubs,
        roster: data.roster,
        previousNet: data.previousNet,
        adjustments: data.adjustments,
        adjustableComponents: data.adjustableComponents,
        remittance: data.remittance,
        bankAccounts: data.bankAccounts,
        readiness: data.readiness,
        staleness: data.staleness,
        funding: data.funding,
        changes: data.changes,
        separationSections: data.separationSections,
        registerReportId: data.registerReportId,
        registerBuckets: data.registerBuckets,
        regionLabel: data.regionLabel,
        traceEngines: data.traceEngines,
        factorLabels: data.factorLabels,
        canRun: data.canRun,
        initialStep: data.initialStep,
        calculationErrors: data.calculationErrors,
        refusalAcknowledgement: data.refusalAcknowledgement,
        refusalsAcknowledged: data.refusalsAcknowledged,
      }),
    ],
  })
}
