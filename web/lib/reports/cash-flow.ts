import {
  translationMultiplier,
  statementHistoricalAmounts,
  statementTranslatedAmount,
  assertRateCoverage,
  type StatementSubsidiaryContext,
} from "../statement-matrix";
import { HistoricalTranslationEvidenceError } from "@openbooks/engine/journal/historical-translation-evidence";
import "server-only";
import { sql } from "drizzle-orm";
import { functionalReportReader } from "./currency-basis";
import { excludePeriodEndJournals } from "@openbooks/engine/records/period-end-origins";
import {
  bucketSubsidiaryFilter,
  glActivityBuckets,
  glSummaryEligibleDims,
  statementBookIdsExpr,
} from "../gl-summary";
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
  /** Translation effect on foreign-currency cash (usually zero). */
  fxEffectOnCash: ExactDecimal;
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
 *
 * Every leg answers for the same selected reporting basis (`bookId`, the org's
 * primary book when omitted — see statementBookExpr): journal entries are
 * book-mandatory, and an unscoped read would fuse a parallel book's mirror
 * entries into the sections while the summary-backed cash balances stayed
 * on another basis, so the statement could never tie. Adjustment-only books include the primary book through the shared basis resolver.
 */
export async function cashFlow(
  from: string,
  to: string,
  dims?: DimFilter,
  orgId?: string,
  bookId?: string | null,
  subsidiary?: StatementSubsidiaryContext,
): Promise<CashFlowResult> {
  const resolvedOrgId = await resolveOrgId(orgId);
  const translated = !!(
    subsidiary?.presentationCurrency ||
    subsidiary?.rates?.length ||
    subsidiary?.weights?.length ||
    subsidiary?.controlLosses?.length
  );
  const openingDate = new Date(`${from}T00:00:00Z`);
  openingDate.setUTCDate(openingDate.getUTCDate() - 1);
  const openingAsOf = openingDate.toISOString().slice(0, 10);
  if (subsidiary?.rates?.length) {
    assertRateCoverage(subsidiary!, [{ from, to }], "flow");
    assertRateCoverage(
      subsidiary!,
      [
        { from: openingAsOf, to: openingAsOf },
        { from: to, to },
      ],
      "balance",
    );
  }
  const historical = await statementHistoricalAmounts(
    resolvedOrgId,
    subsidiary,
    "flow",
    sql`e.posting_date`,
    sql`
    e.posting_date between ${from}::date and ${to}::date
    and e.book_id in ${statementBookIdsExpr(resolvedOrgId, bookId)} and ${dimWhere(dims)}
    and e.origin not in ('fx_revaluation','currency_adjustment')
    and exists(select 1 from journal_lines bank join accounts bank_account on bank_account.org_id=bank.org_id and bank_account.id=bank.account_id
      where bank.org_id=e.org_id and bank.entry_id=e.id and bank_account.type='asset_bank')`,
    true,
  );
  const flowAmount = statementTranslatedAmount("flow", subsidiary, historical, undefined, true);
  const openingAmount = sql`l.amount * ${translationMultiplier("balance", subsidiary, openingAsOf, true)}`;
  const closingAmount = sql`l.amount * ${translationMultiplier("balance", subsidiary, to, true)}`;
  const reportDb = functionalReportReader(
    resolvedOrgId,
    sql`e.posting_date <= ${to} and e.book_id in ${statementBookIdsExpr(resolvedOrgId, bookId)} and ${dimWhere(dims)}`,
    translated,
  );
  const book = statementBookIdsExpr(resolvedOrgId, bookId);
  // Contra movements: non-bank lines on entries that also hit a bank account,
  // grouped by account type. `-sum(amount)` converts debit-signed line amounts
  // into their effect on cash (credit a contra → cash in → positive).
  // Unrealized FX revaluation entries are excluded: restating a
  // foreign-currency bank balance moves no cash, and their P&L contra leg
  // would otherwise read as an operating receipt. Their bank legs surface
  // below as the effect of exchange-rate changes on cash instead.
  const contra = await reportDb.execute<{
    type: string;
    cash_effect: string;
    disposal_gain: boolean;
    missingHistorical: boolean;
  }>(sql`
    with cash_entries as (
      -- Bank-touching entries by account id: joining accounts per line made
      -- the planner drive from accounts and probe the entry pk per line.
      select distinct l.entry_id as id
        from journal_entries e
        join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
       where e.org_id = ${resolvedOrgId} and e.status in ('posted', 'reversed')
         and l.posting_date >= ${from} and l.posting_date <= ${to}
         and e.posting_date >= ${from} and e.posting_date <= ${to}
         and e.book_id in ${book}
         and e.origin not in ('fx_revaluation','currency_adjustment')
         and ${excludePeriodEndJournals(sql`e.origin`)}
         and l.account_id in (
           select id from accounts where org_id = ${resolvedOrgId} and type = 'asset_bank')
    )
    select ${reportDb.censusColumn}, a.type, -round(sum(${flowAmount}),4) as cash_effect,
           bool_or((${flowAmount}) is null) as "missingHistorical",
           -- A cash disposal's gain/loss is part of investing proceeds (the
           -- indirect statement reclassifies it the same way), never an
           -- operating receipt — even though its account types read operating.
           -- Grouped, not merely flagged: a shared gain/loss account carries
           -- genuine operating flows too, and those must stay operating.
           (e.origin = 'disposal' and a.type in
             ('income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred')) as disposal_gain
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where e.id in (select id from cash_entries)
       and e.book_id in ${book}
       and l.org_id = ${resolvedOrgId} and a.type <> 'asset_bank' and ${dimWhere(dims)}
     group by a.type,
           (e.origin = 'disposal' and a.type in
             ('income', 'income_other', 'cogs', 'expense', 'expense_other', 'expense_deferred'))
  `);
  if (contra.rows.some((row) => row.missingHistorical))
    throw new HistoricalTranslationEvidenceError(
      "A cash-flow translation source is unavailable. Reload the statement; for historical equity, open the Journal entry → Historical translation tab, obtain Accounting event approval for its retained source and genuine layers, then Apply. For period rates, derive the missing consolidated rate set from Period Close.",
    );

  const bySection: Record<CashFlowSection, CashFlowLine[]> = {
    operating: [],
    investing: [],
    financing: [],
  };
  for (const row of contra.rows) {
    const amount = row.cash_effect;
    if (!decimalIsMaterial(amount)) continue;
    const section = row.disposal_gain ? "investing" : (CASH_FLOW_SECTION[row.type] ?? "operating");
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

  // FX translation effect on foreign-currency cash balances: the bank legs of
  // unrealized revaluation entries, kept out of the sections above.
  const fx = await reportDb.execute<{ effect: string }>(sql`
    select ${reportDb.censusColumn}, coalesce(round(sum(${flowAmount}),4), 0) as effect
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${resolvedOrgId} and e.status in ('posted', 'reversed')
       and l.posting_date >= ${from} and l.posting_date <= ${to}
       and e.posting_date >= ${from} and e.posting_date <= ${to}
       and e.book_id in ${statementBookIdsExpr(resolvedOrgId, bookId)}
       and e.origin in ('fx_revaluation','currency_adjustment') and a.type = 'asset_bank' and ${dimWhere(dims)}
  `);
  let fxEffectOnCash = fx.rows[0]?.effect ?? ZERO;

  let netChange = decimalSum([...sections.map((section) => section.subtotal), fxEffectOnCash]);

  // Opening/closing cash straight from the bank accounts, proving the tie-out.
  const cashBuckets =
    !translated && glSummaryEligibleDims(dims)
      ? glActivityBuckets(resolvedOrgId, {
          minDate: null,
          maxDate: to,
          boundaries: [{ date: from, kind: "start" }],
          bookId,
        })
      : null;
  const cash = await reportDb.execute<{ opening: string; closing: string }>(
    cashBuckets
      ? // Inception-to-date bank movement from the summary; the two report
        // boundaries are the only months that fall back to the lines.
        sql`
          select ${reportDb.censusColumn}, coalesce(sum(b.amount) filter (where b.d < ${from}), 0) as opening,
                 coalesce(sum(b.amount) filter (where b.d <= ${to}), 0) as closing
            from ${cashBuckets} b
            join accounts a on a.id = b.account_id and a.org_id = ${resolvedOrgId}
           where a.type = 'asset_bank'
             ${bucketSubsidiaryFilter(dims?.subsidiaryIds)}`
      : sql`
          select ${reportDb.censusColumn}, coalesce(round(sum(${openingAmount}) filter (where e.posting_date < ${from}),4), 0) as opening,
                 coalesce(round(sum(${closingAmount}) filter (where e.posting_date <= ${to}),4), 0) as closing
            from journal_lines l
            join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id and e.status in ('posted', 'reversed')
              and e.book_id in ${book}
              and ${excludePeriodEndJournals(sql`e.origin`)}
            join accounts a on a.id = l.account_id and a.org_id = l.org_id
           where l.org_id = ${resolvedOrgId} and a.type = 'asset_bank' and ${dimWhere(dims)}`,
  );
  const openingCash = cash.rows[0]?.opening ?? ZERO;
  const closingCash = cash.rows[0]?.closing ?? ZERO;
  if (translated) {
    const movement =
      (
        await reportDb.execute<{ amount: string }>(sql`
      select ${reportDb.censusColumn},coalesce(round(sum(${flowAmount}),4),0)::text as amount
      from journal_lines l join journal_entries e on e.org_id=l.org_id and e.id=l.entry_id
      join accounts a on a.org_id=l.org_id and a.id=l.account_id
      where l.org_id=${resolvedOrgId} and e.status in ('posted','reversed') and a.type='asset_bank'
        and l.posting_date >= ${from}::date and l.posting_date <= ${to}::date
        and e.posting_date between ${from}::date and ${to}::date
        and e.book_id in ${statementBookIdsExpr(resolvedOrgId, bookId)} and ${dimWhere(dims)}
        and ${excludePeriodEndJournals(sql`e.origin`)}
    `)
      ).rows[0]?.amount ?? ZERO;
    const currencyEffect = decimalSubtract(decimalSubtract(closingCash, openingCash), movement);
    netChange = decimalSubtract(netChange, fxEffectOnCash);
    fxEffectOnCash = decimalSum([fxEffectOnCash, currencyEffect]);
    netChange = decimalSum([netChange, fxEffectOnCash]);
  }

  return {
    sections,
    fxEffectOnCash,
    netChange,
    openingCash,
    closingCash,
    reconciliationGap: decimalSubtract(decimalSubtract(closingCash, openingCash), netChange),
  };
}
