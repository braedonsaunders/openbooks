import { CA_ISSUED_INCOME_TAX_OVERRIDE } from "./canada/levy-programs.ts";
import { sql } from "drizzle-orm";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { cmp, normalizeMoney } from "../money/money.ts";
import { PayrollError } from "./error.ts";
import { payrollEmploymentOverlapsPeriod } from "./employment-roster.ts";
import { assertBankDepositAdjustment } from "./run-bank-input.ts";
import {
  bankCashFundingSplit,
  bankCashInputEvidence,
  canonicalBankCashInputValues,
  parseBankCashInputEvidence,
} from "./run-bank-cash-evidence.ts";
import {
  declaredVacationAccrualEvidence,
  parseDeclaredVacationAccrualEvidence,
} from "./run-vacation-accrual-input.ts";
import {
  resolvePayrollRunContext,
  assertPayrollRegionSupported,
  assertPayrollTaxYearSupported,
} from "./packs.ts";
import { caPayrollConfig } from "./canada/config.ts";
import {
  EMPLOYER_LEVY_PROGRAMS,
  canonicalEmployerLevyAdjustmentAmount,
  canonicalLevySourceKey,
  employerLevyAdjustmentEvidence,
  isEmployerLevyProgramKey,
  parseEmployerLevyAdjustmentEvidence,
} from "./run-levy-adjustment-evidence.ts";
import { isUuid } from "../platform/uuid.ts";
import type { SqlExecutor } from "../platform/db.ts";
import {
  PayRunAdjustmentIdempotencyConflict,
  persistAdjustmentMoney,
  persistAdjustmentHours,
  canonicalAdjustmentHours,
  parseIncomeTaxOverrideEvidence,
  incomeTaxOverrideEvidence,
  type PayRunAdjustmentMutation,
} from "./run-adjustment-values.ts";

/** The locked draft run an audited payroll input is recorded against. */
export type AdjustmentRun = {
  run_status: string;
  run_type: string;
  pay_schedule_id: string;
  period_start: string;
  period_end: string;
  pay_date: string;
  tax_year: number;
  currency: string;
  document_status: string;
  subsidiary_id: string | null;
};

