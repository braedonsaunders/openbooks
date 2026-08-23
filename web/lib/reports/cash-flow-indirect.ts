import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { glActivityBuckets, glSummaryEligibleDims } from "../gl-summary";
import { resolveOrgId } from "../org-scope";
import { decimalAdd, decimalIsMaterial, decimalNeg, decimalSum, type ExactDecimal } from "../statement-format";
import { ZERO, compareAbsoluteDescending, decimalSubtract } from "./decimals";
import { type DimFilter, dimWhere } from "./filters";
import { PNL_TYPES } from "./statements";

// ---------------------------------------------------------------------------
// Indirect-method cash flow (full GAAP presentation)
// ---------------------------------------------------------------------------

/** A fixed, non-account adjustment line (non-cash add-back). */
export interface CfAdjustmentLine {
  /** 'unrealizedFx' | 'disposal' | 'account' — the first two use i18n labels. */
  key: "unrealizedFx" | "disposal" | "account";
  /** Present when key === 'account': the P&L account's own name. */
  label?: string;
  accountId?: string;
  amount: ExactDecimal;
}

/** A per-account working-capital movement line. */
export interface CfWorkingCapitalLine {
  accountId: string;
  number: string | null;
  name: string;
  type: string;
  /** Cash effect: asset decreases / liability increases read positive. */
  amount: ExactDecimal;
}

/** A per-account investing/financing movement line (from cash-contra analysis). */
export interface CfAccountLine {
  accountId: string;
  number: string | null;
  name: string;
  type: string;
  amount: ExactDecimal;
}

export interface CashFlowIndirectResult {
  netIncome: ExactDecimal;
  adjustments: CfAdjustmentLine[];
  workingCapital: CfWorkingCapitalLine[];
  /** NI + adjustments + working capital. */
  operating: ExactDecimal;
  investing: CfAccountLine[];
  investingTotal: ExactDecimal;
  financing: CfAccountLine[];
  financingTotal: ExactDecimal;
  /** Translation effect on foreign-currency cash (usually zero). */
  fxEffectOnCash: ExactDecimal;
  netChange: ExactDecimal;
  openingCash: ExactDecimal;
  closingCash: ExactDecimal;
  reconciliationGap: ExactDecimal;
}

/**
 * Origins whose movements are definitionally non-cash re-measurement:
 * unrealized-FX revaluation and consolidation translation (CTA). Their working-
 * capital legs are stripped from the deltas and their P&L impact (revaluation
 * only) is added back — strip and add-back deliberately use the same origin
 * filter so the pair always nets out. Depreciation/disposal movements are NOT
 * stripped here: they are handled by the entry-level I/F classification below,
 * which is robust to disposals that write off working-capital balances.
 */
const CF_REMEASURE_ORIGINS = ["revaluation", "translation"];

const CF_WC_ASSET_TYPES = ["asset_receivable", "asset_current_other"];
const CF_WC_LIABILITY_TYPES = ["liability_payable", "liability_card", "liability_current_other"];
const CF_INVESTING_TYPES = ["asset_fixed", "asset_other"];
const CF_FINANCING_TYPES = ["liability_long_term", "equity"];

/**
 * Indirect-method statement of cash flows. The construction is exact, not
 * heuristic: every posted entry in the window falls into one of these classes,
 * and each class's effect lands in exactly one place, so the sections always
 * sum to the proven bank-balance movement.
 *
 *   entry class (posted, in window)        treatment
 *   ─────────────────────────────          ──────────────────────────────────
 *   touches bank + P&L                     net income
 *   touches bank + working capital         per-account WC movement
 *   touches bank + I/F accounts            investing/financing (cash-contra)
 *   touches bank, origin=disposal, + P&L   gain/loss moved operating→investing
 *   no bank; P&L + WC (invoices, accruals) NI offset by WC movement
 *   no bank; P&L + I/F (depreciation,      P&L added back; nothing in WC
 *     credit disposals)
 *   no bank; WC + I/F (asset on credit,    stripped from WC (non-cash)
 *     current↔long-term reclass)
 *   no bank; WC only (stock on credit,     gross WC movements (net internally)
 *     retainage/deposit reclasses)
 *   origin = revaluation                   P&L added back; WC legs stripped
 *   origin = translation                   WC legs stripped; bank leg is the
 *                                          "effect of FX on cash" line
 */
