import { excludePeriodEndJournals } from "../records/period-end-origins.ts";
import { sql } from "drizzle-orm";
import { db, type SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { activePostingPrimaryBookId } from "../platform/accounting-books.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { uuidArray } from "../organization/subsidiaries.ts";
import {
  intercompanySideAccounts,
  loadActiveIntercompanyPairs,
} from "../organization/intercompany-accounts.ts";
import { IntercompanyError } from "./errors.ts";

/**
 * Intercompany reconciliation by pair and currency, from the ledger.
 *
 * For each active pair, each entity's intercompany balance with the other is
 * read from the accounts the pair names for it: the intercompany receivable,
 * the intercompany payable and the due-to/due-from position, in transaction
 * currency (a debit is owed to the entity). The two entities agree when
 * their balances in a currency sum to zero; the difference is what remains to
 * reconcile (an invoice without its bill, a payment one side has not
 * recorded). Realized and unrealized exchange entries carry no transaction-
 * currency exposure and are excluded, the same position definition netting
 * and revaluation use. Functional totals are shown per entity for tie-out.
 */

export interface ReconciliationSide {
  subsidiaryId: string;
  subsidiaryName: string;
  receivable: string;
  payable: string;
  position: string;
  /** receivable + payable + position, owed to the entity positive. */
  net: string;
  /** The same balance in the entity's functional currency. */
  functionalNet: string;
  functionalCurrency: string;
}

export interface ReconciliationRow {
  pairId: string;
  currency: string;
  from: ReconciliationSide;
  to: ReconciliationSide;
  /** from.net + to.net; zero when the entities agree. */
  difference: string;
}

type BalanceRow = {
  subsidiary_id: string;
  account_id: string;
  currency: string;
  txn: string;
  base: string;
};

export async function intercompanyReconciliation(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  input: { asOfDate: string; bookId?: string | null },
  runner: SqlExecutor = db,
): Promise<ReconciliationRow[]> {
  if (!isIsoCalendarDate(input.asOfDate))
    throw new IntercompanyError(
      "the reconciliation date must be a valid calendar date (YYYY-MM-DD)",
    );
  const bookId = input.bookId ?? (await activePostingPrimaryBookId(orgId, runner));
  if (!bookId)
    throw new IntercompanyError(
      "there is no active primary accounting book; set one in Setup → Accounting → Accounting books",
    );
  const pairs = (await loadActiveIntercompanyPairs(runner, orgId)).filter(
    (pair) =>
      allowedSubsidiaryIds === null ||
      (allowedSubsidiaryIds.has(pair.fromSubsidiaryId) &&
        allowedSubsidiaryIds.has(pair.toSubsidiaryId)),
  );
  if (pairs.length === 0) return [];
  const keys: {
    subsidiaryId: string;
    accountId: string;
    pairId: string;
    role: "receivable" | "payable" | "position";
  }[] = [];
  for (const pair of pairs) {
    for (const subsidiaryId of [pair.fromSubsidiaryId, pair.toSubsidiaryId]) {
      const side = intercompanySideAccounts(pair, subsidiaryId)!;
      keys.push({
        subsidiaryId,
        accountId: side.positionAccountId,
        pairId: pair.id,
        role: "position",
      });
      if (side.receivableAccountId)
        keys.push({
          subsidiaryId,
          accountId: side.receivableAccountId,
          pairId: pair.id,
          role: "receivable",
        });
      if (side.payableAccountId)
        keys.push({
          subsidiaryId,
          accountId: side.payableAccountId,
          pairId: pair.id,
          role: "payable",
        });
    }
  }
  const balances = await runner.execute<BalanceRow>(
    sql`
    select jl.subsidiary_id, jl.account_id, jl.currency,
           sum(jl.txn_amount)::text as txn, sum(jl.amount)::text as base
      from journal_lines jl
      join journal_entries je
        on je.org_id = jl.org_id and je.id = jl.entry_id
       and je.status in ('posted', 'reversed') and je.book_id = ${bookId}
     where jl.org_id = ${orgId} and je.posting_date <= ${input.asOfDate}
       and je.origin not in ('fx_revaluation', 'fx_settlement')
       and ${excludePeriodEndJournals(sql`je.origin`)}
       and exists (
         select 1 from unnest(${uuidArray(keys.map((k) => k.subsidiaryId))}::uuid[], ${uuidArray(keys.map((k) => k.accountId))}::uuid[]) as k(sub, acct)
          where k.sub = jl.subsidiary_id and k.acct = jl.account_id)
     group by jl.subsidiary_id, jl.account_id, jl.currency`,
    "objects",
  );
  const subs = await runner.execute<{ id: string; name: string; base_currency: string }>(
    sql`
    select id, name, base_currency from subsidiaries where org_id = ${orgId}`,
    "objects",
  );
  const subById = new Map(subs.map((sub) => [sub.id, sub]));
  const rows: ReconciliationRow[] = [];
  for (const pair of pairs) {
    const pairKeys = keys.filter((key) => key.pairId === pair.id);
    const currencies = [
      ...new Set(
        balances
          .filter((b) =>
            pairKeys.some(
              (k) => k.subsidiaryId === b.subsidiary_id && k.accountId === b.account_id,
            ),
          )
          .map((b) => b.currency),
      ),
    ].sort();
    for (const currency of currencies) {
      const side = (subsidiaryId: string): ReconciliationSide => {
        const totals = { receivable: 0n, payable: 0n, position: 0n, functional: 0n };
        for (const key of pairKeys.filter((k) => k.subsidiaryId === subsidiaryId)) {
          const balance = balances.find(
            (b) =>
              b.subsidiary_id === subsidiaryId &&
              b.account_id === key.accountId &&
              b.currency === currency,
          );
          if (!balance) continue;
          totals[key.role] += toUnits(balance.txn);
          totals.functional += toUnits(balance.base);
        }
        const sub = subById.get(subsidiaryId);
        return {
          subsidiaryId,
          subsidiaryName: sub?.name ?? subsidiaryId,
          receivable: fromUnits(totals.receivable),
          payable: fromUnits(totals.payable),
          position: fromUnits(totals.position),
          net: fromUnits(totals.receivable + totals.payable + totals.position),
          functionalNet: fromUnits(totals.functional),
          functionalCurrency: sub?.base_currency ?? "",
        };
      };
      const from = side(pair.fromSubsidiaryId);
      const to = side(pair.toSubsidiaryId);
      rows.push({
        pairId: pair.id,
        currency,
        from,
        to,
        difference: fromUnits(toUnits(from.net) + toUnits(to.net)),
      });
    }
  }
  return rows;
}

/** How many pair/currency balances disagree as of a date (close readiness). */
export async function unreconciledIntercompanyCount(
  orgId: string,
  input: { asOfDate: string; bookId?: string | null; subsidiaryIds?: readonly string[] | null },
  runner: SqlExecutor = db,
): Promise<number> {
  const scope =
    input.subsidiaryIds && input.subsidiaryIds.length > 0 ? new Set(input.subsidiaryIds) : null;
  const rows = await intercompanyReconciliation(
    orgId,
    null,
    { asOfDate: input.asOfDate, bookId: input.bookId },
    runner,
  );
  return rows.filter(
    (row) =>
      toUnits(row.difference) !== 0n &&
      (scope === null || scope.has(row.from.subsidiaryId) || scope.has(row.to.subsidiaryId)),
  ).length;
}
