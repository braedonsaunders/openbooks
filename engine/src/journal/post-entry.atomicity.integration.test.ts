import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext, type SqlExecutor } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { postEntry, type PostEntryResult } from "./post-entry.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "a posting on a pool executor is never visible without its lines",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const key = `atomic-${randomUUID()}`;
    const readEntry = (runner: SqlExecutor) => runner.execute<{ status: string; lines: number }>(sql`
      select je.status, count(jl.id)::int as lines
        from journal_entries je
        left join journal_lines jl on jl.org_id = je.org_id and jl.entry_id = je.id
       where je.org_id = ${org.orgId} and je.custom->>'idempotencyKey' = ${key}
       group by je.id, je.status`);
    let writer: Promise<PostEntryResult> | undefined;
    try {
      // A second connection holds the party row the first line references.
      // The header insert never touches parties, but the line insert's party
      // foreign-key check must wait for this lock, so the writer is parked
      // after its header insert and before its lines exist: the window in
      // which this connection reads.
      await withBypassContext(() => db.transaction(async (reader) => {
        await reader.execute(sql`select id from parties where id = ${org.customerId} for update`);
        const { pid } = (await reader.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!;
        writer = withOrgContext(org.orgId, () => postEntry(db, {
          orgId: org.orgId,
          bookId: org.bookId,
          subsidiaryId: org.subsidiaryId,
          entryNumber: `ATOMIC-${randomUUID().slice(0, 8)}`,
          postingDate: org.date,
          periodId: org.periodId,
          origin: "manual",
          currency: "CAD",
          closeModules: ["gl"],
          idempotencyKey: key,
          lines: [
            { accountId: org.accounts.bank, amount: "-10", partyId: org.customerId },
            { accountId: org.accounts.cogs, amount: "10" },
          ],
        }));
        // pg_locks, not pg_stat_activity: the activity view is snapshotted
        // once per transaction, so this loop would re-read a stale list.
        for (let waited = 0; ; waited += 20) {
          const blocked = (await reader.execute<{ n: number }>(sql`
            select count(*)::int as n from pg_locks
             where not granted and ${pid}::int = any(pg_blocking_pids(pid))`)).rows[0]!.n;
          if (blocked > 0) break;
          assert.ok(waited < 15_000, "the posting never waited on the held party row");
          // Racing the writer surfaces its own refusal instead of a timeout.
          await Promise.race([writer, new Promise((resolve) => setTimeout(resolve, 20))]);
        }
        assert.deepEqual(
          (await readEntry(reader)).rows,
          [],
          "a concurrent reader saw the entry header before its lines were committed",
        );
      }));
      assert.equal((await writer!).lines.length, 2);
      assert.deepEqual((await withOrgContext(org.orgId, () => readEntry(db))).rows, [{ status: "posted", lines: 2 }]);
    } finally {
      await writer?.catch(() => undefined);
      await dropScratchOrg(org.orgId);
    }
  },
);