export async function cashFlowIndirect(
  from: string,
  to: string,
  dims?: DimFilter,
  orgId?: string,
): Promise<CashFlowIndirectResult> {
  const resolvedOrgId = await resolveOrgId(orgId);
  const dim = dimWhere(dims);
  const IF_TYPES = [...CF_INVESTING_TYPES, ...CF_FINANCING_TYPES];

  // Entries in the window that touch NO bank account but DO touch an
  // investing/financing account type. Their working-capital legs are non-cash
  // (reclasses, credit asset purchases/sales) and their P&L legs are the
  // non-cash add-backs (depreciation, disposal gains/losses on account).
  // Classifying by account id rather than joining `accounts` per line keeps
  // the per-entry aggregate on (entries ⋈ lines) alone: the account join made
  // the planner drive from accounts and probe the entry pk once per line —
  // millions of loops for a window that the entry date index can walk
  // directly. The two id sets are hashed once.
  const flaggedCte = sql`
    flagged as (
      select l.entry_id as id
        from journal_entries e
        join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
       where e.org_id = ${resolvedOrgId} and e.status in ('posted', 'reversed')
         and e.posting_date >= ${from} and e.posting_date <= ${to}
       group by l.entry_id
      having not bool_or(l.account_id in (
               select id from accounts where org_id = ${resolvedOrgId} and type = 'asset_bank'))
         and bool_or(l.account_id in (
               select id from accounts where org_id = ${resolvedOrgId} and type in ${IF_TYPES}))
    )`;

  // Net income for the window (credit-normal positive), posted only.
  const niBuckets = glSummaryEligibleDims(dims)
    ? glActivityBuckets(resolvedOrgId, { minDate: from, maxDate: to, boundaries: [] })
    : null;
  const ni = (await db.execute<{ ni: string }>(
    niBuckets
      // Window P&L from the summary; only months the report boundaries split
      // are read from the lines.
      ? sql`
          select -coalesce(sum(b.amount), 0) as ni
            from ${niBuckets} b
            join accounts a on a.id = b.account_id and a.org_id = ${resolvedOrgId}
           where a.type in ${PNL_TYPES}
             ${dims?.subsidiaryIds?.length ? sql`and b.subsidiary_id = any(${`{${dims.subsidiaryIds.join(',')}}`}::uuid[])` : sql``}`
      : sql`
          select -coalesce(sum(l.amount), 0) as ni
            from journal_lines l
            join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
            join accounts a on a.id = l.account_id and a.org_id = l.org_id
           where l.org_id = ${resolvedOrgId} and e.status in ('posted', 'reversed')
             and e.posting_date >= ${from} and e.posting_date <= ${to}
             and a.type in ${PNL_TYPES} and ${dim}`,
  ));
  const netIncome = ni.rows[0]?.ni ?? ZERO;

  // Add-backs. Sign convention throughout: the sum of the entry's debit-signed
  // P&L lines — expenses add back positive, gains add back negative.
  const adjustments: CfAdjustmentLine[] = [];
  {
    // (a) Unrealized FX revaluation (paired with the WC origin strip below).
    const a = (await db.execute<{ impact: string }>(sql`
      select coalesce(sum(l.amount), 0) as impact
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        join accounts a on a.id = l.account_id and a.org_id = l.org_id
       where l.org_id = ${resolvedOrgId} and e.status in ('posted', 'reversed')
         and e.posting_date >= ${from} and e.posting_date <= ${to}
         and e.origin = 'revaluation' and a.type in ${PNL_TYPES} and ${dim}
    `));
    const impact = a.rows[0]?.impact ?? ZERO;
    if (decimalIsMaterial(impact)) adjustments.push({ key: "unrealizedFx", amount: impact });

    // (b) P&L legs of no-bank entries that touch I/F accounts: depreciation
    // and amortization, impairment, non-cash disposal gains/losses. Per
    // account for detail; revaluation origin is excluded (handled at (a)).
    const b = (await db.execute<{ account_id: string; number: string | null; name: string; impact: string }>(sql`
      with ${flaggedCte}
      select l.account_id, a.number, a.name, sum(l.amount) as impact
        from journal_lines l
        join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        join accounts a on a.id = l.account_id and a.org_id = l.org_id
       where l.org_id = ${resolvedOrgId} and e.status in ('posted', 'reversed')
         and e.id in (select id from flagged)
         and e.origin <> 'revaluation'
         and a.type in ${PNL_TYPES} and ${dim}
       group by l.account_id, a.number, a.name
    `));
    for (const r of b.rows) {
      const amount = r.impact;
      if (!decimalIsMaterial(amount)) continue;
      adjustments.push({
        key: "account",
        accountId: r.account_id,
        label: `${r.number ? `${r.number} · ` : ""}${r.name}`,
        amount,
      });
    }
  }

  // Working-capital deltas per account, stripped of non-cash legs:
  //   adjustedDelta = (balance[to] − balance[from−1]) − stripped[window]
  // stripped = re-measurement origins + legs of no-bank entries touching I/F.
  // Asset increases use cash (negative); liability increases provide cash.
  const wc = (await db.execute<{ account_id: string; number: string | null; name: string; type: string; bal_to: string; bal_from: string; stripped: string }>(sql`
    with ${flaggedCte}
    select l.account_id, a.number, a.name, a.type,
           coalesce(sum(l.amount) filter (where e.posting_date <= ${to}), 0) as bal_to,
           coalesce(sum(l.amount) filter (where e.posting_date < ${from}), 0) as bal_from,
           coalesce(sum(l.amount) filter (where e.posting_date >= ${from} and e.posting_date <= ${to}
                                            and (e.origin in ${CF_REMEASURE_ORIGINS}
                                                 or e.id in (select id from flagged))), 0) as stripped
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${resolvedOrgId} and e.status in ('posted', 'reversed') and e.posting_date <= ${to}
       and a.type in ${[...CF_WC_ASSET_TYPES, ...CF_WC_LIABILITY_TYPES]} and ${dim}
     group by l.account_id, a.number, a.name, a.type
  `));
  const workingCapital: CfWorkingCapitalLine[] = wc.rows
    .map((r) => {
      // Debit-signed balances: an increase reads positive on assets (cash
      // use) and negative on liabilities (cash source) — so the cash impact
      // is uniformly −delta for every working-capital account.
      const delta = decimalSubtract(decimalSubtract(r.bal_to, r.bal_from), r.stripped);
      return {
        accountId: r.account_id,
        number: r.number,
        name: r.name,
        type: r.type,
        amount: decimalNeg(delta),
      };
    })
    .filter((line) => decimalIsMaterial(line.amount))
    .sort((a, b) => compareAbsoluteDescending(a.amount, b.amount));

  // Investing + financing: exact cash-contra population, per account. Cash-
  // touched disposal entries also contribute their P&L gain/loss legs so the
  // investing section presents gross proceeds (NBV movement + gain), matching
  // the disposal add-back in operating. Translation entries are excluded —
  // their non-bank legs are CTA re-measurement, not flows.
  const contra = (await db.execute<{ account_id: string; number: string | null; name: string; type: string; origin: string; cash_effect: string }>(sql`
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
         and e.origin <> 'translation'
    )
    select l.account_id, a.number, a.name, a.type, e.origin, -sum(l.amount) as cash_effect
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where e.id in (select id from cash_entries)
       and l.org_id = ${resolvedOrgId}
       and (
         a.type in ${IF_TYPES}
         or (a.type in ${PNL_TYPES} and e.origin = 'disposal')
       ) and ${dimWhere(dims)}
     group by l.account_id, a.number, a.name, a.type, e.origin
  `));
  const investing: CfAccountLine[] = [];
  const financing: CfAccountLine[] = [];
  let disposalGainOnCash = ZERO;
  for (const r of contra.rows) {
    const amount = r.cash_effect;
    if (!decimalIsMaterial(amount)) continue;
    const line: CfAccountLine = { accountId: r.account_id, number: r.number, name: r.name, type: r.type, amount };
    if (CF_FINANCING_TYPES.includes(r.type)) financing.push(line);
    else investing.push(line);
    // The P&L leg of a cash disposal is reclassified from operating (it is in
    // net income) into investing proceeds — the operating add-back is below.
    if (!IF_TYPES.includes(r.type)) disposalGainOnCash = decimalAdd(disposalGainOnCash, amount);
  }
  if (decimalIsMaterial(disposalGainOnCash)) {
    adjustments.push({ key: "disposal", amount: decimalNeg(disposalGainOnCash) });
  }
  investing.sort((a, b) => compareAbsoluteDescending(a.amount, b.amount));
  financing.sort((a, b) => compareAbsoluteDescending(a.amount, b.amount));

  // FX translation effect on foreign-currency cash balances.
  const fx = (await db.execute<{ effect: string }>(sql`
    select coalesce(sum(l.amount), 0) as effect
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      join accounts a on a.id = l.account_id and a.org_id = l.org_id
     where l.org_id = ${resolvedOrgId} and e.status in ('posted', 'reversed')
       and e.posting_date >= ${from} and e.posting_date <= ${to}
       and e.origin = 'translation' and a.type = 'asset_bank' and ${dim}
  `));
  const fxEffectOnCash = fx.rows[0]?.effect ?? ZERO;

  const operating = decimalSum([
    netIncome,
    ...adjustments.map((line) => line.amount),
    ...workingCapital.map((line) => line.amount),
  ]);
  const investingTotal = decimalSum(investing.map((line) => line.amount));
  const financingTotal = decimalSum(financing.map((line) => line.amount));
  const netChange = decimalSum([operating, investingTotal, financingTotal, fxEffectOnCash]);

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
             ${dims?.subsidiaryIds?.length ? sql`and b.subsidiary_id = any(${`{${dims.subsidiaryIds.join(',')}}`}::uuid[])` : sql``}`
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
    netIncome,
    adjustments,
    workingCapital,
    operating,
    investing,
    investingTotal,
    financing,
    financingTotal,
    fxEffectOnCash,
    netChange,
    openingCash,
    closingCash,
    reconciliationGap: decimalSubtract(decimalSubtract(closingCash, openingCash), netChange),
  };
}
