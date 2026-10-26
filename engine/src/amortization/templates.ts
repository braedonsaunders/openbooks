/**
 * Amortization templates: effective-dated policy versions keyed by code.
 * The version in effect on the source transaction date governs; a version
 * in use keeps its policy (database guard), so a change is a later version.
 */
import { sql } from "drizzle-orm";
import { PNL_COST_TYPES } from "../records/account-types.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { AmortizationError } from "./errors.ts";
import {
  percentageEntry,
  TEMPLATE_COLUMNS,
  templateVersionFromRow,
  type TemplateVersion,
} from "./internal.ts";
import {
  AMORTIZATION_METHODS,
  AMORTIZATION_TERM_SOURCES,
  validateAmortizationPolicy,
  type AmortizationMethod,
  type AmortizationTermSource,
} from "./plan.ts";

/** A deferral (prepaid) account is a balance-sheet asset. */
export const DEFERRAL_ACCOUNT_TYPES: readonly string[] = ["asset_current_other", "asset_other"];
/** Amortization releases the deferral into a cost account. */
export const DESTINATION_ACCOUNT_TYPES: readonly string[] = PNL_COST_TYPES;

type TemplateRow = Parameters<typeof templateVersionFromRow>[0];

/**
 * The version of a template in effect on a date: the latest active version
 * of the same code with effective_from on or before the date. The line may
 * name any version of the code; the date decides which one governs.
 */
export async function resolveTemplateVersion(
  runner: SqlExecutor,
  orgId: string,
  templateId: string,
  onDate: string,
): Promise<TemplateVersion> {
  const named = (
    await runner.execute<{ code: string; name: string }>(
      sql`
    select code, name from expense_amortization_templates
     where org_id = ${orgId} and id = ${templateId}`,
      "objects",
    )
  )[0];
  if (!named) {
    throw new AmortizationError("The amortization template does not exist in this organization.", {
      status: 404,
      code: "amortization_template_unknown",
      remedy:
        "Choose an amortization template from Company Settings → Setup → Amortization templates.",
    });
  }
  const row = (
    await runner.execute<TemplateRow>(
      sql`
    select ${TEMPLATE_COLUMNS}
      from expense_amortization_templates
     where org_id = ${orgId} and code = ${named.code} and is_active and effective_from <= ${onDate}
     order by effective_from desc
     limit 1`,
      "objects",
    )
  )[0];
  if (!row) {
    throw new AmortizationError(
      `Amortization template ${named.code} has no active version in effect on ${onDate}.`,
      {
        code: "amortization_template_not_effective",
        remedy: `Add or reactivate a version of template ${named.code} effective on or before ${onDate} (Company Settings → Setup → Amortization templates), or choose another template.`,
      },
    );
  }
  return templateVersionFromRow(row);
}

/** Load one exact template version (no effective-date resolution). */
export async function loadTemplateVersion(
  runner: SqlExecutor,
  orgId: string,
  templateId: string,
): Promise<TemplateVersion> {
  const row = (
    await runner.execute<TemplateRow>(
      sql`
    select ${TEMPLATE_COLUMNS} from expense_amortization_templates
     where org_id = ${orgId} and id = ${templateId}`,
      "objects",
    )
  )[0];
  if (!row) {
    throw new AmortizationError("The amortization template does not exist in this organization.", {
      status: 404,
      code: "amortization_template_unknown",
      remedy:
        "Choose an amortization template from Company Settings → Setup → Amortization templates.",
    });
  }
  return templateVersionFromRow(row);
}

interface AccountFacts {
  code: string;
  type: string;
  isActive: boolean;
  isSummary: boolean;
}

async function accountFacts(
  runner: SqlExecutor,
  orgId: string,
  accountId: string,
): Promise<AccountFacts | null> {
  const row = (
    await runner.execute<{ code: string; type: string; is_active: boolean; is_summary: boolean }>(
      sql`
    select coalesce(number, name) as code, type, is_active, is_summary from accounts where org_id = ${orgId} and id = ${accountId}`,
      "objects",
    )
  )[0];
  return row
    ? { code: row.code, type: row.type, isActive: row.is_active, isSummary: row.is_summary }
    : null;
}

/** The deferral account must be an active, postable balance-sheet asset. */
export async function assertDeferralAccount(
  runner: SqlExecutor,
  orgId: string,
  accountId: string,
): Promise<void> {
  const account = await accountFacts(runner, orgId, accountId);
  if (
    !account ||
    !account.isActive ||
    account.isSummary ||
    !DEFERRAL_ACCOUNT_TYPES.includes(account.type)
  ) {
    throw new AmortizationError(
      account
        ? `Account ${account.code} cannot hold prepaid expenses: it must be an active, postable current or other asset account.`
        : "The deferral account does not exist in this organization.",
      {
        code: "amortization_deferral_account_invalid",
        remedy:
          "Set the template's deferral account to an active prepaid (current or other asset) account in the chart of accounts.",
      },
    );
  }
}

