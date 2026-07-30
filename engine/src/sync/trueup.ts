import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { assertPeriodModulesOpen } from "../close.ts";
import { db, withOrg } from "../db.ts";
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

export interface TrueUpControlContext {
  /** Human actor when a user launched the sync; null means connector/system. */
  actorId?: string | null;
  /** Immutable sync-run attribution for connector-initiated adjustments. */
  syncRunId?: string | null;
}

const MONTH_END = (m: string): string => {
  const [y, mo] = m.split("-").map(Number);
  return new Date(Date.UTC(y!, mo!, 0)).toISOString().slice(0, 10);
};

export async function trueUpResidualGl(
  orgId: string,
  source: MigrationSource,
  control: TrueUpControlContext = {},
): Promise<TrueUpStats> {
  const refKey = source.refKey;
  const empty: TrueUpStats = { entries: 0, lines: 0, byAccount: [] };
  const srcRows = await source.monthlyActivity();
  if (srcRows.length === 0) return empty;

  return withOrg(orgId, async () => {
    await db.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(${`migration-gl-trueup:${orgId}:${source.name}`}, 0)
      )
    `);
    const org = (await db.execute(sql`
      select base_currency
        from orgs
       where id = ${orgId}
    `)) as unknown as { rows: { base_currency: string }[] };
    if (!org.rows[0]) throw new Error("true-up organization not found");
    if (org.rows[0].base_currency !== source.baseCurrency) {
      throw new Error(
        `true-up source currency ${source.baseCurrency} does not match organization base currency ${org.rows[0].base_currency}`,
      );
    }
    const bookRow = (await db.execute(sql`
      select id
        from accounting_books
       where org_id = ${orgId} and is_primary
       limit 1
    `)) as unknown as { rows: { id: string }[] };
    const bookId = bookRow.rows[0]?.id;
    if (!bookId) throw new Error("true-up requires a primary accounting book");
    const subRow = (await db.execute(sql`
      select id
        from subsidiaries
       where org_id = ${orgId} and parent_id is null
       limit 1
    `)) as unknown as { rows: { id: string }[] };
    const subsidiaryId = subRow.rows[0]?.id;
    if (!subsidiaryId) throw new Error("true-up requires a root subsidiary");

    const accRows = (await db.execute(sql`
      select id, custom->>${refKey} as ref
        from accounts
       where org_id = ${orgId}
         and custom->>${refKey} is not null
    `)) as unknown as { rows: { id: string; ref: string }[] };
    const idByRef = new Map(
      accRows.rows.map((row) => [row.ref, row.id] as const),
    );
    const missingRefs = [
      ...new Set(
        srcRows
          .map((row) => row.accountRef)
          .filter((accountRef) => !idByRef.has(accountRef)),
      ),
    ].sort();
    if (missingRefs.length > 0) {
      throw new Error(
        `true-up cannot silently omit ${missingRefs.length} unmapped source account(s): ${missingRefs.join(", ")}`,
      );
    }
    for (const row of srcRows) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(row.month)) {
        throw new Error(`invalid true-up source month ${row.month}`);
      }
    }

    const oursRows = (await db.execute(sql`
      select jl.account_id, to_char(e.posting_date, 'YYYY-MM') as month,
             sum(jl.amount)::text as amount
        from journal_lines jl
        join journal_entries e
          on e.id = jl.entry_id and e.org_id = jl.org_id
       where jl.org_id = ${orgId}
         and e.status in ('posted', 'reversed')
       group by jl.account_id, to_char(e.posting_date, 'YYYY-MM')
    `)) as unknown as {
      rows: { account_id: string; month: string; amount: string }[];
    };
    const ours = new Map<string, bigint>();
    for (const row of oursRows.rows) {
      ours.set(
        `${row.account_id}|${row.month}`,
        toUnits(row.amount),
      );
    }

    const residualByMonth = new Map<string, Map<string, bigint>>();
    const seen = new Set<string>();
    const bump = (month: string, accountId: string, units: bigint) => {
      if (units === 0n) return;
      const monthRows =
        residualByMonth.get(month) ?? new Map<string, bigint>();
      monthRows.set(accountId, (monthRows.get(accountId) ?? 0n) + units);
      residualByMonth.set(month, monthRows);
    };
    for (const sourceRow of srcRows) {
      const accountId = idByRef.get(sourceRow.accountRef)!;
      const key = `${accountId}|${sourceRow.month}`;
      // Multiple source rows for one account/month contribute to one source
      // total. Subtract our total once, after source aggregation.
      const monthRows =
        residualByMonth.get(sourceRow.month) ?? new Map<string, bigint>();
      monthRows.set(
        accountId,
        (monthRows.get(accountId) ?? 0n) + toUnits(sourceRow.amount),
      );
      residualByMonth.set(sourceRow.month, monthRows);
      seen.add(key);
    }
    for (const [key, amount] of ours) {
      const [accountId, month] = key.split("|") as [string, string];
      if (seen.has(key)) bump(month, accountId, -amount);
      else if (amount !== 0n) bump(month, accountId, -amount);
    }

    const byAccountTotal = new Map<string, bigint>();
    let entries = 0;
    let lines = 0;
    await db.execute(sql`select set_config('openbooks.migration', 'on', true)`);
    for (const [month, accounts] of [...residualByMonth.entries()].sort()) {
      const entryLines = [...accounts.entries()].filter(
        ([, units]) => units !== 0n,
      );
      if (entryLines.length === 0) continue;
      const net = entryLines.reduce(
        (total, [, units]) => total + units,
        0n,
      );
      if (net !== 0n) {
        throw new Error(
          `source residual for ${month} is unbalanced by ${fromUnits(net)}; true-up refused instead of silently changing a source amount`,
        );
      }
      const endOn = MONTH_END(month);
      const period = (await db.execute(sql`
        select id
          from accounting_periods
         where org_id = ${orgId}
           and starts_on <= ${endOn}
           and ends_on >= ${endOn}
           and not is_adjustment
         order by starts_on
         limit 1
      `)) as unknown as { rows: { id: string }[] };
      const periodId = period.rows[0]?.id;
      if (!periodId) {
        throw new Error(`no accounting period covers true-up month ${month}`);
      }
      await assertPeriodModulesOpen(db, {
        orgId,
        periodId,
        bookId,
        subsidiaryIds: [subsidiaryId],
        modules: ["gl"],
      });

      const entryId = randomUUID();
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, memo, status, origin, created_by, updated_by)
        values
          (${entryId}, ${orgId}, ${bookId}, ${subsidiaryId},
           ${`TRUEUP-${month}-${entryId.slice(0, 8)}`}, ${endOn}, ${periodId},
           ${`Migration GL true-up ${source.name} ${month}`}, 'draft',
           'migration', ${control.actorId ?? null}, ${control.actorId ?? null})
      `);
      let lineNumber = 0;
      for (const [accountId, units] of entryLines) {
        await db.execute(sql`
          insert into journal_lines
            (org_id, entry_id, line_number, account_id, subsidiary_id,
             amount, currency, txn_amount, fx_rate, is_open_item)
          values
            (${orgId}, ${entryId}, ${++lineNumber}, ${accountId},
             ${subsidiaryId}, ${fromUnits(units)},
             ${org.rows[0].base_currency}, ${fromUnits(units)}, 1, false)
        `);
        byAccountTotal.set(
          accountId,
          (byAccountTotal.get(accountId) ?? 0n) + units,
        );
        lines++;
      }
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now(),
               posted_by = ${control.actorId ?? null},
               updated_at = now(), updated_by = ${control.actorId ?? null}
         where id = ${entryId}
      `);
      await db.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values
          (${orgId}, 'journal_entries', ${entryId}, 'insert',
           ${JSON.stringify({
             mode: "migration_gl_trueup",
             source: source.name,
             month,
             syncRunId: control.syncRunId ?? null,
             lineCount: entryLines.length,
           })}::jsonb,
           ${control.actorId ?? null},
           ${control.syncRunId ?? "migration_gl_trueup"})
      `);
      entries++;
    }
    return {
      entries,
      lines,
      byAccount: [...byAccountTotal.entries()].map(([account, units]) => ({
        account,
        amount: fromUnits(units),
      })),
    };
  });
}
