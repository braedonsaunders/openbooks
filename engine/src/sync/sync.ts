import { desc, eq, sql } from "drizzle-orm";
import { db, pool, schema } from "../db.ts";
import { fromUnits, toUnits } from "../money.ts";
import type { MigrationSource, SourceTransaction } from "./source.ts";

/**
 * Incremental sync: pull changed source transactions, land them in the
 * kernel, verify the trial balance against the live source.
 *
 *  - new transaction        → post a new origin='migration' entry
 *  - changed transaction    → REVERSE the old entry (linked via
 *    reverses_entry_id) and post the current version — proper accounting,
 *    never mutation; the audit trail keeps every version
 *  - unchanged              → skip (multiset compare of account/amount)
 *
 * Idempotency key: entry_number = `NS-<type>-<number>-<sourceRef>`, matching
 * the full-migration loader.
 */

export interface SyncResult {
  runId: string;
  newEntries: number;
  reversedEntries: number;
  unchanged: number;
  skipped: string[];
  tb: { accounts: number; matches: number; mismatches: { accountRef: string; ours: string; theirs: string }[] };
  syncedThrough: string;
  durationMs: number;
}

const entryNumberFor = (t: SourceTransaction) => `NS-${t.type}-${t.number ?? t.sourceRef}-${t.sourceRef}`;

function linesKey(lines: { accountRef?: string; accountNs?: string; amount: string }[]): string {
  return lines
    .map((l) => `${l.accountRef ?? l.accountNs}:${fromUnits(toUnits(l.amount))}`)
    .sort()
    .join("|");
}

