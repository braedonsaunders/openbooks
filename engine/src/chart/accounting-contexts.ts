import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";

/**
 * Accounting contexts present the chart under localized account numbers and
 * names — for example a local statutory chart — without changing postings.
 *
 * A report runs under a context named explicitly, or under the default
 * context of the reported subsidiary (or of its country), or under the base
 * chart. Each account's label is the localization effective on the report's
 * as-of date: a subsidiary-specific localization wins over an
 * organization-wide one, and a missing localized number or name falls back
 * to the base value with the row marked as base. Two accounts resolving to
 * the same localized number in one context and scope make the context
 * ambiguous, and reports refuse rather than merge or reorder them silently.
 */

export const ACCOUNTING_CONTEXTS_FEATURE = "accountingContexts";
/** Explicit request for the base chart, overriding any subsidiary default. */
export const BASE_CHART_CONTEXT = "base";

export class AccountingContextError extends Error {
  readonly name = "AccountingContextError";
  readonly status: number;
  readonly code: string;
  readonly remedy: string;
  constructor(message: string, code: string, remedy: string, status = 422) {
    super(message);
    this.code = code;
    this.remedy = remedy;
    this.status = status;
  }
}

export interface AccountingContextOption extends Record<string, unknown> {
  id: string;
  code: string;
  name: string;
}

export interface ResolvedAccountingContext {
  context: AccountingContextOption | null;
  /** How the context was chosen. */
  source: "requested" | "subsidiary" | "country" | "base";
}

/** Active contexts, or none while the feature is off. */
export async function listAccountingContexts(
  executor: SqlExecutor,
  orgId: string,
): Promise<AccountingContextOption[]> {
  if (!(await orgFeatureEnabled(orgId, ACCOUNTING_CONTEXTS_FEATURE, executor))) return [];
  return await executor.execute<AccountingContextOption>(
    sql`
    select id, code, name from accounting_contexts
     where org_id = ${orgId} and is_active
     order by name, code, id`,
    "objects",
  );
}

/**
 * The context a report runs under. `requested` is a context id, the base
 * chart marker, or empty for the subsidiary's default. An unknown, inactive
 * or foreign context refuses instead of silently falling back.
 */
export async function resolveAccountingContext(
  executor: SqlExecutor,
  orgId: string,
  input: { requested?: string | null; subsidiaryId?: string | null },
): Promise<ResolvedAccountingContext> {
  const requested = input.requested?.trim() || null;
  if (requested === BASE_CHART_CONTEXT) return { context: null, source: "base" };
  const enabled = await orgFeatureEnabled(orgId, ACCOUNTING_CONTEXTS_FEATURE, executor);
  if (!enabled) {
    if (requested) {
      throw new AccountingContextError(
        "Accounting contexts are turned off for this company.",
        "accounting_contexts_disabled",
        "Turn on Accounting contexts in Company Settings → Features, or run the report on the base chart.",
      );
    }
    return { context: null, source: "base" };
  }
  if (requested) {
    const row = (
      await executor.execute<AccountingContextOption>(
        sql`
      select id, code, name from accounting_contexts
       where org_id = ${orgId} and id::text = ${requested} and is_active`,
        "objects",
      )
    )[0];
    if (!row) {
      throw new AccountingContextError(
        "The accounting context is not an active context of this company.",
        "accounting_context_unknown",
        "Choose an active accounting context, or the base chart.",
      );
    }
    return { context: row, source: "requested" };
  }
  if (!input.subsidiaryId) return { context: null, source: "base" };
  const fallback = (
    await executor.execute<AccountingContextOption & { scope: "subsidiary" | "country" }>(
      sql`
    select c.id, c.code, c.name, case when d.subsidiary_id is not null then 'subsidiary' else 'country' end as scope
      from accounting_context_defaults d
      join accounting_contexts c on c.org_id = d.org_id and c.id = d.context_id and c.is_active
      join subsidiaries s on s.org_id = d.org_id and s.id = ${input.subsidiaryId}
     where d.org_id = ${orgId} and (d.subsidiary_id = s.id or (d.subsidiary_id is null and d.country = s.country))
     order by (d.subsidiary_id is not null) desc
     limit 1`,
      "objects",
    )
  )[0];
  if (!fallback) return { context: null, source: "base" };
  return {
    context: { id: fallback.id, code: fallback.code, name: fallback.name },
    source: fallback.scope,
  };
}

export interface AccountLabel {
  number: string | null;
  name: string;
  /** False when neither the number nor the name is localized in the context (base chart shown). */
  localized: boolean;
}

interface LabelRow extends Record<string, unknown> {
  account_id: string;
  base_number: string | null;
  base_name: string;
  localized_number: string | null;
  localized_name: string | null;
}

/** Pure: refuse two accounts sharing one localized number (case-insensitive). */
export function assertUniqueLocalizedNumbers(
  labels: ReadonlyMap<string, AccountLabel>,
  context: Pick<AccountingContextOption, "name">,
): void {
  const seen = new Map<string, string>();
  for (const [accountId, label] of labels) {
    if (!label.localized || !label.number) continue;
    const key = label.number.toLowerCase();
    const other = seen.get(key);
    if (other && other !== accountId) {
      throw new AccountingContextError(
        `Localized number ${label.number} is used by more than one account in the ${context.name} context.`,
        "accounting_context_ambiguous",
        "Give each account its own localized number in that context (Setup → Accounting contexts), or run the report on the base chart.",
      );
    }
    seen.set(key, accountId);
  }
}