/** The destination account must be an active, postable cost account. */
export async function assertDestinationAccount(
  runner: SqlExecutor,
  orgId: string,
  accountId: string,
  context: string,
): Promise<void> {
  const account = await accountFacts(runner, orgId, accountId);
  if (
    !account ||
    !account.isActive ||
    account.isSummary ||
    !DESTINATION_ACCOUNT_TYPES.includes(account.type)
  ) {
    throw new AmortizationError(
      account
        ? `${context}: account ${account.code} cannot receive amortization; it must be an active, postable expense or cost of goods sold account.`
        : `${context}: the destination account does not exist in this organization.`,
      {
        code: "amortization_destination_account_invalid",
        remedy:
          "Choose an active expense or cost of goods sold account as the destination (on the line, the template or the schedule).",
      },
    );
  }
}

/**
 * Validate a template write from the setup registry. Returns the refusal
 * message, or null when the version is valid. Enforces the same policy the
 * plan math and the database constraints enforce, plus the account types.
 */
export async function validateTemplateWrite(
  runner: SqlExecutor,
  orgId: string,
  body: Record<string, unknown>,
  current: Record<string, unknown> | null,
): Promise<string | null> {
  const value = (key: string, column: string): unknown =>
    body[key] !== undefined ? body[key] : current ? current[column] : undefined;
  const method = String(value("method", "method") ?? "");
  const termSource = String(value("termSource", "term_source") ?? "");
  if (!AMORTIZATION_METHODS.includes(method as AmortizationMethod))
    return "Choose an amortization method.";
  if (!AMORTIZATION_TERM_SOURCES.includes(termSource as AmortizationTermSource))
    return "Choose where the term comes from.";
  const rawCount = value("periodCount", "period_count");
  const periodCount =
    rawCount === null || rawCount === undefined || rawCount === "" ? null : Number(rawCount);
  const rawOffset = value("periodOffset", "period_offset");
  const periodOffset =
    rawOffset === null || rawOffset === undefined || rawOffset === "" ? 0 : Number(rawOffset);
  const rawPercentages = value("percentages", "percentages");
  const percentages = Array.isArray(rawPercentages) ? rawPercentages.map(percentageEntry) : null;
  try {
    validateAmortizationPolicy({
      method: method as AmortizationMethod,
      termSource: termSource as AmortizationTermSource,
      periodCount: periodCount !== null && Number.isFinite(periodCount) ? periodCount : null,
      percentages:
        method === "variable"
          ? percentages
          : percentages && percentages.length > 0
            ? percentages
            : null,
      periodOffset,
    });
    const deferral = value("deferralAccountId", "deferral_account_id");
    if (typeof deferral !== "string" || deferral === "")
      return "Choose the deferral (prepaid) account.";
    await assertDeferralAccount(runner, orgId, deferral);
    const destination = value("destinationAccountId", "destination_account_id");
    if (typeof destination === "string" && destination !== "") {
      if (destination === deferral)
        return "The destination account must differ from the deferral account.";
      await assertDestinationAccount(
        runner,
        orgId,
        destination,
        "The template's default destination",
      );
    }
  } catch (error) {
    if (error instanceof AmortizationError) return `${error.message} ${error.remedy}`;
    throw error;
  }
  return null;
}

/** Effective template choices, retaining referenced versions so saved lines remain visible. */
export async function listCurrentTemplates(
  runner: SqlExecutor,
  orgId: string,
  onDate: string,
  retainedIds: readonly string[] = [],
): Promise<
  {
    id: string;
    code: string;
    name: string;
    method: AmortizationMethod;
    termSource: AmortizationTermSource;
  }[]
> {
  const rows = await runner.execute<{
    id: string;
    code: string;
    name: string;
    method: string;
    term_source: string;
  }>(
    sql`
    with current_versions as (
      select distinct on (code) id, code, name, method, term_source
        from expense_amortization_templates
       where org_id = ${orgId} and is_active and effective_from <= ${onDate}
       order by code, effective_from desc
    )
    select * from current_versions
    ${
      retainedIds.length > 0
        ? sql`union
      select id, code, name, method, term_source from expense_amortization_templates
      where org_id = ${orgId} and id in (${sql.join(
        retainedIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
        : sql``
    }
    order by code, id`,
    "objects",
  );
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    method: row.method as AmortizationMethod,
    termSource: row.term_source as AmortizationTermSource,
  }));
}