export type AdjustmentAuditChange = {
  id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

/** The command transaction and locked run every audited input records within. */
export type AuditedAdjustmentContext = {
  tx: SqlExecutor;
  orgId: string;
  actorId: string;
  documentId: string;
  run: AdjustmentRun;
};

/** A replay of an identical recorded request, or the rows this request changed. */
export type AuditedAdjustmentOutcome = { replayed: true } | { changes: AdjustmentAuditChange[] };

export async function applyBankCashInput(
  ctx: AuditedAdjustmentContext,
  mutation: Extract<PayRunAdjustmentMutation, { action: "bank_cash_input" }>,
): Promise<AuditedAdjustmentOutcome> {
  const { tx, orgId, actorId, documentId, run } = ctx;
  const changes: AdjustmentAuditChange[] = [];
  const values = canonicalBankCashInputValues(mutation);
  const amount = persistAdjustmentMoney(values.amount);
  const hours = persistAdjustmentHours(values.hours, amount);
  const rateExact = values.rate;
  const outsideBankAmount =
    mutation.outsideBankAmount == null || mutation.outsideBankAmount === ""
      ? null
      : canonicalDecimal(mutation.outsideBankAmount, 2);
  if (
    mutation.outsideBankAmount != null &&
    mutation.outsideBankAmount !== "" &&
    outsideBankAmount === null
  ) {
    throw new PayrollError("cash paid outside the bank must be an exact currency amount in cents");
  }
  if (
    outsideBankAmount !== null &&
    (cmp(hours, "0") <= 0 || !bankCashFundingSplit(amount, outsideBankAmount))
  ) {
    throw new PayrollError(
      "cash paid outside the bank must be a positive part of a withdrawal, smaller than the issued payout; the remaining bank-funded cash must stay positive",
    );
  }
  const reason = mutation.reason.trim();
  const sourceReference = mutation.sourceReference.trim();
  if (reason.length === 0 || reason.length > 500)
    throw new PayrollError("bank cash input reason must contain 1 to 500 characters");
  if (sourceReference.length === 0 || sourceReference.length > 300)
    throw new PayrollError("bank cash input source reference must contain 1 to 300 characters");
  if (!isUuid(mutation.idempotencyKey))
    throw new PayrollError(
      "bank cash input needs a UUID Idempotency-Key; retry with a request key",
    );
  const requestId = mutation.idempotencyKey.toLowerCase();
  const note = bankCashInputEvidence(
    reason,
    sourceReference,
    requestId,
    rateExact,
    outsideBankAmount,
  );

  if (run.run_type === "termination") {
    throw new PayrollError(
      "bank cash inputs require an ordinary editable run — final pay settles the bank through the native termination settlement",
    );
  }
  if (
    !isIsoCalendarDate(run.pay_date) ||
    !isIsoCalendarDate(run.period_start) ||
    !isIsoCalendarDate(run.period_end) ||
    run.period_end < run.period_start ||
    run.pay_date < run.period_end
  ) {
    throw new PayrollError("bank cash inputs require a pay run with valid pay and period dates");
  }
  const entity = (
    await tx.execute<{
      id: string;
      name: string;
      country: string | null;
      baseCurrency: string | null;
    }>(
      sql`
    select id::text, name, country, base_currency as "baseCurrency" from subsidiaries
     where org_id=${orgId} and id=${run.subsidiary_id} and is_active for share
  `,
      "objects",
    )
  )[0];
  if (!entity) throw new PayrollError("the pay run's legal entity is missing or inactive");
  const runContext = resolvePayrollRunContext({
    payDate: run.pay_date,
    subsidiary: entity,
    runCurrency: run.currency,
  });
  if (runContext.taxYear !== run.tax_year) {
    throw new PayrollError("bank cash inputs require a tax year matching the pay date");
  }
  const rosterColumns = {
    org: sql`prof.org_id`,
    employee: sql`p.id`,
    employment: sql`prof.employment_id`,
    employer: sql`p.subsidiary_id`,
    hiredOn: sql`er.hired_on`,
    terminatedOn: sql`er.terminated_on`,
    periodStart: sql`${run.period_start}`,
    periodEnd: sql`${run.period_end}`,
    runType: sql`${run.run_type}`,
    document: sql`${documentId}`,
  };
  const profile = (
    await tx.execute<{ country: string; province: string; eligible: boolean; excluded: boolean }>(
      sql`
    select prof.country, prof.province, ${payrollEmploymentOverlapsPeriod(rosterColumns)} as eligible,
           exists(select 1 from pay_run_adjustments exclusion
             where exclusion.org_id=${orgId} and exclusion.pay_run_document_id=${documentId}
               and exclusion.employee_party_id=p.id and exclusion.adjustment_type='exclude') as excluded
      from employee_payroll_profiles prof
      join parties p on p.org_id=prof.org_id and p.id=prof.employee_party_id
      join worker_employments e on e.org_id=prof.org_id and e.id=prof.employment_id
        and e.worker_party_id=p.id and e.employer_subsidiary_id=${run.subsidiary_id}
      join pay_schedules schedule on schedule.org_id=prof.org_id and schedule.id=prof.pay_schedule_id
        and schedule.is_active and (schedule.subsidiary_id is null or schedule.subsidiary_id=${run.subsidiary_id})
      left join employee_roles er on er.org_id=p.org_id and er.party_id=p.id
     where prof.org_id=${orgId} and prof.employee_party_id=${mutation.employeePartyId}
       and prof.pay_schedule_id=${run.pay_schedule_id} and prof.is_active
       and (p.subsidiary_id is null or p.subsidiary_id=${run.subsidiary_id})
     for share of prof, p, e, schedule
  `,
      "objects",
    )
  )[0];
  if (!profile) {
    throw new PayrollError(
      "this employee has no active payroll profile and employment on the run's legal entity and schedule — review the employment, legal entity and pay schedule before recording a bank cash input",
    );
  }
  if (profile.country !== runContext.country) {
    throw new PayrollError(
      "the employee's payroll country does not match the run's legal entity — review the employment and payroll profile before recording a bank cash input",
    );
  }
  assertPayrollRegionSupported(profile.country, profile.province);
  assertPayrollTaxYearSupported(profile.country, runContext.taxYear, profile.province);
  if (!profile.eligible || profile.excluded) {
    throw new PayrollError(
      "this employee is outside the pay run's payable roster — review employment dates and include the employee before recording a bank cash input",
    );
  }
  const bankPlans = await tx.execute<{
    id: string;
    unit: string;
    kind: string;
    payment_kind: string;
    unit_of_measure: string | null;
    country: string | null;
    payout_component_id: string | null;
    deposit_component_id: string | null;
  }>(
    sql`
    select plan.id::text, plan.unit, component.kind, component.payment_kind, component.unit_of_measure, component.country,
           plan.payout_component_id::text, plan.deposit_component_id::text
      from entitlement_plans plan
      join pay_components component on component.org_id=plan.org_id
        and component.id=${mutation.componentId} and component.is_active
     where plan.org_id=${orgId} and plan.is_active and plan.unit in ('hours', 'money')
       and (plan.payout_component_id=${mutation.componentId} or plan.deposit_component_id=${mutation.componentId})
     order by plan.id
     for share of plan, component
  `,
    "objects",
  );
  const plan = bankPlans[0];
  const componentMatchesDirection =
    plan !== undefined &&
    (cmp(hours, "0") < 0
      ? plan.deposit_component_id === mutation.componentId
      : plan.payout_component_id === mutation.componentId);
  if (
    bankPlans.length !== 1 ||
    !["hours", "money"].includes(plan!.unit) ||
    plan!.kind !== "earning" ||
    plan!.payment_kind !== "cash" ||
    plan!.unit_of_measure === "quantity" ||
    (plan!.country !== null && plan!.country !== runContext.country) ||
    plan!.payout_component_id === plan!.deposit_component_id ||
    !componentMatchesDirection
  ) {
    throw new PayrollError(
      "choose one active bank payout or deposit component configured as a cash earning before recording its issued hours",
    );
  }
  await assertBankDepositAdjustment(tx, {
    orgId,
    componentId: mutation.componentId,
    amount,
    hours,
    terminationRun: run.run_type === "termination",
  });

  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${requestId}))`);
  const prior = (
    await tx.execute<
      Record<string, unknown> & {
        id: string;
        org_id: string;
        pay_run_document_id: string;
        employee_party_id: string;
        component_id: string;
        amount: string;
        hours: string;
        note: string | null;
        adjustment_type: string;
        replace_component: boolean;
        earned_from: string | null;
        earned_to: string | null;
      }
    >(
      sql`
    select id::text, org_id::text, pay_run_document_id::text, employee_party_id::text,
           component_id::text, amount::text, hours::text, note, adjustment_type, replace_component, earned_from::text, earned_to::text
      from pay_run_adjustments where id=${requestId} for update
  `,
      "objects",
    )
  )[0];
  if (prior && prior.org_id !== orgId) throw new PayRunAdjustmentIdempotencyConflict("foreign-key");
  if (prior) {
    const evidence = parseBankCashInputEvidence(prior.note);
    const same =
      prior.adjustment_type === "line" &&
      prior.replace_component === false &&
      prior.earned_from === null &&
      prior.earned_to === null &&
      prior.pay_run_document_id === documentId &&
      prior.employee_party_id === mutation.employeePartyId &&
      prior.component_id === mutation.componentId &&
      normalizeMoney(prior.amount) === amount &&
      canonicalAdjustmentHours(prior.hours, prior.amount) === hours &&
      evidence?.kind === "bank_cash_input" &&
      evidence.requestId === requestId &&
      evidence.reason === reason &&
      evidence.sourceReference === sourceReference &&
      evidence.rate === rateExact &&
      (evidence.outsideBankAmount ?? null) === outsideBankAmount;
    if (!same) throw new PayRunAdjustmentIdempotencyConflict("changed-payload");
    return { replayed: true };
  }
  const historicalUse =
    (
      await tx.execute(
        sql`
    select 1 from audit_log
     where org_id=${orgId} and table_name='pay_run_adjustments' and row_id=${requestId}
     limit 1
  `,
        "objects",
      )
    ).length > 0;
  if (historicalUse) throw new PayRunAdjustmentIdempotencyConflict("corrected-request");
  const inserted = (
    await tx.execute<Record<string, unknown> & { id: string }>(
      sql`
    insert into pay_run_adjustments
      (id, org_id, pay_run_document_id, employee_party_id, adjustment_type,
       component_id, amount, hours, replace_component, note, created_by, updated_by)
    values
      (${requestId}, ${orgId}, ${documentId}, ${mutation.employeePartyId}, 'line',
       ${mutation.componentId}, ${amount}, ${hours}, false, ${note}, ${actorId}, ${actorId})
    returning *
  `,
      "objects",
    )
  )[0];
  if (!inserted) throw new PayrollError("bank cash input was not saved");
  changes.push({ id: inserted.id, before: null, after: inserted });
  return { changes };
}

export async function applyEmployerLevyAdjustment(
  ctx: AuditedAdjustmentContext,
  mutation: Extract<PayRunAdjustmentMutation, { action: "employer_levy_adjustment" }>,
): Promise<AuditedAdjustmentOutcome> {
  const { tx, orgId, actorId, documentId, run } = ctx;
  const changes: AdjustmentAuditChange[] = [];
  if (!isEmployerLevyProgramKey(mutation.programKey)) {
    throw new PayrollError(
      "employer levy adjustment needs an employer-only levy programme (ca_eht or ca_wcb) — employee-side amounts are recorded through their own audited inputs",
    );
  }
  const program = EMPLOYER_LEVY_PROGRAMS[mutation.programKey];
  const amount = persistAdjustmentMoney(canonicalEmployerLevyAdjustmentAmount(mutation.amount));
  const sourceKey = canonicalLevySourceKey(mutation.sourceKey);
  if (sourceKey === null) {
    throw new PayrollError(
      "employer levy adjustment needs the issued source record's stable key (no spaces, at most 200 characters) so the same issued amount cannot be recorded twice",
    );
  }
  const reason = mutation.reason.trim();
  const sourceReference = mutation.sourceReference.trim();
  if (reason.length === 0 || reason.length > 500)
    throw new PayrollError("employer levy adjustment reason must contain 1 to 500 characters");
  if (sourceReference.length === 0 || sourceReference.length > 300)
    throw new PayrollError(
      "employer levy adjustment source reference must contain 1 to 300 characters",
    );
  if (!isUuid(mutation.idempotencyKey))
    throw new PayrollError(
      "employer levy adjustment needs a UUID Idempotency-Key; retry with a request key",
    );
  const requestId = mutation.idempotencyKey.toLowerCase();
  const workerCompGroupId = mutation.workerCompGroupId ?? null;
  if (mutation.programKey === "ca_wcb" && workerCompGroupId === null) {
    throw new PayrollError(
      "a WCB/WSIB levy adjustment needs the worker-compensation group the issued premium belongs to — select the employee's group before recording it",
    );
  }
  if (mutation.programKey === "ca_eht" && workerCompGroupId !== null) {
    throw new PayrollError(
      "an employer health tax adjustment has no worker-compensation group — remove the group and record it against ca_eht alone",
    );
  }
  const note = employerLevyAdjustmentEvidence({
    programKey: mutation.programKey,
    workerCompGroupId,
    sourceKey,
    reason,
    sourceReference,
    requestId,
  });

  if (run.run_type === "termination") {
    throw new PayrollError(
      "employer levy adjustments require an ordinary editable run — record the issued true-up on a supplemental run for its period",
    );
  }
  if (
    !isIsoCalendarDate(run.pay_date) ||
    !isIsoCalendarDate(run.period_start) ||
    !isIsoCalendarDate(run.period_end) ||
    run.period_end < run.period_start ||
    run.pay_date < run.period_end
  ) {
    throw new PayrollError(
      "employer levy adjustments require a pay run with valid pay and period dates",
    );
  }
  const entity = (
    await tx.execute<{
      id: string;
      name: string;
      country: string | null;
      baseCurrency: string | null;
    }>(
      sql`
    select id::text, name, country, base_currency as "baseCurrency" from subsidiaries
     where org_id=${orgId} and id=${run.subsidiary_id} and is_active for share
  `,
      "objects",
    )
  )[0];
  if (!entity) throw new PayrollError("the pay run's legal entity is missing or inactive");
  const runContext = resolvePayrollRunContext({
    payDate: run.pay_date,
    subsidiary: entity,
    runCurrency: run.currency,
  });
  if (
    runContext.country !== EMPLOYER_LEVY_PROGRAMS[mutation.programKey].country ||
    runContext.taxYear !== run.tax_year
  ) {
    throw new PayrollError(
      "employer levy adjustments require a Canadian pay run with a tax year matching its pay date",
    );
  }
  const rosterColumns = {
    org: sql`prof.org_id`,
    employee: sql`p.id`,
    employment: sql`prof.employment_id`,
    employer: sql`p.subsidiary_id`,
    hiredOn: sql`er.hired_on`,
    terminatedOn: sql`er.terminated_on`,
    periodStart: sql`${run.period_start}`,
    periodEnd: sql`${run.period_end}`,
    runType: sql`${run.run_type}`,
    document: sql`${documentId}`,
  };
  const profile = (
    await tx.execute<{ country: string; province: string; eligible: boolean; excluded: boolean }>(
      sql`
    select prof.country, prof.province, ${payrollEmploymentOverlapsPeriod(rosterColumns)} as eligible,
           exists(select 1 from pay_run_adjustments exclusion
             where exclusion.org_id=${orgId} and exclusion.pay_run_document_id=${documentId}
               and exclusion.employee_party_id=p.id and exclusion.adjustment_type='exclude') as excluded
      from employee_payroll_profiles prof
      join parties p on p.org_id=prof.org_id and p.id=prof.employee_party_id
      join worker_employments e on e.org_id=prof.org_id and e.id=prof.employment_id
        and e.worker_party_id=p.id and e.employer_subsidiary_id=${run.subsidiary_id}
      join pay_schedules schedule on schedule.org_id=prof.org_id and schedule.id=prof.pay_schedule_id
        and schedule.is_active and (schedule.subsidiary_id is null or schedule.subsidiary_id=${run.subsidiary_id})
      left join employee_roles er on er.org_id=p.org_id and er.party_id=p.id
     where prof.org_id=${orgId} and prof.employee_party_id=${mutation.employeePartyId}
       and prof.pay_schedule_id=${run.pay_schedule_id} and prof.is_active
       and (p.subsidiary_id is null or p.subsidiary_id=${run.subsidiary_id})
     for share of prof, p, e, schedule
  `,
      "objects",
    )
  )[0];
  if (!profile) {
    throw new PayrollError(
      "this employee has no active payroll profile and employment on the run's legal entity and schedule — review the employment, legal entity and pay schedule before recording a levy adjustment",
    );
  }
  if (profile.country !== EMPLOYER_LEVY_PROGRAMS[mutation.programKey].country) {
    throw new PayrollError(
      "employer levy adjustments are available only for Canadian payroll profiles with a native Canadian levy line",
    );
  }
  assertPayrollRegionSupported(profile.country, profile.province);
  assertPayrollTaxYearSupported(profile.country, runContext.taxYear, profile.province);
  if (!profile.eligible || profile.excluded) {
    throw new PayrollError(
      "this employee is outside the pay run's payable roster — review employment dates and include the employee before recording a levy adjustment",
    );
  }
  // The programme must be configured for this employee before an issued
  // amount can post against it: an unconfigured programme has no native
  // rate, account or filing home, so the adjustment refuses here rather
  // than calculating into a silent zero.
  if (mutation.programKey === "ca_eht") {
    const config = await caPayrollConfig(orgId, runContext.taxYear, run.pay_date);
    if (!config.eht(profile.province)) {
      throw new PayrollError(
        `CA ${profile.province} employer health tax is not configured for ${runContext.taxYear} — configure the ca_eht rate in Payroll Setup → Statutory rates before recording an EHT adjustment`,
      );
    }
  } else {
    const group = (
      await tx.execute<{ rate_percent: string | null; is_active: boolean }>(
        sql`
      select rate_percent::text, is_active from worker_comp_groups
       where org_id=${orgId} and id=${workerCompGroupId} for share
    `,
        "objects",
      )
    )[0];
    if (
      !group ||
      !group.is_active ||
      group.rate_percent === null ||
      cmp(group.rate_percent, "0") < 0
    ) {
      throw new PayrollError(
        "the named worker-compensation group is missing, inactive or has no configured rate — review it in Company Setup → Worker compensation groups before recording a WCB/WSIB adjustment",
      );
    }
    const datedGroupId =
      (
        await tx.execute<{ id: string | null }>(
          sql`
      select public.payroll_worker_comp_group_at(${orgId}::uuid, ${mutation.employeePartyId}::uuid, ${run.pay_date}::date)::text as id
    `,
          "objects",
        )
      )[0]?.id ?? null;
    if (datedGroupId !== workerCompGroupId) {
      throw new PayrollError(
        "the named worker-compensation group is not this employee's group on the run's pay date — record the adjustment against the group that assessed the issued premium, on a run dated while the employee belonged to it",
      );
    }
  }
  const levyComponents = await tx.execute<{ id: string }>(
    sql`
    select id::text from pay_components
     where org_id=${orgId} and country='CA' and system_key=${program.systemKey}
       and kind='employer_contribution' and is_active
     order by id for share
  `,
    "objects",
  );
  if (levyComponents.length !== 1) {
    throw new PayrollError(
      `configure exactly one active Canadian ${program.label} employer-contribution component before recording a levy adjustment`,
    );
  }
  const componentId = levyComponents[0]!.id;

  // One issued source record, one recording: the source key locks
  // duplicate submissions before either can claim it, whatever request
  // key a retry arrives under.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${"employer-levy-source:" + orgId + ":" + sourceKey}))`,
  );
  const sameSource = (
    await tx.execute<{ id: string; note: string | null }>(
      sql`
    select id::text, note from pay_run_adjustments
     where org_id=${orgId} and adjustment_type='line'
       and note ~ '"kind"[[:space:]]*:[[:space:]]*"employer_levy_adjustment"'
       and strpos(note, ${JSON.stringify(sourceKey)}) > 0
     order by id for update
  `,
      "objects",
    )
  ).filter((row) => parseEmployerLevyAdjustmentEvidence(row.note)?.sourceKey === sourceKey);
  const foreignSource = sameSource.find((row) => row.id !== requestId);
  if (foreignSource) {
    throw new PayRunAdjustmentIdempotencyConflict("source-recorded");
  }
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${requestId}))`);
  const prior = (
    await tx.execute<
      Record<string, unknown> & {
        id: string;
        org_id: string;
        pay_run_document_id: string;
        employee_party_id: string;
        component_id: string;
        amount: string;
        hours: string | null;
        note: string | null;
        adjustment_type: string;
        replace_component: boolean;
        earned_from: string | null;
        earned_to: string | null;
      }
    >(
      sql`
    select id::text, org_id::text, pay_run_document_id::text, employee_party_id::text,
           component_id::text, amount::text, hours::text, note, adjustment_type, replace_component, earned_from::text, earned_to::text
      from pay_run_adjustments where id=${requestId} for update
  `,
      "objects",
    )
  )[0];
  if (prior && prior.org_id !== orgId) throw new PayRunAdjustmentIdempotencyConflict("foreign-key");
  if (prior) {
    const evidence = parseEmployerLevyAdjustmentEvidence(prior.note);
    const same =
      prior.adjustment_type === "line" &&
      prior.replace_component === false &&
      prior.hours === null &&
      prior.earned_from === null &&
      prior.earned_to === null &&
      prior.pay_run_document_id === documentId &&
      prior.employee_party_id === mutation.employeePartyId &&
      prior.component_id === componentId &&
      normalizeMoney(prior.amount) === amount &&
      evidence?.kind === "employer_levy_adjustment" &&
      evidence.requestId === requestId &&
      evidence.programKey === mutation.programKey &&
      evidence.workerCompGroupId === workerCompGroupId &&
      evidence.sourceKey === sourceKey &&
      evidence.reason === reason &&
      evidence.sourceReference === sourceReference;
    if (!same) throw new PayRunAdjustmentIdempotencyConflict("changed-payload");
    return { replayed: true };
  }
  const historicalUse =
    (
      await tx.execute(
        sql`
    select 1 from audit_log
     where org_id=${orgId} and table_name='pay_run_adjustments' and row_id=${requestId}
     limit 1
  `,
        "objects",
      )
    ).length > 0;
  if (historicalUse) throw new PayRunAdjustmentIdempotencyConflict("corrected-request");
  const priorSourceEvents = await tx.execute<{ note: string | null }>(
    sql`
    select changes->'after'->>'note' as note from audit_log
     where org_id=${orgId} and table_name='pay_run_adjustments'
       and changes->'after'->>'note' ~ '"kind"[[:space:]]*:[[:space:]]*"employer_levy_adjustment"'
       and strpos(changes->'after'->>'note', ${JSON.stringify(sourceKey)}) > 0
  `,
    "objects",
  );
  if (
    priorSourceEvents.some(
      (row) => parseEmployerLevyAdjustmentEvidence(row.note)?.sourceKey === sourceKey,
    )
  ) {
    throw new PayRunAdjustmentIdempotencyConflict("source-recorded");
  }

  const inserted = (
    await tx.execute<Record<string, unknown> & { id: string }>(
      sql`
    insert into pay_run_adjustments
      (id, org_id, pay_run_document_id, employee_party_id, adjustment_type,
       component_id, amount, replace_component, note, created_by, updated_by)
    values
      (${requestId}, ${orgId}, ${documentId}, ${mutation.employeePartyId}, 'line',
       ${componentId}, ${amount}, false, ${note}, ${actorId}, ${actorId})
    returning *
  `,
      "objects",
    )
  )[0];
  if (!inserted) throw new PayrollError("employer levy adjustment was not saved");
  changes.push({ id: inserted.id, before: null, after: inserted });
  return { changes };
}

export async function applyDeclaredVacationAccrual(
  ctx: AuditedAdjustmentContext,
  mutation: Extract<PayRunAdjustmentMutation, { action: "declared_vacation_accrual" }>,
): Promise<AuditedAdjustmentOutcome> {
  const { tx, orgId, actorId, documentId } = ctx;
  const changes: AdjustmentAuditChange[] = [];
  const exactCurrencyAmount = canonicalDecimal(mutation.amount, 2);
  if (exactCurrencyAmount === null || cmp(exactCurrencyAmount, "0") <= 0) {
    throw new PayrollError(
      "declared vacation accrual must be a positive exact currency amount in cents",
    );
  }
  const amount = persistAdjustmentMoney(exactCurrencyAmount);
  const reason = mutation.reason.trim();
  const sourceReference = mutation.sourceReference.trim();
  if (!reason || reason.length > 500)
    throw new PayrollError("declared vacation accrual reason must contain 1 to 500 characters");
  if (!sourceReference || sourceReference.length > 300)
    throw new PayrollError(
      "declared vacation accrual source reference must contain 1 to 300 characters",
    );
  if (!isUuid(mutation.idempotencyKey))
    throw new PayrollError(
      "declared vacation accrual needs a UUID Idempotency-Key; retry with a request key",
    );
  const requestId = mutation.idempotencyKey.toLowerCase();
  const planRows = await tx.execute<{
    id: string;
    accrual_component_id: string | null;
    unit: string;
    direction: string;
    component_kind: string | null;
    component_active: boolean | null;
  }>(
    sql`
    select plan.id::text, plan.accrual_component_id::text, plan.unit, plan.direction,
           component.kind as component_kind, component.is_active as component_active
      from entitlement_plans plan
      left join pay_components component
        on component.org_id=plan.org_id and component.id=plan.accrual_component_id
     where plan.org_id=${orgId} and plan.system_key='vacation' and plan.is_active
     order by plan.id for share of plan
  `,
    "objects",
  );
  if (
    planRows.length !== 1 ||
    !planRows[0]!.accrual_component_id ||
    planRows[0]!.unit !== "money" ||
    planRows[0]!.direction !== "accrue" ||
    planRows[0]!.component_kind !== "employer_contribution" ||
    planRows[0]!.component_active !== true
  ) {
    throw new PayrollError(
      "configure one active money-denominated vacation accrual plan with an active employer contribution component before recording a declared accrual",
    );
  }
  const componentId = planRows[0]!.accrual_component_id;
  const lockedComponent = await tx.execute(
    sql`
    select id from pay_components where org_id=${orgId} and id=${componentId}
      and kind='employer_contribution' and is_active for share
  `,
    "objects",
  );
  if (lockedComponent.length !== 1) {
    throw new PayrollError(
      "the vacation accrual component changed — reload the active vacation plan before recording a declared accrual",
    );
  }
  const note = declaredVacationAccrualEvidence(reason, sourceReference, requestId);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${requestId}))`);
  const prior = (
    await tx.execute<
      Record<string, unknown> & {
        id: string;
        org_id: string;
        pay_run_document_id: string;
        employee_party_id: string;
        component_id: string;
        amount: string;
        note: string | null;
      }
    >(
      sql`
    select id::text, org_id::text, pay_run_document_id::text, employee_party_id::text,
           component_id::text, amount::text, note
      from pay_run_adjustments where id=${requestId} for update
  `,
      "objects",
    )
  )[0];
  if (prior && prior.org_id !== orgId) throw new PayRunAdjustmentIdempotencyConflict("foreign-key");
  if (prior) {
    const evidence = parseDeclaredVacationAccrualEvidence(prior.note);
    const same =
      prior.pay_run_document_id === documentId &&
      prior.employee_party_id === mutation.employeePartyId &&
      prior.component_id === componentId &&
      normalizeMoney(prior.amount) === amount &&
      evidence?.requestId === requestId &&
      evidence.reason === reason &&
      evidence.sourceReference === sourceReference;
    if (!same) throw new PayRunAdjustmentIdempotencyConflict("changed-payload");
    return { replayed: true };
  }
  const alreadyRecorded =
    (
      await tx.execute(
        sql`
    select 1 from pay_run_adjustments
     where org_id=${orgId} and pay_run_document_id=${documentId}
       and employee_party_id=${mutation.employeePartyId} and adjustment_type='line'
       and note ~ '"kind"[[:space:]]*:[[:space:]]*"declared_vacation_accrual"'
     limit 1 for update
  `,
        "objects",
      )
    ).length > 0;
  if (alreadyRecorded)
    throw new PayrollError(
      "this cheque already has a declared vacation accrual — delete that audited input before recording a corrected amount",
    );
  const historicalUse =
    (
      await tx.execute(
        sql`
    select 1 from audit_log
     where org_id=${orgId} and table_name='pay_run_adjustments' and row_id=${requestId}
     limit 1
  `,
        "objects",
      )
    ).length > 0;
  if (historicalUse) throw new PayRunAdjustmentIdempotencyConflict("corrected-request");
  const inserted = (
    await tx.execute<Record<string, unknown> & { id: string }>(
      sql`
    insert into pay_run_adjustments
      (id, org_id, pay_run_document_id, employee_party_id, adjustment_type,
       component_id, amount, replace_component, note, created_by, updated_by)
    values
      (${requestId}, ${orgId}, ${documentId}, ${mutation.employeePartyId}, 'line',
       ${componentId}, ${amount}, false, ${note}, ${actorId}, ${actorId})
    returning *
  `,
      "objects",
    )
  )[0];
  if (!inserted) throw new PayrollError("declared vacation accrual was not saved");
  changes.push({ id: inserted.id, before: null, after: inserted });
  return { changes };
}