/**
 * Every account's label under a context on a date. Subsidiary-specific
 * localizations apply only when the report is scoped to that subsidiary.
 */
export async function loadAccountLabels(
  executor: SqlExecutor,
  orgId: string,
  context: AccountingContextOption,
  options: { asOf: string; subsidiaryId?: string | null },
): Promise<Map<string, AccountLabel>> {
  if (!isIsoCalendarDate(options.asOf)) {
    throw new AccountingContextError(
      "The report date is not a calendar date.",
      "accounting_context_date",
      "Choose a valid report period.",
    );
  }
  const subsidiaryId = options.subsidiaryId ?? null;
  const rows = await executor.execute<LabelRow>(
    sql`
    select a.id as account_id, a.number as base_number, a.name as base_name,
           loc.localized_number, loc.localized_name
      from accounts a
      left join lateral (
        select l.localized_number, l.localized_name
          from account_localizations l
         where l.org_id = a.org_id and l.account_id = a.id and l.context_id = ${context.id}
           and l.effective_from <= ${options.asOf}
           and (l.effective_to is null or l.effective_to >= ${options.asOf})
           and (l.subsidiary_id is null ${subsidiaryId ? sql`or l.subsidiary_id = ${subsidiaryId}` : sql``})
         order by (l.subsidiary_id is not null) desc
         limit 1
      ) loc on true
     where a.org_id = ${orgId}`,
    "objects",
  );
  const labels = new Map<string, AccountLabel>();
  for (const row of rows) {
    const localized = row.localized_number !== null || row.localized_name !== null;
    labels.set(row.account_id, {
      number: row.localized_number ?? row.base_number,
      name: row.localized_name ?? row.base_name,
      localized,
    });
  }
  assertUniqueLocalizedNumbers(labels, context);
  return labels;
}

/** Sort key comparison for account rows under a context: number (natural order), then name. */
export function compareAccountLabels(
  a: Pick<AccountLabel, "number" | "name">,
  b: Pick<AccountLabel, "number" | "name">,
): number {
  if (a.number && b.number) {
    const byNumber = a.number.localeCompare(b.number, "en", { numeric: true, sensitivity: "base" });
    if (byNumber !== 0) return byNumber;
  } else if (a.number || b.number) {
    return a.number ? -1 : 1;
  }
  return a.name.localeCompare(b.name, "en", { sensitivity: "base" });
}

/**
 * Setup-time validation for one localization row: the account, subsidiary
 * and context belong to the organization, and the localized number is not
 * used by another account in an overlapping window anywhere a report could
 * see both (the same scope, or organization-wide beside a subsidiary scope).
 * Storage separately refuses same-scope overlaps.
 */
export async function accountLocalizationWriteError(
  executor: SqlExecutor,
  orgId: string,
  input: {
    id?: string | null;
    contextId: string;
    accountId: string;
    subsidiaryId: string | null;
    localizedNumber: string | null;
    localizedName: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
  },
): Promise<string | null> {
  if (!input.localizedNumber?.trim() && !input.localizedName?.trim())
    return "Enter a localized number, a localized name, or both.";
  if (!isIsoCalendarDate(input.effectiveFrom))
    return "Enter the date the localization takes effect.";
  if (
    input.effectiveTo &&
    (!isIsoCalendarDate(input.effectiveTo) || input.effectiveTo < input.effectiveFrom)
  ) {
    return "The end date must be on or after the effective date.";
  }
  const account = (
    await executor.execute<{ merged_into_id: string | null }>(
      sql`
    select merged_into_id from accounts where org_id = ${orgId} and id = ${input.accountId}`,
      "objects",
    )
  )[0];
  if (!account) return "Choose an account of this company.";
  const context = (
    await executor.execute<{ id: string }>(
      sql`
    select id from accounting_contexts where org_id = ${orgId} and id = ${input.contextId}`,
      "objects",
    )
  )[0];
  if (!context) return "Choose an accounting context of this company.";
  if (input.subsidiaryId) {
    const subsidiary = (
      await executor.execute<{ id: string }>(
        sql`
      select id from subsidiaries where org_id = ${orgId} and id = ${input.subsidiaryId}`,
        "objects",
      )
    )[0];
    if (!subsidiary) return "Choose a subsidiary of this company.";
  }
  const number = input.localizedNumber?.trim();
  if (!number) return null;
  await executor.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`account-localizations:${orgId}:${input.contextId}`}, 0))`,
  );
  const clash = (
    await executor.execute<{ label: string }>(
      sql`
    select concat_ws(' · ', a.number, a.name) as label
      from account_localizations l
      join accounts a on a.org_id = l.org_id and a.id = l.account_id
     where l.org_id = ${orgId} and l.context_id = ${input.contextId}
       and l.account_id <> ${input.accountId}
       ${input.id ? sql`and l.id <> ${input.id}` : sql``}
       and lower(l.localized_number) = lower(${number})
       and (l.subsidiary_id is null or ${input.subsidiaryId}::uuid is null or l.subsidiary_id = ${input.subsidiaryId}::uuid)
       and daterange(l.effective_from, coalesce(l.effective_to + 1, 'infinity'::date), '[)')
           && daterange(${input.effectiveFrom}::date, coalesce(${input.effectiveTo}::date + 1, 'infinity'::date), '[)')
     limit 1`,
      "objects",
    )
  )[0];
  if (clash)
    return `Localized number ${number} is already used by ${clash.label} in this context for an overlapping period. Give each account its own localized number.`;
  return null;
}
