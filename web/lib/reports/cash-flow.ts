import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { bucketSubsidiaryFilter, glActivityBuckets, glSummaryEligibleDims } from "../gl-summary";
import { resolveOrgId } from "../org-scope";
import { decimalIsMaterial, decimalSum, type ExactDecimal } from "../statement-format";
import { ZERO, compareAbsoluteDescending, decimalSubtract } from "./decimals";
import { type DimFilter, dimWhere } from "./filters";

// ---------------------------------------------------------------------------
// Cash Flow Statement (direct classification of bank-account contra movements)
// ---------------------------------------------------------------------------

export type CashFlowSection = "operating" | "investing" | "financing";

/**
 * Single tunable mapping from an account type to a cash-flow section. Every
 * non-bank line that shares an entry with a bank movement is classified by its
 * account's type, so the three sections sum to the net change in cash.
 *
 *  - Operating: revenue, expense, COGS, and working-capital accounts (AR, AP,
 *    cards, other current assets/liabilities). Tax control accounts are
 *    `liability_current_other` / `asset_current_other`, so they land here too.
 *  - Investing: fixed assets and other long-term assets.
 *  - Financing: long-term liabilities and equity.
 */
export const CASH_FLOW_SECTION: Record<string, CashFlowSection> = {
  income: "operating",
  income_other: "operating",
  cogs: "operating",
  expense: "operating",
  expense_other: "operating",
  expense_deferred: "operating",
  asset_receivable: "operating",
  asset_current_other: "operating",
  liability_payable: "operating",
  liability_card: "operating",
  liability_current_other: "operating",
  asset_fixed: "investing",
  asset_other: "investing",
  liability_long_term: "financing",
  equity: "financing",
};

export interface CashFlowLine {
  type: string;
  label: string;
  amount: ExactDecimal; // effect on cash (debit-to-bank positive = cash in)
}

export interface CashFlowResult {
  sections: { section: CashFlowSection; lines: CashFlowLine[]; subtotal: ExactDecimal }[];
  netChange: ExactDecimal;
  openingCash: ExactDecimal;
  closingCash: ExactDecimal;
  /** closingCash − openingCash − netChange; should be ~0 when the statement ties. */
  reconciliationGap: ExactDecimal;
}

const CASH_FLOW_TYPE_LABEL: Record<string, string> = {
  income: "Income",
  income_other: "Other income",
  cogs: "Cost of goods sold",
  expense: "Operating expenses",
  expense_other: "Other expenses",
  expense_deferred: "Deferred expenses",
  asset_receivable: "Accounts receivable",
  asset_current_other: "Other current assets",
  liability_payable: "Accounts payable",
  liability_card: "Credit cards",
  liability_current_other: "Other current liabilities",
  asset_fixed: "Fixed assets",
  asset_other: "Other assets",
  liability_long_term: "Long-term liabilities",
  equity: "Equity & shareholder",
};

/**
 * Direct-method cash-flow statement for a period. Cash is the set of bank-type
 * (`asset_bank`) accounts. For every posted entry that touches a bank account
 * in the period, the NON-bank lines are the sources/uses of that cash; each is
 * classified into Operating / Investing / Financing by its account type
 * (`CASH_FLOW_SECTION`). The cash effect of a contra line is the negative of
 * its debit-signed amount (a credit to a non-bank account funds cash in).
 *
 * The three sections therefore sum to the net change in cash, which is proven
 * against the bank accounts' opening/closing balances.
 */
export async function cashFlow(from: string, to: string, dims?: DimFilter, orgId?: string): Promise<CashFlowResult> {
  const resolvedOrgId = await resolveOrgId(orgId);
  // Contra movements: non-bank lines on entries that also hit a bank account,
  // grouped by account type. `-sum(amount)` converts debit-signed line amounts
  // into their effect on cash (credit a contra → cash in → positive).
  const contra = (await db.execute<{ type: string; cash_effect: string }>(sql`
    with cash_entries as (
      -- Bank-touching entries by account id: joining accounts per line made
      -- the planner drive from accounts and probe the entry pk per line.
      select distinct l.entry_id as id
        from journal_entries e
        join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
       where e.org_id = ${resolvedOrgId} and e.status in ('posted', 'reversed')
         and e.posting_date >= ${from} and e.posting_date <= ${to}
         and l.account_id in (
           select id from accounts where org_id = ${resolvedOrgId} and type = 'asset_bank')
    )
    select a.type, -sum(l.amount) as cash_effect
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where e.id in (select id from cash_entries)
       and l.org_id = ${resolvedOrgId} and a.type <> 'asset_bank' and ${dimWhere(dims)}
     group by a.type
  `));

  const bySection: Record<CashFlowSection, CashFlowLine[]> = { operating: [], investing: [], financing: [] };
  for (const row of contra.rows) {
    const amount = row.cash_effect;
    if (!decimalIsMaterial(amount)) continue;
    const section = CASH_FLOW_SECTION[row.type] ?? "operating";
    bySection[section].push({
      type: row.type,
      label: CASH_FLOW_TYPE_LABEL[row.type] ?? row.type,
      amount,
    });
  }

  const order: CashFlowSection[] = ["operating", "investing", "financing"];
  const sections = order.map((section) => {
    const lines = bySection[section].sort((a, b) => compareAbsoluteDescending(a.amount, b.amount));
    return { section, lines, subtotal: decimalSum(lines.map((line) => line.amount)) };
  });
  const netChange = decimalSum(sections.map((section) => section.subtotal));

  // Opening/closing cash straight from the bank accounts, proving the tie-out.
  const cashBuckets = glSummaryEligibleDims(dims)
    ? glActivityBuckets(resolvedOrgId, {
        minDate: null,
        maxDate: to,
        boundaries: [{ date: from, kind: 'start' }],
      })
    : null;
  const cash = (await db.execute<{ opening: string; closing: string }>(
    cashBuckets
      // Inception-to-date bank movement from the summary; the two report
      // boundaries are the only months that fall back to the lines.
      ? sql`
          select coalesce(sum(b.amount) filter (where b.d < ${from}), 0) as opening,
                 coalesce(sum(b.amount) filter (where b.d <= ${to}), 0) as closing
            from ${cashBuckets} b
            join accounts a on a.id = b.account_id and a.org_id = ${resolvedOrgId}
           where a.type = 'asset_bank'
             ${bucketSubsidiaryFilter(dims?.subsidiaryIds)}`
      : sql`
          select coalesce(sum(l.amount) filter (where e.posting_date < ${from}), 0) as opening,
                 coalesce(sum(l.amount) filter (where e.posting_date <= ${to}), 0) as closing
            from journal_lines l
            join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
            join accounts a on a.id = l.account_id and a.org_id = l.org_id
           where l.org_id = ${resolvedOrgId} and a.type = 'asset_bank' and ${dimWhere(dims)}`,
  ));
  const openingCash = cash.rows[0]?.opening ?? ZERO;
  const closingCash = cash.rows[0]?.closing ?? ZERO;

  return {
    sections,
    netChange,
    openingCash,
    closingCash,
    reconciliationGap: decimalSubtract(decimalSubtract(closingCash, openingCash), netChange),
  };
}
