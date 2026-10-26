import "server-only";
import { isUuid } from "../list-params";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "@openbooks/engine/platform/db";
import {
  validateUsFilingAccountLineage,
  type UsFilingAccountLineageInput,
} from "@openbooks/engine/payroll/us-filing-account-lineage";
import { PayrollError } from "@openbooks/engine/payroll/error";
import { filingAccountProblem } from "@openbooks/engine/payroll/filing-registry";
import {
  payPeriodsPerYearProblem,
  semiMonthlyAnchorProblem,
} from "@openbooks/engine/payroll/run-calendar";
import { payScheduleSubsidiaryProblem } from "@openbooks/engine/payroll/run-lifecycle";
import { payComponentTreatmentProblem } from "@openbooks/engine/payroll/treatment-bases";
import { nonCashOffsetProblem } from "@openbooks/engine/payroll/setup";
import { PAYROLL_COUNTRY_PACKS } from "@openbooks/engine/payroll/packs";
import type { SetupEntity } from "./registry";
import { coerceBoolean } from "./coerce";
import { INTEGRITY_CONTINUES, type SetupIntegrityVerdict } from "./write-shared";

/** Ordered setup integrity rules: Payroll filing accounts, pay components and pay schedules. */
export async function validatePayrollIntegrity(
  entity: SetupEntity,
  body: Record<string, unknown>,
  orgId: string,
  rowId: string | undefined,
  executor: SqlExecutor,
): Promise<SetupIntegrityVerdict> {
  if (
    entity.key === "pay-component-statutory-treatments" &&
    !rowId &&
    (body.vacationable === undefined || body.vacationable === null || body.vacationable === "")
  ) {
    return "Choose vacation-base inclusion explicitly for this dated component treatment; payroll cannot infer it from the component creation default";
  }
  if (entity.key === "payroll-us-filing-account-employer-lineage") {
    const current = rowId
      ? (
          await executor.execute<UsFilingAccountLineageInput>(
            sql`
      select filing_account_id as "filingAccountId", federal_account_id as "federalAccountId",
        subsidiary_id as "subsidiaryId", effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
        source_reference as "sourceReference", change_reason as "changeReason"
      from payroll_us_filing_account_employer_lineage where org_id = ${orgId} and id = ${rowId}
    `,
            "objects",
          )
        )[0]
      : undefined;
    if (rowId && !current) return "not found";
    const input = {
      ...current,
      ...body,
      effectiveTo:
        body.effectiveTo === undefined ? (current?.effectiveTo ?? null) : body.effectiveTo || null,
    } as UsFilingAccountLineageInput;
    try {
      await validateUsFilingAccountLineage(executor, orgId, input);
    } catch (error) {
      if (error instanceof PayrollError) return error.message;
      throw error;
    }
  }
  if (entity.key === "payroll-filing-accounts") {
    // The pack's declared filing program types are the constraint that used
    // to be the payroll_filing_accounts_country/_program/_program_country/
    // _state DB CHECKs. A CHECK cannot enumerate an open pack registry, so
    // the declaration (engine/src/payroll/filing-registry.ts) is asked here,
    // at the API boundary, for creates and edits alike.
    const current = rowId
      ? (
          await executor.execute(
            sql`
          select country, program_type, state_code from payroll_filing_accounts
           where id = ${rowId} and org_id = ${orgId}`,
            "objects",
          )
        )[0]
      : null;
    if (rowId && !current) return "not found";
    const country = String(body.country ?? current?.country ?? "");
    const programType = String(body.programType ?? current?.program_type ?? "");
    const stateCode =
      body.stateCode === undefined
        ? ((current?.state_code as string | null) ?? null)
        : body.stateCode
          ? String(body.stateCode)
          : null;
    const problem = filingAccountProblem({ country, programType, stateCode });
    if (problem) return problem;
  }
  if (entity.key === "pay-components") {
    // The pack's declared pre-tax treatments are the constraint that used
    // to be the pay_components_tax_treatment DB CHECK. A CHECK cannot
    // enumerate an open pack vocabulary (every permitted value was
    // Canadian), so the declaration (engine/src/payroll/treatment-bases.ts,
    // over each pack's deductionTreatments) is asked here, at the API
    // boundary, for creates and edits alike — and the refusal names the
    // treatments the scope declares rather than surfacing a constraint name.
    const currentComponent = rowId
      ? (
          await executor.execute(
            sql`
          select c.country, c.tax_treatment, c.kind, c.non_periodic, c.payment_kind, c.non_cash_account_id, c.system_key,
                 c.basis, c.unit_of_measure,
                 ec.supplemental_wage_category, ec.statutory_reporting_category, ec.statutory_exemption_category
            from pay_components c
            join pay_component_earning_classifications ec
              on ec.org_id = c.org_id and ec.pay_component_id = c.id
           where c.id = ${rowId} and c.org_id = ${orgId}`,
            "objects",
          )
        )[0]
      : null;
    if (rowId && !currentComponent) return "not found";
    const componentCountry =
      body.country !== undefined
        ? body.country
          ? String(body.country)
          : null
        : ((currentComponent?.country as string | null) ?? null);
    const componentTreatment =
      body.taxTreatment !== undefined
        ? body.taxTreatment
          ? String(body.taxTreatment)
          : null
        : ((currentComponent?.tax_treatment as string | null) ?? null);
    const supplementalWageCategory =
      body.supplementalWageCategory !== undefined
        ? body.supplementalWageCategory
          ? String(body.supplementalWageCategory)
          : null
        : ((currentComponent?.supplemental_wage_category as string | null) ?? null);
    const statutoryReportingCategory =
      body.statutoryReportingCategory !== undefined
        ? body.statutoryReportingCategory
          ? String(body.statutoryReportingCategory)
          : null
        : ((currentComponent?.statutory_reporting_category as string | null) ?? null);
    const statutoryExemptionCategory =
      body.statutoryExemptionCategory !== undefined
        ? body.statutoryExemptionCategory
          ? String(body.statutoryExemptionCategory)
          : null
        : ((currentComponent?.statutory_exemption_category as string | null) ?? null);
    const componentKind = String(body.kind ?? currentComponent?.kind ?? "");
    // A blank payment representation is unspecified, not invalid: it only
    // applies to earnings, so a deduction or employer contribution imported
    // or saved without one keeps the stored value or the cash default.
    const paymentKind =
      body.paymentKind === undefined || body.paymentKind === null || body.paymentKind === ""
        ? String(currentComponent?.payment_kind ?? "cash")
        : String(body.paymentKind);
    const nonCashAccount =
      body.nonCashAccountId === undefined
        ? (currentComponent?.non_cash_account_id ?? null)
        : body.nonCashAccountId || null;
    if (!["cash", "non_cash"].includes(paymentKind))
      return "Choose cash or non-cash as the earning payment representation";
    if (paymentKind === "non_cash") {
      if (componentKind !== "earning" || currentComponent?.system_key != null)
        return "Non-cash representation requires a user earning component; statutory contributions and deductions cannot create non-cash earnings";
      if (!nonCashAccount || !isUuid(String(nonCashAccount)))
        return "Choose a prepaid asset, a provider clearing liability, or a contra-expense account for the non-cash earning";
      const account = (
        await executor.execute<{ type: string }>(
          sql`
        select type from accounts where org_id = ${orgId} and id = ${String(nonCashAccount)} and is_active and not is_summary
      `,
          "objects",
        )
      )[0];
      const expenseAccount =
        body.expenseAccountId === undefined
          ? ((currentComponent?.expense_account_id as string | null | undefined) ?? null)
          : body.expenseAccountId
            ? String(body.expenseAccountId)
            : null;
      const offsetProblem = nonCashOffsetProblem(
        account ? { id: String(nonCashAccount), type: account.type } : undefined,
        expenseAccount,
      );
      if (offsetProblem) return offsetProblem.charAt(0).toUpperCase() + offsetProblem.slice(1);
    } else if (nonCashAccount !== null) {
      return "Cash earnings must have no non-cash clearing account; clear the account before saving cash representation";
    }
    const nonPeriodic =
      body.nonPeriodic === undefined
        ? currentComponent?.non_periodic === true
        : coerceBoolean(body.nonPeriodic);
    const treatmentProblem = payComponentTreatmentProblem({
      country: componentCountry,
      taxTreatment: componentTreatment,
    });
    if (treatmentProblem) return treatmentProblem;
    if (supplementalWageCategory !== null && supplementalWageCategory !== "") {
      if (componentKind !== "earning" || !nonPeriodic) {
        return "supplemental-wage-category-requires-non-periodic-earning";
      }
      if (!["bonus_or_stock_option", "other"].includes(supplementalWageCategory)) {
        return "invalid-supplemental-wage-category";
      }
    }
    if (statutoryExemptionCategory !== null && statutoryExemptionCategory !== "") {
      if (componentKind !== "earning") {
        return "statutory-exemption-category-requires-earning";
      }
      if (
        !["military_pay", "rail_carrier", "motor_carrier", "air_carrier", "seafarer"].includes(
          statutoryExemptionCategory,
        )
      ) {
        return "invalid-statutory-exemption-category";
      }
    }
    if (statutoryReportingCategory) {
      const declared = componentCountry ? PAYROLL_COUNTRY_PACKS[componentCountry] : null;
      const reporting = (declared?.statutoryReportingCodes ?? []).find(
        (entry) => entry.category === statutoryReportingCategory,
      );
      if (!reporting) {
        return `statutory reporting category "${statutoryReportingCategory}" is not declared by the component's country pack; scope this pay component to a pack that declares the category, then select its reporting category`;
      }
      if (
        (reporting.componentKind && componentKind !== reporting.componentKind) ||
        (reporting.taxTreatment && componentTreatment !== reporting.taxTreatment)
      ) {
        return `statutory reporting category "${statutoryReportingCategory}" requires a ${reporting.componentKind ?? "declared"} component with tax treatment ${reporting.taxTreatment ?? "declared by the pack"}; correct the component kind and treatment before selecting this reporting code`;
      }
    }
    // Units are hours or a quantity (trips, meals, incentive units); only
    // hours lines feed an hours basis. A per-hour basis pays its rate against
    // the run's hours, so it cannot count quantities — refused here, by name,
    // on create and on edit alike (the pay_components check enforces the same
    // rule for every other writer).
    const unitOfMeasure =
      body.unitOfMeasure !== undefined
        ? String(body.unitOfMeasure)
        : ((currentComponent?.unit_of_measure as string | null) ?? "hours");
    if (!["hours", "quantity"].includes(unitOfMeasure)) {
      return "Choose hours or quantity as the component unit of measure";
    }
    const basis = String(
      body.basis ?? (currentComponent as { basis?: string } | null)?.basis ?? "fixed_amount",
    );
    if (basis === "per_hour" && unitOfMeasure !== "hours") {
      return "Per-hour components pay their rate against the run\u2019s hours, so they always use hours as the unit of measure — choose a fixed-amount basis for quantity units, or hours for this component";
    }
  }
  if (entity.key === "pay-schedules") {
    // `anchor_period_end` is a REQUIRED field the engine derives every period
    // boundary from, semi-monthly included: the anchor's day-of-month names one
    // of the month's two period ends and its half-month complement names the
    // other (engine/src/payroll/run.ts, `semiMonthlyBoundaries`). Two anchor
    // shapes do not determine a calendar — the 14th, whose complement is a day
    // February does not always have, and the last day of a 28-day February,
    // which is simultaneously "the 28th" and "the month end". Both are refused
    // HERE, by name, rather than quietly reinterpreted: a schedule that saves
    // and then pays on days the employer did not choose misaligns every pay
    // date, the periods-per-year assumption the statutory engines annualize
    // with, and the period-overlap guard.
    const current = rowId
      ? (
          await executor.execute(
            sql`
          select frequency, periods_per_year, anchor_period_end::text as anchor_period_end,
                 subsidiary_id::text as subsidiary_id
            from pay_schedules
           where id = ${rowId} and org_id = ${orgId}`,
            "objects",
          )
        )[0]
      : null;
    if (rowId && !current) return "not found";
    // A schedule with no subsidiary pays from the root entity. In a tenant
    // running more than one legal entity that silence mints runs frozen to
    // the wrong paying entity and currency — so the engine refuses it here,
    // on create and on re-scoping back to none alike, before anything is
    // written. Single-entity tenants keep the root default without asking.
    const effectiveScheduleSubsidiary =
      body.subsidiaryId !== undefined
        ? body.subsidiaryId
          ? String(body.subsidiaryId)
          : null
        : ((current?.subsidiary_id as string | null) ?? null);
    const scheduleSubsidiaryProblem = await payScheduleSubsidiaryProblem(
      orgId,
      effectiveScheduleSubsidiary,
      executor,
    );
    if (scheduleSubsidiaryProblem) return scheduleSubsidiaryProblem;
    const frequency = String(body.frequency ?? current?.frequency ?? "");
    const anchor =
      body.anchorPeriodEnd === undefined
        ? String(current?.anchor_period_end ?? "")
        : String(body.anchorPeriodEnd ?? "");
    if (frequency === "semi_monthly") {
      const problem = semiMonthlyAnchorProblem(anchor);
      if (problem) return problem;
    }
    // Factor P has to match the calendar the other two fields describe; the
    // table's CHECK only constrains it to the union across all frequencies.
    const periodsPerYear = Number(body.periodsPerYear ?? current?.periods_per_year);
    if (Number.isFinite(periodsPerYear)) {
      const problem = payPeriodsPerYearProblem(frequency, periodsPerYear);
      if (problem) return problem;
    }
  }
  return INTEGRITY_CONTINUES;
}
