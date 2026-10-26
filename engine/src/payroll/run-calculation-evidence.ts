import { type CaBonusIncomeReferenceSource } from "./canada/bonus-income-reference.ts";

import { PayrollError } from "./error.ts";

import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";

import { sql } from "drizzle-orm";

import { db } from "../platform/db.ts";

import { canonicalDecimal } from "../money/exact-decimal.ts";

import { cmp } from "../money/money.ts";

import {
  bankCashFundingSplit,
  isBankCashInputEvidenceCandidate,
  parseBankCashInputEvidence,
  type BankCashPayDateValuation,
} from "./run-bank-cash-evidence.ts";

import {
  EMPLOYER_LEVY_PROGRAMS,
  parseEmployerLevyAdjustmentEvidence,
} from "./run-levy-adjustment-evidence.ts";

import { resolveBankPayDateValuation } from "./run-bank-valuation.ts";

import { parseDeclaredVacationAccrualEvidence } from "./run-vacation-accrual-input.ts";

import {
  type IncomeTaxOverrideSource,
  type EmployerLevyAdjustmentSource,
  type BankCashInputSource,
  type DeclaredVacationAccrualSource,
  isEmployerLevyAdjustmentSource,
  isIncomeTaxOverrideSource,
  isBankCashInputSource,
  isDeclaredVacationAccrualSource,
  type PayRunCalculationSourceSnapshot,
  type ComponentStatutoryTreatmentSource,
  type CalculationSourceRow,
  lockCalculationInputSources,
} from "./run-calculation-source-shape.ts";

import { assemblePayRunCalculationSource } from "./run-calculation-source-assemble.ts";

export {
  canonicalJson,
  payRunCalculationSourceDigest,
  parsePayRunCalculationSource,
} from "./run-calculation-source-shape.ts";
export type {
  OpeningEmployerAuthoritySource,
  IncomeTaxOverrideSource,
  EmployerLevyAdjustmentSource,
  BankCashInputSource,
  DeclaredVacationAccrualSource,
  OpeningLevySourceAuthoritySource,
  OpeningBalanceSourceState,
  PayRunCalculationSourceSnapshot,
} from "./run-calculation-source-shape.ts";
export {
  payRunCalculationSourceChanges,
  payRunCalculationRefusals,
  payRunRefusalDigest,
  parsePayRunCalculationErrors,
  parsePayRunRefusalAcknowledgement,
} from "./run-calculation-refusals.ts";
export type {
  PayRunCalculationError,
  PayRunRefusalAcknowledgement,
} from "./run-calculation-refusals.ts";

/**
 * Re-derive the exact calculation population. The locked form is the commit
 * fence: every existing source row is held through the exact-ID claim and the
 * terminal transition. A new row that becomes visible after this statement's
 * PostgreSQL snapshot is later than the fence and is never claimed by this
 * run; every row visible at the fence must match the stored calculation.
 *
 * The three source CTEs deliberately share ONE SQL statement so their reads
 * cannot be torn across READ COMMITTED snapshots. Calculation runs under
 * REPEATABLE READ as an additional guarantee that these final evidence rows
 * are the same versions its earlier per-stub reads consumed.
 */
