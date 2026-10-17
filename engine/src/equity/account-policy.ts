/**
 * Validation of an equity account policy version, the one place the Setup
 * write path and the engine agree on what a valid version is:
 *  - share capital, paid-in capital and treasury accounts are equity
 *    accounts; the compensation expense account is an expense account; the
 *    convertible instruments account is a liability or equity account (SAFEs
 *    and notes are classified by their terms);
 *  - every account is an active posting account of the organization;
 *  - a version may not take effect on or before the legal entity's latest
 *    equity posting, so a new version never reinterprets posted history.
 */
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/civil-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { EQUITY_TYPES, LIABILITY_TYPES, PNL_COST_TYPES } from "../records/account-types.ts";
import { EQUITY_JOURNAL_ORIGIN } from "./posting.ts";

export const EQUITY_POLICY_ACCOUNT_FIELDS: readonly { key: string; label: string; types: readonly string[] }[] = [
  { key: "commonStockAccountId", label: "common stock", types: EQUITY_TYPES },
  { key: "preferredStockAccountId", label: "preferred stock", types: EQUITY_TYPES },
  { key: "apicAccountId", label: "additional paid-in capital", types: EQUITY_TYPES },
  { key: "apicShareBasedAccountId", label: "paid-in capital (share-based payments)", types: EQUITY_TYPES },
  { key: "compensationExpenseAccountId", label: "stock compensation expense", types: PNL_COST_TYPES },
  { key: "treasuryStockAccountId", label: "treasury stock", types: EQUITY_TYPES },
  { key: "convertibleInstrumentsAccountId", label: "convertible instruments", types: [...LIABILITY_TYPES, ...EQUITY_TYPES] },
];

/** The refusal for a proposed policy version, or null when it is valid. */
export async function equityAccountPolicyRefusal(runner: SqlExecutor, orgId: string, body: Record<string, unknown>): Promise<string | null> {
  const subsidiaryId = body.subsidiaryId;
  if (typeof subsidiaryId !== "string" || !isUuid(subsidiaryId)) return "Choose the legal entity the policy applies to.";
  const effectiveFrom = body.effectiveFrom;
  if (typeof effectiveFrom !== "string" || !isIsoCalendarDate(effectiveFrom)) return "Enter the date the policy takes effect as YYYY-MM-DD.";
  for (const field of EQUITY_POLICY_ACCOUNT_FIELDS) {
    const accountId = body[field.key];
    if (typeof accountId !== "string" || !isUuid(accountId)) return `Choose the ${field.label} account.`;
    const row = (await runner.execute<{ type: string; is_active: boolean; is_summary: boolean }>(sql`
      select type, is_active, is_summary from accounts where org_id = ${orgId} and id = ${accountId}`)).rows[0];
    if (!row || !row.is_active || row.is_summary || !field.types.includes(row.type)) {
      return `The ${field.label} account must be an active posting account of type ${field.types.join(", ")}.`;
    }
  }
  const latest = (await runner.execute<{ posting_date: string }>(sql`
    select max(posting_date)::text as posting_date from journal_entries
     where org_id = ${orgId} and subsidiary_id = ${subsidiaryId} and origin = ${EQUITY_JOURNAL_ORIGIN}
       and status in ('posted', 'reversed')`)).rows[0];
  if (latest?.posting_date && effectiveFrom <= latest.posting_date) {
    return `Equity entries are posted through ${latest.posting_date}; a new policy version must take effect after that date so posted history keeps its accounts.`;
  }
  return null;
}
