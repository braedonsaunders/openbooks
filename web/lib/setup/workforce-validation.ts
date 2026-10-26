import "server-only";
import type { SetupEntityValidationHook } from "./types";

// The shared command fences the supplied actor's employment scope in its
// write transaction. Validation has no browser-session dependency.
export const validateServiceCredit: SetupEntityValidationHook = async ({
  body,
  orgId,
  rowId,
  executor,
}) => {
  const { sql } = await import("drizzle-orm");
  const { validateServiceCreditConfiguration } =
    await import("@openbooks/engine/payroll/entitlements");
  const { PayrollError } = await import("@openbooks/engine/payroll/entitlements");
  let values = { ...body };
  if (rowId) {
    const row = (
      await executor.execute<Record<string, unknown>>(
        sql`select * from payroll_service_credits where org_id=${orgId} and id=${rowId}`,
        "objects",
      )
    )[0];
    if (!row) return "Service credit no longer exists; reopen its employment";
    values = {
      ...Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
          value,
        ]),
      ),
      ...values,
    };
  }
  const employment = (
    await executor.execute<{ employer_subsidiary_id: string }>(
      sql`select employer_subsidiary_id from worker_employments where org_id=${orgId} and id=${String(values.employmentId ?? "")}`,
      "objects",
    )
  )[0];
  if (!employment) return "Select an employment in this organization";
  try {
    await validateServiceCreditConfiguration(executor, orgId, values, rowId);
    return null;
  } catch (error) {
    if (error instanceof PayrollError) return error.message;
    throw error;
  }
};

export const validateEntitlementPlan: SetupEntityValidationHook = async ({
  body,
  orgId,
  rowId,
  executor,
}) => {
  const { sql } = await import("drizzle-orm");
  const { validateEntitlementPlanConfiguration } =
    await import("@openbooks/engine/payroll/entitlements");
  const { PayrollError } = await import("@openbooks/engine/payroll/entitlements");
  let values = { ...body };
  if (rowId) {
    const row = (
      await executor.execute<Record<string, unknown>>(
        sql`select direction, payout_component_id, deposit_component_id from entitlement_plans where org_id=${orgId} and id=${rowId}`,
        "objects",
      )
    )[0];
    if (!row) return "Entitlement plan no longer exists; reopen Benefits programs";
    values = {
      direction: row.direction,
      payoutComponentId: row.payout_component_id ?? null,
      depositComponentId: row.deposit_component_id ?? null,
      ...values,
    };
  }
  try {
    await validateEntitlementPlanConfiguration(executor, orgId, values);
    return null;
  } catch (error) {
    if (error instanceof PayrollError) return error.message;
    throw error;
  }
};

