import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "../test-fixtures.ts";
import type {
  MigrationSource,
  SourceAccountMonthRow,
} from "./source.ts";
import { trueUpResidualGl } from "./trueup.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function errorChainMatches(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (pattern.test(current.message)) return true;
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
}

test(
  "GL true-up is exact, append-only, attributable, concurrency-idempotent, and fail-closed",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await db.execute(sql`
        update accounts
           set custom = jsonb_set(custom, '{parityRef}', '"A"'::jsonb)
         where org_id = ${org.orgId} and id = ${org.accounts.adjustment}
      `);
      await db.execute(sql`
        update accounts
           set custom = jsonb_set(custom, '{parityRef}', '"B"'::jsonb)
         where org_id = ${org.orgId} and id = ${org.accounts.clearing}
      `);

      // Native OpenBooks activity may coexist on source-mapped accounts. It
      // is not connector drift and must never be reversed by a source true-up.
      const nativeEntryId = randomUUID();
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
           period_id, status, origin, created_by, updated_by)
        values (
          ${nativeEntryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
          'NATIVE-COEXISTENCE', ${org.date}, ${org.periodId}, 'draft', 'manual',
          ${actorId}, ${actorId}
        )
      `);
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id,
           amount, currency, txn_amount, fx_rate, is_open_item)
        values
          (${org.orgId}, ${nativeEntryId}, 1, ${org.accounts.adjustment},
           ${org.subsidiaryId}, 25, 'CAD', 25, 1, false),
          (${org.orgId}, ${nativeEntryId}, 2, ${org.accounts.clearing},
           ${org.subsidiaryId}, -25, 'CAD', -25, 1, false)
      `);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now(), posted_by = ${actorId}
         where id = ${nativeEntryId}
      `);

      let sourceRows: SourceAccountMonthRow[] = [
        { accountRef: "A", month: "2026-07", amount: "100.0000" },
        { accountRef: "B", month: "2026-07", amount: "-100.0000" },
      ];
      const source = {
        name: "parity-source",
        refKey: "parityRef",
        baseCurrency: "CAD",
        monthlyActivity: async () => sourceRows,
      } as unknown as MigrationSource;
      const control = { actorId, syncRunId: "trueup-test-run" };

      const first = await trueUpResidualGl(org.orgId, source, control);
      assert.deepEqual(
        { entries: first.entries, lines: first.lines },
        { entries: 1, lines: 2 },
      );
      assert.deepEqual(
        first.byAccount.map((row) => row.amount).sort(),
        ["-100.0000", "100.0000"],
      );
      const retry = await trueUpResidualGl(org.orgId, source, control);
      assert.deepEqual(retry, { entries: 0, lines: 0, byAccount: [] });

      sourceRows = [
        { accountRef: "A", month: "2026-07", amount: "130.0000" },
        { accountRef: "B", month: "2026-07", amount: "-130.0000" },
      ];
      const changed = await trueUpResidualGl(org.orgId, source, control);
      assert.deepEqual(
        changed.byAccount.map((row) => row.amount).sort(),
        ["-30.0000", "30.0000"],
      );

      sourceRows = [
        { accountRef: "A", month: "2026-07", amount: "150.0000" },
        { accountRef: "B", month: "2026-07", amount: "-150.0000" },
      ];
      const concurrent = await Promise.all([
        trueUpResidualGl(org.orgId, source, control),
        trueUpResidualGl(org.orgId, source, control),
      ]);
      assert.equal(
        concurrent.reduce((total, result) => total + result.entries, 0),
        1,
      );

      const evidence = (await db.execute<{
          entries: number;
          lines: number;
          net: string;
          audits: number;
          attribution_complete: boolean;
        }>(sql`
        select count(distinct entry.id)::int as entries,
               count(line.id)::int as lines,
               coalesce(sum(line.amount), 0)::text as net,
               count(distinct audit.id)::int as audits,
               bool_and(
                 entry.status = 'posted'
                 and entry.origin = 'migration'
                 and entry.custom->'sourceProjection'->>'kind' = 'connector_trueup'
                 and entry.custom->'sourceProjection'->>'sourceName' = 'parity-source'
                 and entry.custom->'sourceProjection'->>'refKey' = 'parityRef'
                 and entry.created_by = ${actorId}
                 and entry.posted_by = ${actorId}
                 and audit.actor_id = ${actorId}
                 and audit.request_id = 'trueup-test-run'
               ) as attribution_complete
          from journal_entries entry
          join journal_lines line on line.entry_id = entry.id
          left join audit_log audit
            on audit.org_id = entry.org_id
           and audit.table_name = 'journal_entries'
           and audit.row_id = entry.id
           and audit.changes->>'mode' = 'migration_gl_trueup'
         where entry.org_id = ${org.orgId}
           and entry.entry_number like 'TRUEUP-2026-07-%'
      `));
      assert.deepEqual(evidence.rows[0], {
        entries: 3,
        lines: 6,
        net: "0.0000",
        audits: 3,
        attribution_complete: true,
      });

      // Every generation in the same month carries a distinct number under
      // journal_entries_org_number while keeping the TRUEUP-{month}- shape.
      const trueupNumbers = (await db.execute<{ n: number; distinct: number }>(sql`
        select count(*)::int as n, count(distinct entry_number)::int as distinct
          from journal_entries
         where org_id = ${org.orgId}
           and entry_number like 'TRUEUP-2026-07-%'
      `));
      assert.deepEqual(trueupNumbers.rows[0], { n: 3, distinct: 3 });

      sourceRows = [
        { accountRef: "A", month: "2026-07", amount: "151.0000" },
        { accountRef: "MISSING", month: "2026-07", amount: "-151.0000" },
      ];
      await assert.rejects(
        trueUpResidualGl(org.orgId, source, control),
        /cannot silently omit.*MISSING/,
      );

      sourceRows = [
        { accountRef: "A", month: "2026-07", amount: "151.0000" },
        { accountRef: "B", month: "2026-07", amount: "-150.0000" },
      ];
      await assert.rejects(
        trueUpResidualGl(org.orgId, source, control),
        /unbalanced by 1.0000.*refused/,
      );

      await db.execute(sql`
        insert into period_locks
          (org_id, period_id, book_id, subsidiary_id, module, state, reason,
           created_by, updated_by)
        values
          (${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId},
           'gl', 'closed', 'True-up close control test', ${actorId}, ${actorId})
      `);
      sourceRows = [
        { accountRef: "A", month: "2026-07", amount: "160.0000" },
        { accountRef: "B", month: "2026-07", amount: "-160.0000" },
      ];
      await assert.rejects(
        trueUpResidualGl(org.orgId, source, control),
        (error) => errorChainMatches(error, /GL is closed/),
      );
      const afterFailures = (await db.execute<{ entries: number }>(sql`
        select count(*)::int as entries
          from journal_entries
         where org_id = ${org.orgId}
           and entry_number like 'TRUEUP-2026-07-%'
      `));
      assert.equal(afterFailures.rows[0]?.entries, 3);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