export async function runSync(source: MigrationSource, triggeredBy: string): Promise<SyncResult> {
  const started = Date.now();
  const [org] = await db.select().from(schema.orgs);
  const [book] = await db.select().from(schema.accountingBooks).where(eq(schema.accountingBooks.isPrimary, true));

  const [run] = await db
    .insert(schema.syncRuns)
    .values({ orgId: org.id, source: source.name, kind: "incremental", triggeredBy })
    .returning();

  try {
    const [lastOk] = await db
      .select()
      .from(schema.syncRuns)
      .where(sql`${schema.syncRuns.status} = 'ok' and ${schema.syncRuns.source} = ${source.name} and ${schema.syncRuns.syncedThrough} is not null`)
      .orderBy(desc(schema.syncRuns.syncedThrough))
      .limit(1);
    // First incremental run after the full migration: look back a safe window.
    const since = lastOk?.syncedThrough ?? new Date(Date.now() - 3 * 24 * 3600 * 1000);

    const changes = await source.changesSince(since);

    // mapping caches
    const acctRows = await db.execute(sql`select id, custom->>'nsId' as ns from accounts where custom->>'nsId' is not null`);
    const acctByRef = new Map((acctRows as any).rows.map((r: any) => [r.ns, r.id]));
    const deptRows = await db.execute(sql`select id, custom->>'nsId' as ns from departments`);
    const deptByRef = new Map((deptRows as any).rows.map((r: any) => [r.ns, r.id]));
    const partyRows = await db.execute(sql`select id, custom->>'nsId' as ns from parties`);
    const partyByRef = new Map((partyRows as any).rows.map((r: any) => [r.ns, r.id]));
    const periods = (await db.execute(sql`select id, starts_on, ends_on from accounting_periods where org_id=${org.id}`)) as any;
    const periodFor = (d: string) => periods.rows.find((p: any) => p.starts_on <= d && p.ends_on >= d)?.id;

    let newEntries = 0, reversedEntries = 0, unchanged = 0;
    const skipped: string[] = [];

    const client = await pool.connect();
    try {
      for (const txn of changes.transactions) {
        if (txn.lines.length === 0) { unchanged++; continue; }
        const number = entryNumberFor(txn);

        // current live entry for this source txn (latest non-reversed)
        const existing = await client.query(
          `select e.id, e.status from journal_entries e
            where e.entry_number = $1 and e.status = 'posted'
              and not exists (select 1 from journal_entries r where r.reverses_entry_id = e.id)
            order by e.created_at desc limit 1`,
          [number],
        );

        if (existing.rowCount) {
          const cur = await client.query(
            `select a.custom->>'nsId' as ns, l.amount from journal_lines l
              join accounts a on a.id = l.account_id where l.entry_id = $1`,
            [existing.rows[0].id],
          );
          const curKey = linesKey(cur.rows.map((r: any) => ({ accountRef: r.ns, amount: r.amount })));
          if (curKey === linesKey(txn.lines)) { unchanged++; continue; }
        }

        const periodId = periodFor(txn.date);
        if (!periodId) { skipped.push(`${txn.sourceRef}: no period for ${txn.date}`); continue; }
        const total = txn.lines.reduce((a, l) => a + toUnits(l.amount), 0n);
        if (total !== 0n) { skipped.push(`${txn.sourceRef}: imbalance ${fromUnits(total)}`); continue; }
        const unmapped = txn.lines.find((l) => !acctByRef.has(l.accountRef));
        if (unmapped) { skipped.push(`${txn.sourceRef}: unmapped account ${unmapped.accountRef}`); continue; }

        await client.query("begin");
        await client.query("set local openbooks.migration = on");
        try {
          if (existing.rowCount) {
            // reversal entry: mirror-image lines, linked to the original
            const revRes = await client.query(
              `insert into journal_entries (org_id, book_id, entry_number, posting_date, period_id, memo, status, origin, reverses_entry_id)
               values ($1,$2,$3,$4,$5,$6,'draft','migration',$7) returning id`,
              [org.id, book.id, `${number}-REV`, txn.date, periodId, `sync reversal (source changed)`, existing.rows[0].id],
            );
            await client.query(
              `insert into journal_lines (org_id, entry_id, line_number, account_id, amount, currency, txn_amount, fx_rate, department_id, party_id)
               select org_id, $2, line_number, account_id, -amount, currency, -txn_amount, fx_rate, department_id, party_id
                 from journal_lines where entry_id = $1`,
              [existing.rows[0].id, revRes.rows[0].id],
            );
            await client.query(`update journal_entries set status='posted' where id=$1`, [revRes.rows[0].id]);
            await client.query(`update journal_entries set status='reversed' where id=$1`, [existing.rows[0].id]);
            reversedEntries++;
          }

          const entryRes = await client.query(
            `insert into journal_entries (org_id, book_id, entry_number, posting_date, period_id, memo, status, origin)
             values ($1,$2,$3,$4,$5,$6,'draft','migration') returning id`,
            [org.id, book.id, number, txn.date, periodId, txn.memo],
          );
          const entryId = entryRes.rows[0].id;
          const values: string[] = [];
          const params: any[] = [org.id, entryId];
          txn.lines.forEach((l, i) => {
            const b = params.length;
            params.push(acctByRef.get(l.accountRef), l.amount, l.departmentRef ? deptByRef.get(l.departmentRef) ?? null : null, l.partyRef ? partyByRef.get(l.partyRef) ?? null : null);
            values.push(`($1,$2,${i + 1},$${b + 1},$${b + 2},'CAD',$${b + 2},1,$${b + 3},$${b + 4})`);
          });
          await client.query(
            `insert into journal_lines (org_id, entry_id, line_number, account_id, amount, currency, txn_amount, fx_rate, department_id, party_id)
             values ${values.join(",")}`,
            params,
          );
          await client.query(`update journal_entries set status='posted' where id=$1`, [entryId]);
          await client.query("commit");
          newEntries++;
        } catch (e) {
          await client.query("rollback");
          skipped.push(`${txn.sourceRef}: ${(e as Error).message}`);
        }
      }
    } finally {
      client.release();
    }

    // -- verify: per-account TB vs the live source -------------------------
    const theirs = await source.trialBalance();
    const ours = (await db.execute(sql`
      select a.custom->>'nsId' as ns, sum(l.amount) as bal
        from journal_lines l join accounts a on a.id = l.account_id
       where a.custom->>'nsId' is not null group by 1`)) as any;
    const oursByRef = new Map<string, bigint>(ours.rows.map((r: any) => [r.ns, toUnits(r.bal)]));
    const mismatches: SyncResult["tb"]["mismatches"] = [];
    let matches = 0;
    for (const t of theirs) {
      const mine = oursByRef.get(t.accountRef) ?? 0n;
      if (mine === toUnits(t.balance)) matches++;
      else mismatches.push({ accountRef: t.accountRef, ours: fromUnits(mine), theirs: t.balance });
    }

    const result: SyncResult = {
      runId: run.id,
      newEntries, reversedEntries, unchanged, skipped,
      tb: { accounts: theirs.length, matches, mismatches: mismatches.slice(0, 50) },
      syncedThrough: changes.syncedThrough.toISOString(),
      durationMs: Date.now() - started,
    };

    await db.update(schema.syncRuns).set({
      status: "ok",
      finishedAt: new Date(),
      syncedThrough: changes.syncedThrough,
      stats: result as unknown as Record<string, unknown>,
    }).where(eq(schema.syncRuns.id, run.id));

    return result;
  } catch (e) {
    await db.update(schema.syncRuns).set({
      status: "failed",
      finishedAt: new Date(),
      errorMessage: (e as Error).message,
    }).where(eq(schema.syncRuns.id, run.id));
    throw e;
  }
}