export async function applyIncomeTaxOverride(
  ctx: AuditedAdjustmentContext,
  mutation: Extract<PayRunAdjustmentMutation, { action: "override_income_tax" }>,
): Promise<AuditedAdjustmentOutcome> {
  const { tx, orgId, actorId, documentId, run } = ctx;
  const changes: AdjustmentAuditChange[] = [];
  const exactCurrencyAmount = canonicalDecimal(mutation.amount, 2);
  if (exactCurrencyAmount === null) {
    throw new PayrollError(
      "income-tax override must be an exact currency amount of at most 2 decimal places",
    );
  }
  const amount = persistAdjustmentMoney(exactCurrencyAmount);
  if (cmp(amount, "0") < 0) {
    throw new PayrollError(
      "income-tax override cannot be negative — enter the absolute non-negative amount withheld on this cheque",
    );
  }
  const reason = mutation.reason.trim();
  const sourceReference = mutation.sourceReference.trim();
  if (reason.length === 0 || reason.length > 500) {
    throw new PayrollError("income-tax override reason must contain 1 to 500 characters");
  }
  if (sourceReference.length === 0 || sourceReference.length > 300) {
    throw new PayrollError("income-tax override source reference must contain 1 to 300 characters");
  }
  if (!isUuid(mutation.idempotencyKey)) {
    throw new PayrollError(
      "income-tax override needs a UUID Idempotency-Key; retry with a request key",
    );
  }
  const requestId = mutation.idempotencyKey.toLowerCase();
  const note = incomeTaxOverrideEvidence(reason, sourceReference, requestId);

  if (
    !isIsoCalendarDate(run.pay_date) ||
    !isIsoCalendarDate(run.period_start) ||
    !isIsoCalendarDate(run.period_end) ||
    run.period_end < run.period_start ||
    run.pay_date < run.period_end
  ) {
    throw new PayrollError(
      "income-tax overrides require a pay run with valid pay and period dates",
    );
  }
  const entity = (
    await tx.execute<{
      id: string;
      name: string;
      country: string | null;
      baseCurrency: string | null;
    }>(
      sql`
    select id::text, name, country, base_currency as "baseCurrency" from subsidiaries
     where org_id=${orgId} and id=${run.subsidiary_id} and is_active for share
  `,
      "objects",
    )
  )[0];
  if (!entity) throw new PayrollError("the pay run's legal entity is missing or inactive");
  const runContext = resolvePayrollRunContext({
    payDate: run.pay_date,
    subsidiary: entity,
    runCurrency: run.currency,
  });
  if (
    runContext.country !== CA_ISSUED_INCOME_TAX_OVERRIDE.country ||
    runContext.taxYear !== run.tax_year
  ) {
    throw new PayrollError(
      "income-tax overrides require a Canadian pay run with a tax year matching its pay date",
    );
  }
  const rosterColumns = {
    org: sql`prof.org_id`,
    employee: sql`p.id`,
    employment: sql`prof.employment_id`,
    employer: sql`p.subsidiary_id`,
    hiredOn: sql`er.hired_on`,
    terminatedOn: sql`er.terminated_on`,
    periodStart: sql`${run.period_start}`,
    periodEnd: sql`${run.period_end}`,
    runType: sql`${run.run_type}`,
    document: sql`${documentId}`,
  };
  const profile = (
    await tx.execute<{ country: string; province: string; eligible: boolean; excluded: boolean }>(
      sql`
    select prof.country, prof.province, ${payrollEmploymentOverlapsPeriod(rosterColumns)} as eligible,
           exists(select 1 from pay_run_adjustments exclusion
             where exclusion.org_id=${orgId} and exclusion.pay_run_document_id=${documentId}
               and exclusion.employee_party_id=p.id and exclusion.adjustment_type='exclude') as excluded
      from employee_payroll_profiles prof
      join parties p on p.org_id=prof.org_id and p.id=prof.employee_party_id
      join worker_employments e on e.org_id=prof.org_id and e.id=prof.employment_id
        and e.worker_party_id=p.id and e.employer_subsidiary_id=${run.subsidiary_id}
      join pay_schedules schedule on schedule.org_id=prof.org_id and schedule.id=prof.pay_schedule_id
        and schedule.is_active and (schedule.subsidiary_id is null or schedule.subsidiary_id=${run.subsidiary_id})
      left join employee_roles er on er.org_id=p.org_id and er.party_id=p.id
     where prof.org_id=${orgId} and prof.employee_party_id=${mutation.employeePartyId}
       and prof.pay_schedule_id=${run.pay_schedule_id} and prof.is_active
       and (p.subsidiary_id is null or p.subsidiary_id=${run.subsidiary_id})
     for share of prof, p, e, schedule
  `,
      "objects",
    )
  )[0];
  if (!profile) {
    throw new PayrollError(
      "this employee has no active payroll profile and employment on the run's legal entity and schedule — review the employment, legal entity and pay schedule before recording cheque withholding",
    );
  }
  if (profile.country !== CA_ISSUED_INCOME_TAX_OVERRIDE.country) {
    throw new PayrollError(
      "income-tax override is available only for Canadian payroll profiles with a native Canadian withholding line",
    );
  }
  if (
    (CA_ISSUED_INCOME_TAX_OVERRIDE.excludedRegions as readonly string[]).includes(profile.province)
  ) {
    throw new PayrollError(
      "a single total cannot override Québec federal and provincial withholding separately — use native Québec calculation without an override",
    );
  }
  assertPayrollRegionSupported(profile.country, profile.province);
  assertPayrollTaxYearSupported(profile.country, runContext.taxYear, profile.province);
  if (!profile.eligible || profile.excluded) {
    throw new PayrollError(
      "this employee is outside the pay run's payable roster — review employment dates and include the employee before recording cheque withholding",
    );
  }
  const taxComponents = await tx.execute<{ id: string }>(
    sql`
    select id::text from pay_components
     where org_id=${orgId} and country='CA' and system_key='income_tax'
       and kind='deduction' and is_active
     order by id for share
  `,
    "objects",
  );
  if (taxComponents.length !== 1) {
    throw new PayrollError(
      "configure exactly one active Canadian income-tax withholding component before overriding this cheque",
    );
  }
  const componentId = taxComponents[0]!.id;

  // The key locks duplicate requests before either can claim/update the
  // operator input. The row itself is unique per employee and run; a later
  // correction updates it with a before/after audit event.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${requestId}))`);
  const keyRow = (
    await tx.execute<{ id: string; org_id: string }>(
      sql`
    select id::text, org_id
      from pay_run_adjustments where id=${requestId} for update
  `,
      "objects",
    )
  )[0];
  if (keyRow && keyRow.org_id !== orgId) {
    throw new PayRunAdjustmentIdempotencyConflict("foreign-key");
  }
  const overrides = await tx.execute<
    Record<string, unknown> & {
      id: string;
      component_id: string;
      amount: string | null;
      note: string | null;
    }
  >(
    sql`
    select a.* from pay_run_adjustments a
      join pay_components c on c.org_id=a.org_id and c.id=a.component_id
     where a.org_id=${orgId} and a.pay_run_document_id=${documentId}
       and a.employee_party_id=${mutation.employeePartyId} and a.adjustment_type='line'
       and a.replace_component and c.system_key='income_tax'
     order by a.id for update of a
  `,
    "objects",
  );
  if (overrides.length > 1) {
    throw new PayrollError(
      "this employee has multiple income-tax overrides on the run — remove the duplicate adjustment before recalculating",
    );
  }
  const currentOverride = overrides[0];
  const currentEvidence = currentOverride
    ? parseIncomeTaxOverrideEvidence(currentOverride.note)
    : null;
  if (currentOverride && currentEvidence?.requestId === requestId) {
    const same =
      (!keyRow || keyRow.id === currentOverride.id) &&
      currentOverride.component_id === componentId &&
      currentOverride.amount !== null &&
      canonicalDecimal(canonicalDecimal(currentOverride.amount, 4), 2) !== null &&
      normalizeMoney(currentOverride.amount) === amount &&
      currentEvidence.reason === reason &&
      currentEvidence.sourceReference === sourceReference;
    if (!same) throw new PayRunAdjustmentIdempotencyConflict("changed-payload");
    return { replayed: true };
  }

  // Audit snapshots prove a request key was consumed. A corrected or
  // removed input cannot be replayed from historical evidence: success
  // must resolve to the current native adjustment and request identity.
  const historicalKeys = await tx.execute<{ changes: Record<string, unknown> }>(
    sql`
    select changes from audit_log
     where org_id=${orgId} and table_name='pay_run_adjustments'
       and changes::text like ${`%${requestId}%`}
     order by at, id
  `,
    "objects",
  );
  let requestKeyFound = false;
  for (const event of historicalKeys) {
    const snapshots = [event.changes?.before, event.changes?.after];
    for (const snapshot of snapshots) {
      if (!snapshot || typeof snapshot !== "object") continue;
      const row = snapshot as Record<string, unknown>;
      const evidence = parseIncomeTaxOverrideEvidence(
        typeof row.note === "string" ? row.note : null,
      );
      if (evidence?.requestId !== requestId) continue;
      requestKeyFound = true;
    }
  }
  if (requestKeyFound) throw new PayRunAdjustmentIdempotencyConflict("corrected-request");
  if (keyRow) throw new PayRunAdjustmentIdempotencyConflict("changed-payload");
  if (overrides.length === 1) {
    const prior = overrides[0]!;
    const updated = (
      await tx.execute<Record<string, unknown> & { id: string }>(
        sql`
      update pay_run_adjustments
         set component_id=${componentId}, amount=${amount}, hours=null,
             earned_from=null, earned_to=null, replace_component=true,
             note=${note}, updated_by=${actorId}, updated_at=now()
       where org_id=${orgId} and pay_run_document_id=${documentId} and id=${prior.id}
      returning *
    `,
        "objects",
      )
    )[0];
    if (!updated) throw new PayrollError("income-tax override was not updated");
    changes.push({ id: updated.id, before: prior, after: updated });
  } else {
    const inserted = (
      await tx.execute<Record<string, unknown> & { id: string }>(
        sql`
      insert into pay_run_adjustments
        (id, org_id, pay_run_document_id, employee_party_id, adjustment_type,
         component_id, amount, replace_component, note, created_by, updated_by)
      values
        (${requestId}, ${orgId}, ${documentId}, ${mutation.employeePartyId}, 'line',
         ${componentId}, ${amount}, true, ${note}, ${actorId}, ${actorId})
      returning *
    `,
        "objects",
      )
    )[0];
    if (!inserted) throw new PayrollError("income-tax override was not saved");
    changes.push({ id: inserted.id, before: null, after: inserted });
  }
  return { changes };
}