export async function payRunCalculationSource(
  orgId: string,
  documentId: string,
  executor: Pick<typeof db, "execute"> = db,
  lockSources = false,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
  calculatedBonusReferences?: readonly CaBonusIncomeReferenceSource[],
): Promise<PayRunCalculationSourceSnapshot | null> {
  if (lockSources)
    await lockCalculationInputSources(executor, orgId, documentId, allowedSubsidiaryIds);
  const rowLock = lockSources ? sql`for update` : sql``;
  const entryRowLock = lockSources ? sql`for update of te` : sql``;
  const result = await executor.execute<CalculationSourceRow>(
    sql`
    with run_scope as materialized (
      select r.org_id, r.document_id, r.period_start, r.period_end, r.pay_date, r.run_type,
             d.currency as run_currency, d.subsidiary_id
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
         ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
    ),
    stub_employees as materialized (
      select s.employee_party_id, prof.pay_basis, r.period_end, r.run_currency
        from run_scope r
        join pay_stubs s
          on s.org_id = r.org_id and s.pay_run_document_id = r.document_id
        left join parties p
          on p.id = s.employee_party_id and p.org_id = s.org_id
        join employee_payroll_profiles prof
          on prof.org_id = s.org_id and prof.employee_party_id = s.employee_party_id
       where true ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
    ),
    locked_entries as materialized (
      select te.id, te.employee_party_id, te.worked_on, te.hours, te.time_type_id,
             te.project_id, te.department_id, te.item_id, te.is_billable,
             te.created_at, te.updated_at,
             exists (
               select 1
                 from pay_stub_lines line
                 join pay_stubs stub
                   on stub.id = line.stub_id and stub.org_id = line.org_id
                 join pay_components component
                   on component.id = line.component_id and component.org_id = line.org_id
                where stub.org_id = r.org_id
                  and stub.pay_run_document_id = r.document_id
                  and stub.employee_party_id = te.employee_party_id
                  and component.system_key in ('base_pay', 'overtime')
                  and line.hours is not null
                  and line.time_type_id is not distinct from te.time_type_id
                  and line.project_id is not distinct from te.project_id
                  and line.department_id is not distinct from te.department_id
                  and line.item_id is not distinct from te.item_id
             ) as claimable
        from run_scope r
        join stub_employees employee on true
        join time_entries te
          on te.org_id = r.org_id and te.employee_party_id = employee.employee_party_id
         and te.status = 'approved'
         and te.worked_on between r.period_start and r.period_end
         and (te.payroll_batch_ref is null or te.payroll_batch_ref = r.document_id::text)
       where r.run_type not in ('bonus', 'retro')
       order by te.id
       ${entryRowLock}
    ),
    locked_time_types as materialized (
      select tt.id, tt.name, tt.classification, tt.cost_multiplier,
             tt.exclude_from_wages, tt.updated_at
        from time_types tt
       where tt.org_id = ${orgId}
         and exists (
           select 1 from locked_entries entry where entry.time_type_id = tt.id
         )
       order by tt.id
       ${rowLock}
    ),
    locked_items as materialized (
      select i.id, i.payroll_expense_account_id, i.updated_at
        from items i
       where i.org_id = ${orgId}
         and exists (
           select 1 from locked_entries entry where entry.item_id = i.id
         )
       order by i.id
       ${rowLock}
    ),
    locked_rates as materialized (
      select employee.employee_party_id, employee.pay_basis,
             employee.run_currency,
             wage.id as rate_id, wage.basis, wage.rate, wage.annual_hours,
             wage.currency, wage.payroll_rate_scale, wage.payroll_amount_rounding, wage.effective_from, wage.effective_to, wage.updated_at
        from stub_employees employee
        left join lateral (
          select w.id, w.basis, w.rate, w.annual_hours, w.currency, w.payroll_rate_scale, w.payroll_amount_rounding,
                 w.effective_from, w.effective_to, w.updated_at
            from labor_cost_rates w
           where w.org_id = ${orgId}
             and w.employee_party_id = employee.employee_party_id
             and w.is_active and w.effective_from <= employee.period_end
             and (w.effective_to is null or w.effective_to >= employee.period_end)
           order by w.effective_from desc
           limit 1
           ${rowLock}
        ) wage on true
       order by employee.employee_party_id
    ),
    locked_fx as materialized (
      select rate.employee_party_id,
             fx.id, fx.from_currency, fx.to_currency, fx.as_of, fx.rate,
             case when fx.from_currency = rate.currency
                        and fx.to_currency = rate.run_currency
                  then 'direct' else 'inverse' end as direction,
             case when fx.from_currency = rate.currency
                        and fx.to_currency = rate.run_currency
                  then fx.rate
                  else (1 / fx.rate)::numeric(19,10) end as resolved_rate,
             fx.updated_at
        from locked_rates rate
        left join lateral (
          select candidate.id, candidate.from_currency, candidate.to_currency,
                 candidate.as_of, candidate.rate, candidate.updated_at
            from fx_rates candidate
           where candidate.org_id = ${orgId}
             and candidate.rate_type = 'spot'
             and candidate.as_of <= (select period_end from run_scope)
             and rate.currency is distinct from rate.run_currency
             and ((candidate.from_currency = rate.currency
                   and candidate.to_currency = rate.run_currency)
               or (candidate.from_currency = rate.run_currency
                   and candidate.to_currency = rate.currency))
           order by candidate.as_of desc,
                    case when candidate.from_currency = rate.currency
                              and candidate.to_currency = rate.run_currency
                         then 0 else 1 end
           limit 1
           ${rowLock}
        ) fx on true
    )
    select exists (select 1 from run_scope) as run_exists,
           (select pay_date::text from run_scope) as pay_date,
           coalesce((select jsonb_agg(employee_party_id::text order by employee_party_id) from stub_employees),'[]'::jsonb) as employee_party_ids,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', entry.id::text,
               'employeePartyId', entry.employee_party_id::text,
               'workedOn', entry.worked_on::text,
               'hours', entry.hours::text,
               'timeTypeId', entry.time_type_id::text,
               'projectId', entry.project_id::text,
               'departmentId', entry.department_id::text,
               'isBillable', entry.is_billable,
               'createdAt', to_char(entry.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'updatedAt', to_char(entry.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'claimable', entry.claimable
             ) order by entry.id)
               from locked_entries entry
           ), '[]'::jsonb) as time_entries,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', tt.id::text,
               'name', tt.name,
               'classification', tt.classification,
               'costMultiplier', tt.cost_multiplier::text,
               'excludeFromWages', tt.exclude_from_wages,
               'updatedAt', to_char(tt.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             ) order by tt.id)
               from locked_time_types tt
           ), '[]'::jsonb) as time_types,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'id', item.id::text,
               'payrollExpenseAccountId', item.payroll_expense_account_id::text,
               'updatedAt', to_char(item.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
             ) order by item.id)
               from locked_items item
           ), '[]'::jsonb) as item_accounts,
           coalesce((
             select jsonb_agg(jsonb_build_object(
               'employeePartyId', rate.employee_party_id::text,
               'payBasis', rate.pay_basis,
               'runCurrency', rate.run_currency,
               'rateId', rate.rate_id::text,
               'basis', rate.basis,
               'rate', rate.rate::text,
               'annualHours', rate.annual_hours::text,
               'payrollRateScale', rate.payroll_rate_scale,
               'payrollAmountRounding', rate.payroll_amount_rounding,
               'currency', rate.currency,
               'effectiveFrom', rate.effective_from::text,
               'effectiveTo', rate.effective_to::text,
               'updatedAt', case when rate.updated_at is null then null else
                 to_char(rate.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
               'fx', case when fx.id is null then null else jsonb_build_object(
                 'id', fx.id::text,
                 'fromCurrency', fx.from_currency,
                 'toCurrency', fx.to_currency,
                 'asOf', fx.as_of::text,
                 'rate', fx.rate::text,
                 'direction', fx.direction,
                 'resolvedRate', fx.resolved_rate::text,
                 'updatedAt', to_char(fx.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
               ) end
             ) order by rate.employee_party_id)
               from locked_rates rate
               left join locked_fx fx on fx.employee_party_id = rate.employee_party_id
           ), '[]'::jsonb) as pay_rates,
           coalesce((
             select jsonb_agg(to_jsonb(entry.id::text) order by entry.id)
               from locked_entries entry where entry.claimable
           ), '[]'::jsonb) as claim_entry_ids
  `,
    "objects",
  );
  const row = result[0];
  if (!row?.run_exists) return null;
  const incomeTaxOverrideRows = await executor.execute<{
    adjustmentId: string;
    employeePartyId: string;
    componentId: string;
    amount: string;
    note: string | null;
  }>(
    sql`
    select a.id::text as "adjustmentId", a.employee_party_id::text as "employeePartyId",
           a.component_id::text as "componentId", a.amount::text as amount, a.note
      from pay_run_adjustments a
      join pay_components c on c.org_id=a.org_id and c.id=a.component_id
     where a.org_id=${orgId} and a.pay_run_document_id=${documentId}
       and a.adjustment_type='line' and a.replace_component and c.system_key='income_tax'
       and a.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
     order by a.employee_party_id, a.id
     ${lockSources ? sql`for share of a, c` : sql``}
  `,
    "objects",
  );
  const incomeTaxOverrides: IncomeTaxOverrideSource[] = incomeTaxOverrideRows.map((override) => {
    let note: unknown;
    try {
      note = JSON.parse(override.note ?? "null");
    } catch {
      note = null;
    }
    const evidence =
      note && typeof note === "object" && !Array.isArray(note)
        ? (note as Record<string, unknown>)
        : null;
    const source: IncomeTaxOverrideSource = {
      adjustmentId: override.adjustmentId,
      employeePartyId: override.employeePartyId,
      componentId: override.componentId,
      amount: override.amount,
      reason: typeof evidence?.reason === "string" ? evidence.reason : "",
      sourceReference:
        typeof evidence?.sourceReference === "string" ? evidence.sourceReference : "",
      requestId: typeof evidence?.requestId === "string" ? evidence.requestId : "",
    };
    if (evidence?.kind !== "income_tax_override" || !isIncomeTaxOverrideSource(source)) {
      throw new PayrollError(
        "The saved income-tax override lacks valid audited amount, reason or source-reference evidence — correct it through the audited override command before calculating or committing",
      );
    }
    return source;
  });
  const employerLevyAdjustmentRows = await executor.execute<{
    adjustmentId: string;
    employeePartyId: string;
    componentId: string;
    amount: string;
    note: string | null;
    systemKey: string;
  }>(
    sql`
    select a.id::text as "adjustmentId", a.employee_party_id::text as "employeePartyId",
           a.component_id::text as "componentId", a.amount::text as amount, a.note,
           c.system_key as "systemKey"
      from pay_run_adjustments a
      join pay_components c on c.org_id=a.org_id and c.id=a.component_id
     where a.org_id=${orgId} and a.pay_run_document_id=${documentId}
       and a.adjustment_type='line' and c.kind='employer_contribution'
       and c.system_key in ('eht', 'wcb')
       and a.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
     order by a.employee_party_id, a.id
     ${lockSources ? sql`for share of a, c` : sql``}
  `,
    "objects",
  );
  const employerLevyAdjustments: EmployerLevyAdjustmentSource[] = employerLevyAdjustmentRows.map(
    (adjustment) => {
      const evidence = parseEmployerLevyAdjustmentEvidence(adjustment.note);
      const source: EmployerLevyAdjustmentSource = {
        adjustmentId: adjustment.adjustmentId,
        employeePartyId: adjustment.employeePartyId,
        componentId: adjustment.componentId,
        amount: adjustment.amount,
        programKey: evidence?.programKey ?? "",
        workerCompGroupId: evidence?.workerCompGroupId ?? null,
        sourceKey: evidence?.sourceKey ?? "",
        reason: evidence?.reason ?? "",
        sourceReference: evidence?.sourceReference ?? "",
        requestId: evidence?.requestId ?? "",
      };
      if (
        !evidence ||
        EMPLOYER_LEVY_PROGRAMS[evidence.programKey].systemKey !== adjustment.systemKey ||
        !isEmployerLevyAdjustmentSource(source)
      ) {
        throw new PayrollError(
          "The saved employer levy adjustment lacks valid audited programme, amount, reason or source-reference evidence — correct it through the audited employer levy adjustment command before calculating or committing",
        );
      }
      return source;
    },
  );
  const bankCashRows = await executor.execute<{
    adjustmentId: string;
    employeePartyId: string;
    componentId: string | null;
    amount: string;
    hours: string | null;
    note: string | null;
    runType: string;
    componentActive: boolean;
    componentKind: string;
    componentUnit: string | null;
    replaceComponent: boolean;
    earnedFrom: string | null;
    earnedTo: string | null;
    paymentKind: string;
    activeBankPlanCount: string;
    bankPlanId: string | null;
    bankPlanUnit: string | null;
    bankPlanDirection: string | null;
    bankPlanAllowsNegativeBalance: boolean | null;
    bankPlanPayoutComponentId: string | null;
    bankPlanDepositComponentId: string | null;
  }>(
    sql`
    select a.id::text as "adjustmentId", a.employee_party_id::text as "employeePartyId",
           a.component_id::text as "componentId", a.amount::text as amount, a.hours::text as hours, a.note,
           run.run_type as "runType",
           c.is_active as "componentActive", c.kind as "componentKind", c.unit_of_measure as "componentUnit", c.payment_kind as "paymentKind",
           a.replace_component as "replaceComponent", a.earned_from::text as "earnedFrom", a.earned_to::text as "earnedTo",
           (select count(*)::text from entitlement_plans plan
             where plan.org_id=a.org_id and plan.is_active and plan.unit in ('hours','money')
               and (plan.payout_component_id=a.component_id or plan.deposit_component_id=a.component_id)) as "activeBankPlanCount",
           bank_plan.id::text as "bankPlanId", bank_plan.unit as "bankPlanUnit",
           bank_plan.direction as "bankPlanDirection", bank_plan.allow_negative_balance as "bankPlanAllowsNegativeBalance",
           bank_plan.payout_component_id::text as "bankPlanPayoutComponentId",
           bank_plan.deposit_component_id::text as "bankPlanDepositComponentId"
      from pay_run_adjustments a
      join pay_runs run on run.org_id=a.org_id and run.document_id=a.pay_run_document_id
      left join pay_components c on c.org_id=a.org_id and c.id=a.component_id
      left join lateral (
        select plan.id,plan.unit,plan.direction,plan.allow_negative_balance,
               plan.payout_component_id,plan.deposit_component_id
          from entitlement_plans plan
         where plan.org_id=a.org_id and plan.is_active and plan.unit in ('hours','money')
           and (plan.payout_component_id=a.component_id or plan.deposit_component_id=a.component_id)
         order by plan.id limit 1
      ) bank_plan on true
     where a.org_id=${orgId} and a.pay_run_document_id=${documentId}
       and a.adjustment_type='line'
       and a.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
     order by a.employee_party_id, a.id
     ${lockSources ? sql`for share of a` : sql``}
  `,
    "objects",
  );
  const bankCashInputs: BankCashInputSource[] = [];
  for (const input of bankCashRows) {
    if (!isBankCashInputEvidenceCandidate(input.note)) continue;
    const evidence = parseBankCashInputEvidence(input.note);
    const hours = input.hours === null ? null : canonicalDecimal(input.hours, 2);
    const amount = canonicalDecimal(input.amount, 4);
    const withdrawal = hours !== null && cmp(hours, "0") > 0;
    const deposit = hours !== null && cmp(hours, "0") < 0;
    if (
      !evidence ||
      input.runType === "termination" ||
      !input.componentId ||
      input.hours === null ||
      hours === null ||
      amount === null ||
      input.componentActive !== true ||
      input.componentKind !== "earning" ||
      input.paymentKind !== "cash" ||
      input.componentUnit === "quantity" ||
      input.replaceComponent !== false ||
      input.earnedFrom !== null ||
      input.earnedTo !== null ||
      input.activeBankPlanCount !== "1" ||
      !input.bankPlanId ||
      typeof input.bankPlanUnit !== "string" ||
      !["hours", "money"].includes(input.bankPlanUnit) ||
      input.bankPlanDirection === null ||
      typeof input.bankPlanAllowsNegativeBalance !== "boolean" ||
      (withdrawal && input.bankPlanPayoutComponentId !== input.componentId) ||
      (deposit && input.bankPlanDepositComponentId !== input.componentId) ||
      (!withdrawal && !deposit)
    ) {
      throw new PayrollError(
        "The saved bank payout input no longer identifies one active cash bank component with valid signed hours; correct it through the audited bank cash input command before calculating or committing",
      );
    }
    // A split is valued at the native wage on the PAY DATE, never the
    // period-end wage the run's payRates retain: resolve that dated source
    // here, on this executor and under the same source locks, and freeze
    // it with the input. Re-resolving at commit therefore stales on a
    // pay-date-only wage change even when the period-end wage is unchanged.
    // The observed wage currency is retained verbatim, including a foreign
    // one the line phase refuses: hiding it would let a later currency
    // edit pass as unchanged evidence instead of staling the calculation.
    let bankValuation: BankCashPayDateValuation | null | undefined;
    if (evidence.outsideBankAmount !== undefined) {
      if (!bankCashFundingSplit(amount, evidence.outsideBankAmount)) {
        throw new PayrollError(
          "The saved bank payout split no longer has a positive bank-funded amount below the issued cash amount; correct it through the audited bank cash input command before calculating or committing",
        );
      }
      bankValuation = await resolveBankPayDateValuation(
        executor,
        orgId,
        input.employeePartyId,
        row.pay_date,
        lockSources,
      );
    }
    const source: BankCashInputSource = {
      adjustmentId: input.adjustmentId,
      employeePartyId: input.employeePartyId,
      componentId: input.componentId,
      amount,
      hours,
      bankPlanId: input.bankPlanId,
      bankPlanUnit: input.bankPlanUnit,
      bankPlanDirection: input.bankPlanDirection,
      bankPlanAllowsNegativeBalance: input.bankPlanAllowsNegativeBalance,
      bankPlanPayoutComponentId: input.bankPlanPayoutComponentId,
      bankPlanDepositComponentId: input.bankPlanDepositComponentId,
      reason: evidence.reason,
      sourceReference: evidence.sourceReference,
      requestId: evidence.requestId,
      rate: evidence.rate,
      ...(evidence.outsideBankAmount === undefined
        ? {}
        : { outsideBankAmount: evidence.outsideBankAmount }),
      ...(bankValuation === undefined ? {} : { bankValuation }),
    };
    if (evidence.requestId !== input.adjustmentId || !isBankCashInputSource(source)) {
      throw new PayrollError(
        "The saved bank payout input amount, keyed rate or audited source evidence no longer agrees; correct it through the audited bank cash input command before calculating or committing",
      );
    }
    bankCashInputs.push(source);
  }
  const declaredAccrualRows = await executor.execute<{
    adjustmentId: string;
    employeePartyId: string;
    componentId: string | null;
    amount: string;
    note: string | null;
    componentActive: boolean | null;
    componentKind: string | null;
    planCount: string;
    planId: string | null;
    planUnit: string | null;
    planDirection: string | null;
    planSystemKey: string | null;
    planAccrualComponentId: string | null;
  }>(
    sql`
    select a.id::text as "adjustmentId", a.employee_party_id::text as "employeePartyId",
           a.component_id::text as "componentId", a.amount::text as amount, a.note,
           c.is_active as "componentActive", c.kind as "componentKind",
           plan.plan_count as "planCount", plan.id as "planId", plan.unit as "planUnit",
           plan.direction as "planDirection", plan.system_key as "planSystemKey",
           plan.accrual_component_id as "planAccrualComponentId"
      from pay_run_adjustments a
      left join pay_components c on c.org_id=a.org_id and c.id=a.component_id
      left join lateral (
        select count(*)::text as plan_count, min(p.id::text) as id, min(p.unit) as unit,
               min(p.direction) as direction, min(p.system_key) as system_key,
               min(p.accrual_component_id::text) as accrual_component_id
          from entitlement_plans p
         where p.org_id=a.org_id and p.is_active and p.system_key='vacation'
           and p.accrual_component_id=a.component_id
      ) plan on true
     where a.org_id=${orgId} and a.pay_run_document_id=${documentId}
       and a.adjustment_type='line'
       and a.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
       and a.note ~ '"kind"[[:space:]]*:[[:space:]]*"declared_vacation_accrual"'
     order by a.employee_party_id,a.id
  `,
    "objects",
  );
  const declaredVacationAccruals: DeclaredVacationAccrualSource[] = declaredAccrualRows.map(
    (input) => {
      const evidence = parseDeclaredVacationAccrualEvidence(input.note);
      const amount = canonicalDecimal(input.amount, 4);
      const source = {
        adjustmentId: input.adjustmentId,
        employeePartyId: input.employeePartyId,
        componentId: input.componentId ?? "",
        planId: input.planId ?? "",
        amount: amount ?? "",
        reason: evidence?.reason ?? "",
        sourceReference: evidence?.sourceReference ?? "",
        requestId: evidence?.requestId ?? "",
      };
      if (
        !evidence ||
        !input.componentId ||
        !amount ||
        input.componentActive !== true ||
        input.componentKind !== "employer_contribution" ||
        input.planCount !== "1" ||
        input.planUnit !== "money" ||
        input.planDirection !== "accrue" ||
        input.planSystemKey !== "vacation" ||
        input.planAccrualComponentId !== input.componentId ||
        evidence.requestId !== input.adjustmentId ||
        !isDeclaredVacationAccrualSource(source)
      ) {
        throw new PayrollError(
          "The saved declared vacation accrual no longer matches an active money vacation plan and audited cheque source; correct it through the declared accrual command before calculating or committing.",
        );
      }
      return source;
    },
  );
  const assignmentRunPolicies = await executor.execute<
    NonNullable<PayRunCalculationSourceSnapshot["assignmentRunPolicies"]>[number]
  >(
    sql`
    select a.id::text, a.employee_party_id::text as "employeePartyId", a.employment_id::text as "employmentId",
      a.component_id::text as "componentId", a.run_applicability as policy,
      a.effective_from::text as "from", a.effective_to::text as "to"
    from employee_pay_components a join pay_runs r on r.org_id=a.org_id and r.document_id=${documentId}
    where a.org_id=${orgId} and a.is_active and a.run_applicability <> 'standard_runs'
      and a.employee_party_id in (select jsonb_array_elements_text(${JSON.stringify(row.employee_party_ids ?? [])}::jsonb)::uuid)
      and a.effective_from <= r.period_end and (a.effective_to is null or a.effective_to >= r.period_start)
    order by a.id
  `,
    "objects",
  );
  const payComponentStatutoryTreatments = await executor.execute<ComponentStatutoryTreatmentSource>(
    sql`
    select treatment.id::text as id,
      treatment.pay_component_id::text as "componentId",
      treatment.worker_comp_group_id::text as "workerCompGroupId",
      (public.payroll_worker_comp_group_at(stub.org_id, stub.employee_party_id, r.pay_date))::text as "employeeWorkerCompGroupId",
      treatment.effective_from::text as "effectiveFrom",
      treatment.effective_to::text as "effectiveTo",
      treatment.program_exclusions as "programExclusions",
      treatment.vacationable
    from pay_runs r
    join pay_stubs stub on stub.org_id=r.org_id and stub.pay_run_document_id=r.document_id
    join pay_stub_lines line on line.org_id=stub.org_id and line.stub_id=stub.id
    join lateral (
      select treatment.*
        from pay_component_statutory_treatments treatment
       where treatment.org_id=line.org_id and treatment.pay_component_id=line.component_id
         and treatment.effective_from<=r.pay_date
         and (treatment.effective_to is null or treatment.effective_to>=r.pay_date)
         and (treatment.worker_comp_group_id is null
           or treatment.worker_comp_group_id is not distinct from
             public.payroll_worker_comp_group_at(stub.org_id, stub.employee_party_id, r.pay_date))
       order by (treatment.worker_comp_group_id is not null) desc
       limit 1
    ) treatment on true
    where r.org_id=${orgId} and r.document_id=${documentId}
      and line.kind='earning' and line.component_id is not null
    group by treatment.id::text, treatment.pay_component_id::text, treatment.worker_comp_group_id::text,
      (public.payroll_worker_comp_group_at(stub.org_id, stub.employee_party_id, r.pay_date))::text,
      treatment.effective_from::text, treatment.effective_to::text, treatment.program_exclusions, treatment.vacationable
     order by "componentId", "workerCompGroupId" nulls first, "effectiveFrom", id
  `,
    "objects",
  );
  if (payComponentStatutoryTreatments.some((row) => typeof row.vacationable !== "boolean")) {
    throw new PayrollError(
      "A pay component statutory treatment has no vacation eligibility — review the component treatment before calculating",
    );
  }
  const uncoveredEarningComponents = await executor.execute<{ component_id: string }>(
    sql`
    select distinct line.component_id::text as component_id
    from pay_runs r
      join pay_stubs stub on stub.org_id=r.org_id and stub.pay_run_document_id=r.document_id
      join pay_stub_lines line on line.org_id=stub.org_id and line.stub_id=stub.id
     where r.org_id=${orgId} and r.document_id=${documentId}
       and line.kind='earning' and line.component_id is not null
       and not exists (
         select 1 from pay_component_statutory_treatments treatment
          where treatment.org_id=line.org_id and treatment.pay_component_id=line.component_id
            and treatment.effective_from<=r.pay_date
            and (treatment.effective_to is null or treatment.effective_to>=r.pay_date)
            and (treatment.worker_comp_group_id is null
              or treatment.worker_comp_group_id is not distinct from
                public.payroll_worker_comp_group_at(stub.org_id, stub.employee_party_id, r.pay_date))
       )
     order by component_id
  `,
    "objects",
  );
  if (uncoveredEarningComponents.length) {
    throw new PayrollError(
      `No effective statutory treatment covers earning component ${uncoveredEarningComponents[0]!.component_id} on this pay date; add a dated treatment in Payroll Setup before calculating.`,
    );
  }
  return assemblePayRunCalculationSource({
    orgId,
    documentId,
    executor,
    lockSources,
    allowedSubsidiaryIds,
    calculatedBonusReferences,
    row,
    incomeTaxOverrides,
    employerLevyAdjustments,
    bankCashInputs,
    declaredVacationAccruals,
    assignmentRunPolicies,
    payComponentStatutoryTreatments,
  });
}
