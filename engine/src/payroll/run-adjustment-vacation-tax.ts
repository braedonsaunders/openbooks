/**
 * Declared vacation accrual and income-tax override adjustments.
 *
 * Kept beside run-adjustment-audited.ts so each operation module stays within
 * the line bound. Callers still import these operations from run-adjustment-audited.ts.
 */
import { CA_ISSUED_INCOME_TAX_OVERRIDE } from "./canada/levy-programs.ts";

import { sql } from "drizzle-orm";

import { isIsoCalendarDate } from "../platform/iso-date.ts";

import { canonicalDecimal } from "../money/exact-decimal.ts";

import { cmp, normalizeMoney } from "../money/money.ts";

import { PayrollError } from "./error.ts";

import { payrollEmploymentOverlapsPeriod } from "./employment-roster.ts";

import {
  declaredVacationAccrualEvidence,
  parseDeclaredVacationAccrualEvidence,
} from "./run-vacation-accrual-input.ts";

import {
  resolvePayrollRunContext,
  assertPayrollRegionSupported,
  assertPayrollTaxYearSupported,
} from "./packs.ts";

import { isUuid } from "../platform/uuid.ts";

import type { SqlExecutor } from "../platform/db.ts";

import {
  PayRunAdjustmentIdempotencyConflict,
  persistAdjustmentMoney,
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