export const validateLeavePayrollEntitlementMapping: SetupEntityValidationHook = async ({
  body,
  orgId,
  rowId,
  executor,
}) => {
  const { sql } = await import("drizzle-orm");
  const current = rowId
    ? (
        await executor.execute<{
          leave_type_id: string;
          entitlement_plan_id: string;
          is_active: boolean;
        }>(
          sql`
        select leave_type_id::text, entitlement_plan_id::text, is_active
          from hrm_leave_payroll_entitlement_mappings where org_id = ${orgId} and id = ${rowId}`,
          "objects",
        )
      )[0]
    : null;
  if (rowId && !current)
    return "The leave entitlement mapping no longer exists; reopen the leave type in Setup";
  const leaveTypeId = String(body.leaveTypeId ?? current?.leave_type_id ?? "");
  const planId = String(body.entitlementPlanId ?? current?.entitlement_plan_id ?? "");
  const effectiveFrom = String(body.effectiveFrom ?? "");
  const active =
    body.isActive === undefined ? (current?.is_active ?? true) : body.isActive === true;
  const reason = String(body.reason ?? "").trim();
  if (!leaveTypeId || !planId || !effectiveFrom) return null;
  if (reason.length < 8 || reason.length > 500)
    return "Enter a change reason from 8 to 500 characters for the leave entitlement mapping.";
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${orgId} || ':' || ${leaveTypeId}, 0))`,
  );
  const alreadyCalculated = (
    await executor.execute(
      sql`
    select 1 from hrm_payroll_inputs
     where org_id = ${orgId} and leave_type_id = ${leaveTypeId}
       and status = 'consumed' and absence_date >= ${effectiveFrom}::date
     limit 1
  `,
      "objects",
    )
  )[0];
  if (alreadyCalculated)
    return "This effective date would change leave already calculated in payroll; choose a later date, or release and recalculate the affected pay run before adding the mapping.";
  const leaveType = (
    await executor.execute<{ value_crossing: string }>(
      sql`
    select value_crossing from hrm_leave_types where org_id = ${orgId} and id = ${leaveTypeId}`,
      "objects",
    )
  )[0];
  if (!leaveType) return "Choose a leave type in this organization";
  if (leaveType.value_crossing !== "bank_in")
    return "Only a leave type that banks approved hours can map to an entitlement plan; change its payroll treatment to bank_in first.";
  if (!active) return null;
  const plan = (
    await executor.execute<{
      unit: string;
      direction: string;
      system_key: string | null;
      is_active: boolean;
    }>(
      sql`
    select unit, direction, system_key, is_active from entitlement_plans
     where org_id = ${orgId} and id = ${planId}`,
      "objects",
    )
  )[0];
  if (
    !plan?.is_active ||
    plan.unit !== "hours" ||
    plan.direction !== "accrue" ||
    plan.system_key === "vacation"
  ) {
    return "Choose an active hours-based accruing entitlement plan other than Vacation in Benefits, then add a new effective-dated mapping.";
  }
  return null;
};

export const validateVacationTerm: SetupEntityValidationHook = async ({
  body,
  orgId,
  rowId,
  executor,
}) => {
  const { sql } = await import("drizzle-orm");
  const { validateVacationTermConfiguration } =
    await import("@openbooks/engine/payroll/entitlements");
  const { PayrollError } = await import("@openbooks/engine/payroll/entitlements");
  let values = { ...body };
  if (rowId) {
    const row = (
      await executor.execute<Record<string, unknown>>(
        sql`select * from payroll_vacation_terms where org_id=${orgId} and id=${rowId}`,
        "objects",
      )
    )[0];
    if (!row) return "Vacation terms no longer exist; reopen the employment";
    values = {
      ...Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
          value,
        ]),
      ),
      ...values,
    };
  }
  const employment = (
    await executor.execute<{ employer_subsidiary_id: string }>(
      sql`select employer_subsidiary_id from worker_employments where org_id=${orgId} and id=${String(values.employmentId ?? "")}`,
      "objects",
    )
  )[0];
  if (!employment) return "Select an employment in this organization";
  try {
    await validateVacationTermConfiguration(executor, orgId, values, rowId);
    return null;
  } catch (error) {
    if (error instanceof PayrollError) return error.message;
    throw error;
  }
};

export const validateContributionWrite: SetupEntityValidationHook = async ({
  entity,
  body,
  orgId,
  rowId,
  executor,
}) => {
  const { sql } = await import("drizzle-orm");
  const { foldWholeNumber } = await import("./whole-number");
  const { getAuthz } = await import("../authz");
  const { requireHrmBenefitsManageOnEmployment } = await import("@openbooks/engine/hrm/benefits");
  const { BenefitsError, validateBenefitContributionConfiguration } =
    await import("@openbooks/engine/hrm/benefits");
  let values = { ...body };
  if (rowId) {
    const existing = (
      await executor.execute<Record<string, unknown>>(
        sql`select * from ${sql.raw(entity.table)} where org_id=${orgId} and id=${rowId}`,
        "objects",
      )
    )[0];
    if (!existing) return "Contribution configuration no longer exists; reopen its owning record";
    const camel = Object.fromEntries(
      Object.entries(existing).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        value,
      ]),
    );
    values = { ...camel, ...values, id: rowId };
  }
  for (const field of entity.fields) {
    if (field.kind === "integer" && values[field.key] !== undefined) {
      const folded = foldWholeNumber(values[field.key]);
      values[field.key] = folded === undefined ? null : folded;
    }
  }
  try {
    if (
      entity.key === "benefit-enrollment-configuration" ||
      entity.key === "benefit-enrollment-terms"
    ) {
      const enrollmentId =
        entity.key === "benefit-enrollment-configuration"
          ? rowId
          : String(values.enrollmentId ?? "");
      if (!enrollmentId)
        return "Select the employee enrollment before editing its contribution terms";
      const enrollment = (
        await executor.execute<{
          employment_id: string;
          plan_id: string;
          status: string;
          submission_snapshot: unknown;
        }>(
          sql`select employment_id,plan_id,status,submission_snapshot from hrm_benefit_enrollments where org_id=${orgId} and id=${enrollmentId} for update`,
          "objects",
        )
      )[0];
      if (!enrollment)
        return "Employee enrollment no longer exists; reopen an enrollment in this organization";
      const authz = await getAuthz();
      if (!authz || authz.user.orgId !== orgId)
        return "The current session cannot manage this organization; reopen Benefits";
      await requireHrmBenefitsManageOnEmployment(
        executor,
        orgId,
        authz.user.id,
        enrollment.employment_id,
      );
      if (enrollment.status !== "elected" || enrollment.submission_snapshot != null)
        return "Submitted and active enrollment elections are immutable; open the active enrollment and choose Edit to create a dated replacement";
      if (entity.key === "benefit-enrollment-configuration") {
        if (values.classKey != null && values.classKey !== "") {
          const selected = (
            await executor.execute(
              sql`select id from hrm_benefit_contribution_classes where org_id=${orgId} and plan_id=${enrollment.plan_id} and class_key=${String(values.classKey)}`,
              "objects",
            )
          )[0];
          if (!selected) return "Choose an eligibility class from this enrollment plan";
        }
        return null;
      }
    }
    await validateBenefitContributionConfiguration(
      executor,
      orgId,
      entity.key as Parameters<typeof validateBenefitContributionConfiguration>[2],
      values,
    );
    return null;
  } catch (error) {
    if (error instanceof BenefitsError) return error.message;
    throw error;
  }
};

export const validateServiceTier: SetupEntityValidationHook = async ({
  body,
  orgId,
  rowId,
  executor,
}) => {
  const { validateEntitlementServiceTierConfiguration, PayrollError } =
    await import("@openbooks/engine/payroll/entitlements");
  try {
    await validateEntitlementServiceTierConfiguration(executor, orgId, body, rowId);
    return null;
  } catch (error) {
    if (error instanceof PayrollError) return error.message;
    throw error;
  }
};

/**
 * One active department expense mapping per component, department and date.
 * An overlapping active window refuses with the remedy (close the existing
 * window first) rather than storing two accounts for one posting. The
 * range-exclusion constraint is the backstop for writers around this hook.
 */
export const validateDepartmentExpenseWrite: SetupEntityValidationHook = async ({
  body,
  orgId,
  rowId,
  executor,
}) => {
  const { sql } = await import("drizzle-orm");
  const current = rowId
    ? (
        await executor.execute<{
          pay_component_id: string | null;
          department_id: string | null;
          effective_from: string | null;
          effective_to: string | null;
        }>(
          sql`select pay_component_id, department_id, effective_from::text, effective_to::text
            from pay_component_department_expenses where id = ${rowId} and org_id = ${orgId}`,
          "objects",
        )
      )[0]
    : null;
  if (rowId && !current)
    return "Department expense mapping no longer exists; reopen pay-component setup";
  // The drawer posts an untouched date input as an empty string, which is
  // "no date" here, never a date literal: an open-ended window (blank end)
  // must not reach the ::date casts below as ''.
  const text = (value: unknown): string | null =>
    value === undefined || value === null || String(value).trim() === "" ? null : String(value);
  const componentId = text(body.payComponentId) ?? current?.pay_component_id ?? null;
  const departmentId = text(body.departmentId) ?? current?.department_id ?? null;
  const from = text(body.effectiveFrom) ?? current?.effective_from ?? null;
  const through =
    body.effectiveTo === undefined ? (current?.effective_to ?? null) : text(body.effectiveTo);
  if (!componentId || !departmentId || !from) return null;
  const clashes = await executor.execute<{ id: string }>(
    sql`
    select id from pay_component_department_expenses
     where org_id = ${orgId} and is_active
       and pay_component_id = ${componentId}::uuid and department_id = ${departmentId}::uuid
       and daterange(effective_from, coalesce(effective_to, 'infinity'::date), '[]')
         && daterange(${from}::date, coalesce(${through}::date, 'infinity'::date), '[]')
       and (${rowId ?? null}::uuid is null or id <> ${rowId ?? null}::uuid)
  `,
    "objects",
  );
  if (clashes.length > 0) {
    return "This component and department already have an active expense mapping overlapping those dates — close the existing window first (set its effective-to), then add the new one.";
  }
  return null;
};
