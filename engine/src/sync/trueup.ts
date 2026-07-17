import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { fromUnits, toUnits } from "../money.ts";
import type { MigrationSource } from "./source.ts";

/**
 * GL residual trueup — the migration's opening-balance / sub-ledger reconciler.
 *
 * Native documents reproduce AR/AP/payments exactly, but some source GL has no
 * importable document form: perpetual-inventory valuation (COGS, shrinkage —
 * the source computes it and the API never exposes the amount), realized FX on
 * settlement, and opening balances. For those, the honest migration treatment
 * is what a controller does by hand — bring them in as dated adjusting journal
 * entries. This posts, per posting month, the residual between the source's own
 * per-account GL (source.monthlyActivity, debit-positive, home currency) and
 * what our native documents posted. Each month nets to zero (double-entry), so
 * the entry balances; a sub-cent rounding drift is absorbed on the largest line.
 *
 * Trueup lines are is_open_item=false, so AR/AP aging (driven by the native
 * documents + applications) is untouched. Idempotent: once trued, the residual
 * is zero and re-runs post nothing. A NO-OP where native import is already
 * penny-exact (e.g. NetSuite) — nothing is posted.
 */

export interface TrueUpStats {
  entries: number;
  lines: number;
  byAccount: { account: string; amount: string }[];
}

const MONTH_END = (m: string): string => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y!, mo!, 0)).toISOString().slice(0, 10);
};

export async function trueUpResidualGl(
  orgId: string,
  source: MigrationSource,
): Promise<TrueUpStats> {
  const refKey = source.refKey;
  const empty: TrueUpStats = { entries: 0, lines: 0, byAccount: [] };
  if (!source.monthlyActivity) return empty;

  // -- source GL per (accountRef, month), debit-positive, home currency --------
  const srcRows = await source.monthlyActivity();
  const bookRow = (await db.execute(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary limit 1`)) as any;
  const bookId = bookRow.rows[0]?.id;
  const subRow = (await db.execute(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null limit 1`)) as any;
  const subsidiaryId = subRow.rows[0]?.id;
  if (!bookId || !subsidiaryId) return empty;

  // accountRef → openbooks account id
  const accRows = (await db.execute(sql`
    select id, custom->>${refKey} as ref from accounts where org_id = ${orgId} and custom->>${refKey} is not null`)) as any;
  const idByRef = new Map<string, string>(accRows.rows.map((r: any) => [r.ref as string, r.id as string]));

  // -- our posted GL per (accountId, month), debit-positive --------------------
  const oursRows = (await db.execute(sql`
    select jl.account_id as account_id, to_char(e.posting_date, 'YYYY-MM') as m, sum(jl.amount) as amt
      from journal_lines jl
      join journal_entries e on e.id = jl.entry_id
     where jl.org_id = ${orgId} and e.status = 'posted'
     group by 1, 2`)) as any;
  const ours = new Map<string, bigint>(); // `${accountId}|${month}` → units
  for (const r of oursRows.rows) ours.set(`${r.account_id}|${r.m}`, toUnits(r.amt));

  // -- residual per (accountId, month) = source − ours -------------------------
  const residualByMonth = new Map<string, Map<string, bigint>>(); // month → accountId → units
  const seen = new Set<string>();
  const bump = (month: string, accountId: string, units: bigint) => {
    if (units === 0n) return;
    const m = residualByMonth.get(month) ?? new Map<string, bigint>();
    m.set(accountId, (m.get(accountId) ?? 0n) + units);
    residualByMonth.set(month, m);
  };
  for (const s of srcRows) {
    const accountId = idByRef.get(s.accountRef);
    if (!accountId) continue; // account not migrated — skipped, surfaced by the gate
    const key = `${accountId}|${s.month}`;
    seen.add(key);
    bump(s.month, accountId, toUnits(s.amount) - (ours.get(key) ?? 0n));
  }
  // accounts we posted to that the source's monthly set didn't mention → remove our extra
  for (const [key, amt] of ours) {
    if (seen.has(key) || amt === 0n) continue;
    const [accountId, month] = key.split("|");
    bump(month!, accountId!, -amt);
  }

  // -- post one adjusting entry per month --------------------------------------
  const byAccountTotal = new Map<string, bigint>();
  let entries = 0;
  let lines = 0;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('openbooks.migration', 'on', true)`);
    for (const [month, accs] of [...residualByMonth.entries()].sort()) {
      const entryLines = [...accs.entries()].filter(([, u]) => u !== 0n);
      if (entryLines.length === 0) continue;
      // Force exact balance: nudge any sub-cent drift onto the largest line.
      let net = entryLines.reduce((a, [, u]) => a + u, 0n);
      if (net !== 0n) {
        entryLines.sort((a, b) => (b[1] < 0n ? -b[1] : b[1]) > (a[1] < 0n ? -a[1] : a[1]) ? 1 : -1);
        entryLines[0]![1] -= net;
      }
      const endOn = MONTH_END(month);
      const per = (await tx.execute(sql`
        select id from accounting_periods where org_id = ${orgId} and starts_on <= ${endOn} and ends_on >= ${endOn}
         and is_adjustment = false order by starts_on limit 1`)) as any;
      const periodId = per.rows[0]?.id;
      if (!periodId) continue;

      const eRes = (await tx.execute(sql`
        insert into journal_entries (org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
        values (${orgId}, ${bookId}, ${subsidiaryId}, ${`TRUEUP-${month}`}, ${endOn}, ${periodId},
                ${`Migration GL trueup ${month}`}, 'draft', 'migration')
        returning id`)) as any;
      const entryId = eRes.rows[0].id;
      let ln = 0;
      for (const [accountId, units] of entryLines) {
        if (units === 0n) continue;
        await tx.execute(sql`
          insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, is_open_item)
          values (${orgId}, ${entryId}, ${++ln}, ${accountId}, ${subsidiaryId}, ${fromUnits(units)},
                  (select base_currency from orgs where id = ${orgId}), ${fromUnits(units)}, 1, false)`);
        byAccountTotal.set(accountId, (byAccountTotal.get(accountId) ?? 0n) + units);
        lines++;
      }
      await tx.execute(sql`update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
      entries++;
    }
  });

  return {
    entries,
    lines,
    byAccount: [...byAccountTotal.entries()].map(([account, units]) => ({ account, amount: fromUnits(units) })),
  };
}
