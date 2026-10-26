import "server-only";
import { isUuid } from "../list-params";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "@openbooks/engine/platform/db";
import { toUnits } from "@openbooks/engine/money/money";
import { recognitionRulePolicyProblem } from "@openbooks/engine/revenue/recognition-limits";
import type { SetupEntity } from "./registry";
import { coerceBoolean, taxRatePercentProblem } from "./coerce";
import { taxRegistrationFormProblem } from "@openbooks/engine/tax/seed-tax-forms";
import { INTEGRITY_CONTINUES, type SetupIntegrityVerdict } from "./write-shared";

/** Ordered setup integrity rules: Tax rates, codes, groups, pool classes and registrations, revenue recognition rules and accounting books. */
export async function validateTaxIntegrity(
  entity: SetupEntity,
  body: Record<string, unknown>,
  orgId: string,
  rowId: string | undefined,
  executor: SqlExecutor,
): Promise<SetupIntegrityVerdict> {
  if (entity.key === "tax-rates") {
    // One exact-decimal contract with the calculation engine
    // (engine/src/tax/tax.ts): a rate is a nonnegative exact decimal with at most
    // 4 decimal places. Without this check the generic percent coercer admits
    // FX-scale values PostgreSQL silently rounds into numeric(19,4), and a
    // negative rate saves "successfully" only to fail every later document at
    // calculation time. A statutory 0% rate stays legal.
    const current = rowId
      ? (
          await executor.execute(
            sql`
          select rate_percent::text as rate_percent from tax_rates
           where id = ${rowId} and org_id = ${orgId}`,
            "objects",
          )
        )[0]
      : null;
    if (rowId && !current) return "not found";
    const raw = body.ratePercent !== undefined ? body.ratePercent : current?.rate_percent;
    if (raw === undefined || raw === null || String(raw).trim() === "") {
      return "ratePercent is required";
    }
    return taxRatePercentProblem(raw);
  }
  if (entity.key === "tax-codes") {
    const current = rowId
      ? (
          await executor.execute(
            sql`select * from tax_codes where id = ${rowId} and org_id = ${orgId}`,
            "objects",
          )
        )[0]
      : null;
    if (rowId && !current) return "not found";
    const value = (camel: string, snake: string, fallback: unknown) =>
      body[camel] !== undefined ? body[camel] : (current?.[snake] ?? fallback);
    // A blank is not a choice: the drawer sends '' for untouched inputs and
    // the coerce layer drops those blanks onto the default, so
    // the integrity read must fall back the same way instead of refusing a
    // raw blank ('' reached toUnits as a refusal key).
    const present = (camel: string, snake: string, fallback: unknown) => {
      const submitted = body[camel];
      if (submitted === undefined || submitted === null || String(submitted).trim() === "") {
        return current?.[snake] ?? fallback;
      }
      return submitted;
    };
    const calculationType = String(present("calculationType", "calculation_type", "standard"));
    const appliesTo = String(present("appliesTo", "applies_to", "both"));
    const inclusive = coerceBoolean(value("priceIncludesTax", "price_includes_tax", false));
    const roundingScale = Number(present("roundingScale", "rounding_scale", 2));
    if (!["standard", "withholding", "reverse_charge"].includes(calculationType))
      return "invalid-tax-calculation-type";
    if (inclusive && calculationType !== "standard") return "inclusive-standard-only";
    if (!Number.isInteger(roundingScale) || roundingScale < 0 || roundingScale > 4)
      return "invalid-tax-rounding-scale";
    try {
      const recovery = toUnits(String(present("recoverablePercent", "recoverable_percent", "100")));
      if (recovery < 0n || recovery > toUnits("100")) return "invalid-recoverable-percent";
    } catch {
      return "invalid-recoverable-percent";
    }
    const withholdingAccountId = value("withholdingAccountId", "withholding_account_id", null);
    const collectedAccountId = value("collectedAccountId", "collected_account_id", null);
    const paidAccountId = value("paidAccountId", "paid_account_id", null);
    if (calculationType === "withholding" && !withholdingAccountId)
      return "withholding-account-required";
    if (calculationType === "reverse_charge" && (!collectedAccountId || !paidAccountId))
      return "reverse-charge-accounts-required";
    const accountIds = [withholdingAccountId, collectedAccountId, paidAccountId]
      .filter(Boolean)
      .map(String);
    if (accountIds.length > 0) {
      const accounts = await executor.execute(
        sql`
        select id from accounts where org_id = ${orgId} and id = any(${`{${accountIds.join(",")}}`}::uuid[])
          and is_active and not is_summary
      `,
        "objects",
      );
      if (accounts.length !== new Set(accountIds).size) return "invalid-tax-account";
    }
    if (!["sales", "purchases", "both"].includes(appliesTo)) return "invalid-tax-application-scope";
  }
  if (entity.key === "tax-groups") {
    const current = rowId
      ? (
          await executor.execute(
            sql`
          select price_includes_tax from tax_groups where id = ${rowId} and org_id = ${orgId}`,
            "objects",
          )
        )[0]
      : null;
    if (rowId && !current) return "not found";
    const members = Array.isArray(body.members)
      ? body.members.map(String)
      : rowId
        ? (
            await executor.execute(
              sql`
            select tgm.tax_code_id
              from tax_group_members tgm
              join tax_groups tg on tg.id = tgm.tax_group_id and tg.org_id = ${orgId}
             where tgm.tax_group_id = ${rowId}
             order by tgm.sequence`,
              "objects",
            )
          ).map((row) => String(row.tax_code_id))
        : [];
    if (members.length === 0) return "tax-group-members-required";
    if (new Set(members).size !== members.length || members.some((id: string) => !isUuid(id)))
      return "invalid-tax-group-members";
    const rows = await executor.execute(
      sql`
      select id, calculation_type from tax_codes
       where org_id = ${orgId} and is_active and id = any(${`{${members.join(",")}}`}::uuid[])
    `,
      "objects",
    );
    if (rows.length !== members.length) return "invalid-tax-group-members";
    const inclusive =
      body.priceIncludesTax === undefined
        ? Boolean(current?.price_includes_tax)
        : coerceBoolean(body.priceIncludesTax);
    if (inclusive && rows.some((row) => row.calculation_type !== "standard")) {
      return "inclusive-tax-group-standard-only";
    }
  }
  if (entity.key === "tax-pool-classes") {
    const current = rowId
      ? (
          await executor.execute(
            sql`select * from tax_pool_classes where id=${rowId} and org_id=${orgId}`,
            "objects",
          )
        )[0]
      : null;
    if (rowId && !current) return "not found";
    const value = (camel: string, snake: string) =>
      body[camel] !== undefined ? body[camel] : current?.[snake];
    const regimeCode = String(value("regime", "regime") ?? "");
    const regime = await executor.execute(
      sql`
      select calculation_model from tax_regimes where org_id=${orgId} and code=${regimeCode} and is_active limit 1`,
      "objects",
    );
    if (!regime[0]) return "install-or-create-tax-depreciation-regime-first";
    const recovery = Number(value("recoveryPeriodYears", "recovery_period_years"));
    if (regime[0].calculation_model === "macrs") {
      if (
        !["gds", "ads"].includes(String(value("depreciationSystem", "depreciation_system") ?? ""))
      )
        return "macrs-system-required";
      if (
        !["200_db", "150_db", "straight_line"].includes(
          String(value("macrsMethod", "macrs_method") ?? ""),
        )
      )
        return "macrs-method-required";
      if (!Number.isFinite(recovery) || recovery <= 0) return "macrs-recovery-period-required";
      if (
        !["half_year", "mid_quarter", "mid_month"].includes(
          String(value("convention", "convention") ?? ""),
        )
      )
        return "macrs-convention-required";
    }
    const fraction = Number(value("firstYearFraction", "first_year_fraction") ?? 1);
    if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)
      return "first-year-fraction-out-of-range";
  }
  if (entity.key === "tax-registrations") {
    // A registration's form must belong to its jurisdiction (from the
    // return-pack catalog): a Canadian jurisdiction paired with US_NY_ST100
    // saves, and the return then prints the New York form with the Canadian
    // number. Refuse the mismatched pair at save, by name, with the remedy.
    // Tenant-defined forms carry no catalog rule and pass; a blank form
    // (the drawer sends '' for untouched inputs) validates as unset.
    const current = rowId
      ? (
          await executor.execute(
            sql`
          select subsidiary_id,jurisdiction_id, registration_number, return_form_code
            from tax_registrations where id = ${rowId} and org_id = ${orgId}`,
            "objects",
          )
        )[0]
      : null;
    if (rowId && !current) return "not found";
    const seller = body.subsidiaryId !== undefined ? body.subsidiaryId : current?.subsidiary_id;
    if (
      seller &&
      (!(typeof seller === "string") ||
        !isUuid(seller) ||
        !(
          await executor.execute(
            sql`select id from subsidiaries where org_id=${orgId} and id=${seller} and is_active and not is_elimination`,
            "objects",
          )
        ).length)
    )
      return "Choose an active legal entity in this organization for the tax registration";
    const registrationJurisdictionId = String(
      body.jurisdictionId !== undefined && body.jurisdictionId !== ""
        ? body.jurisdictionId
        : (current?.jurisdiction_id ?? ""),
    );
    const formCode = String(
      body.returnFormCode !== undefined && body.returnFormCode !== ""
        ? body.returnFormCode
        : (current?.return_form_code ?? ""),
    ).trim();
    if (formCode && registrationJurisdictionId) {
      const jurisdiction = (
        await executor.execute(
          sql`
        select code from tax_jurisdictions
         where id = ${registrationJurisdictionId} and org_id = ${orgId}`,
          "objects",
        )
      )[0];
      if (jurisdiction) {
        const problem = taxRegistrationFormProblem({
          registrationLabel: String(
            body.registrationNumber !== undefined && body.registrationNumber !== ""
              ? body.registrationNumber
              : (current?.registration_number ?? formCode),
          ),
          registrationJurisdictionCode: String(jurisdiction.code),
          formCode,
        });
        if (problem) return problem;
      }
    }
  }
  if (entity.key === "recognition-rules") {
    // One exact contract with the recognition engine (engine/src/revenue):
    // periods, offsets, or an up-front percent outside the builder's domain
    // save "successfully" and fail every later invoice attach or posting.
    // Refuse at save, by field name, with no row change. A blank is not a
    // choice (the drawer sends '' for untouched keepDefault inputs), so the
    // merged stored value is validated, never the raw blank.
    const current = rowId
      ? (
          await executor.execute(
            sql`
          select recognition_periods, period_offset, start_offset_days,
                 initial_amount_percent::text as initial_amount_percent
            from recognition_rules where id = ${rowId} and org_id = ${orgId}`,
            "objects",
          )
        )[0]
      : null;
    if (rowId && !current) return "not found";
    const value = (camel: string, snake: string) => {
      const submitted = body[camel];
      if (submitted === undefined || submitted === null || String(submitted).trim() === "") {
        return current?.[snake] ?? null;
      }
      return submitted;
    };
    return recognitionRulePolicyProblem({
      recognitionPeriods: value("recognitionPeriods", "recognition_periods"),
      periodOffset: value("periodOffset", "period_offset"),
      startOffsetDays: value("startOffsetDays", "start_offset_days"),
      initialAmountPercent: value("initialAmountPercent", "initial_amount_percent"),
    });
  }
  if (entity.key === "accounting-books") {
    if (
      coerceBoolean(body.isPrimary) &&
      body.isActive !== undefined &&
      !coerceBoolean(body.isActive)
    ) {
      return "primary-active-required";
    }
    if (rowId) {
      const existing = await executor.execute(
        sql`
        select is_primary from accounting_books where id = ${rowId} and org_id = ${orgId}`,
        "objects",
      );
      if (!existing[0]) return "not found";
      if (existing[0].is_primary && !coerceBoolean(body.isPrimary)) return "primary-required";
      if (existing[0].is_primary && !coerceBoolean(body.isActive)) return "primary-active-required";
    }
  }
  return INTEGRITY_CONTINUES;
}
