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

import {
  PayRunAdjustmentIdempotencyConflict,
  persistAdjustmentMoney,
  persistAdjustmentHours,
  canonicalAdjustmentHours,
  type PayRunAdjustmentMutation,
} from "./run-adjustment-values.ts";

import type {
  AdjustmentAuditChange,
  AdjustmentRun,
  AuditedAdjustmentContext,
  AuditedAdjustmentOutcome,
} from "./run-adjustment-vacation-tax.ts";

export type {
  AdjustmentAuditChange,
  AdjustmentRun,
  AuditedAdjustmentContext,
  AuditedAdjustmentOutcome,
};
export {
  applyDeclaredVacationAccrual,
  applyIncomeTaxOverride,
} from "./run-adjustment-vacation-tax.ts";

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
