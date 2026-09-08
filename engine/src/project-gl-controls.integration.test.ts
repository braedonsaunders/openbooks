import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  postProjectGlEntry,
  reverseProjectGlEntry,
} from "./project-recognition.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
} from "./test-fixtures.ts";

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
  "project GL posting and reversal require an open period, actor, reason, and exact permanent mirror",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      await db.execute(sql`
        insert into period_locks
          (org_id, period_id, book_id, subsidiary_id, module, state, reason)
        values
          (${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId},
           'gl', 'closed', 'Project GL control test')
      `);
      const post = () =>
        postProjectGlEntry({
          orgId: org.orgId,
          actorId,
          origin: "manual",
          entryNumber: "PROJECT-CONTROL-001",
          postingDate: org.date,
          memo: "Project control test",
          subsidiaryId: org.subsidiaryId,
          currency: "CAD",
          lines: [
            {
              accountId: org.accounts.adjustment,
              amount: "10",
            },
            {
              accountId: org.accounts.clearing,
              amount: "-10",
            },
          ],
        });
      await assert.rejects(post(), (error) =>
        errorChainMatches(error, /GL period .* is closed/),
      );

      await db.execute(sql`
        update period_locks
           set state = 'open', reopen_expires_at = now() + interval '1 hour'
         where org_id = ${org.orgId}
           and period_id = ${org.periodId}
           and book_id = ${org.bookId}
           and subsidiary_id = ${org.subsidiaryId}
           and module = 'gl'
      `);
      const sourceId = await post();
      assert.ok(sourceId);

      await assert.rejects(
        reverseProjectGlEntry(
          org.orgId,
          actorId,
          sourceId,
          "bad",
          org.date,
        ),
        /reversal reason/,
      );
      await db.execute(sql`
        update period_locks
           set state = 'closed', reopen_expires_at = null
         where org_id = ${org.orgId}
           and period_id = ${org.periodId}
           and book_id = ${org.bookId}
           and subsidiary_id = ${org.subsidiaryId}
           and module = 'gl'
      `);
      await assert.rejects(
        reverseProjectGlEntry(
          org.orgId,
          actorId,
          sourceId,
          "Controller approved project correction",
          org.date,
        ),
        (error) => errorChainMatches(error, /GL period .* is closed/),
      );

      await db.execute(sql`
        update period_locks
           set state = 'open', reopen_expires_at = now() + interval '1 hour'
         where org_id = ${org.orgId}
           and period_id = ${org.periodId}
           and book_id = ${org.bookId}
           and subsidiary_id = ${org.subsidiaryId}
           and module = 'gl'
      `);
      const reversalId = await reverseProjectGlEntry(
        org.orgId,
        actorId,
        sourceId,
        "Controller approved project correction",
        org.date,
      );
      assert.ok(reversalId);
      const lineage = (await db.execute<{
          source_status: string;
          reversal_status: string;
          reverses_entry_id: string;
          audit_events: number;
          exact_lines: number;
          source_lines: number;
        }>(sql`
        select source.status as source_status,
               reversal.status as reversal_status,
               reversal.reverses_entry_id,
               (
                 select count(*)::int
                   from audit_log
                  where org_id = ${org.orgId}
                    and table_name = 'journal_entries'
                    and row_id in (${sourceId}, ${reversalId})
                    and request_id in ('project_gl_post', 'project_gl_reversal')
               ) as audit_events,
               (
                 select count(*)::int
                   from journal_lines source_line
                   join journal_lines reversal_line
                     on reversal_line.entry_id = ${reversalId}
                    and reversal_line.line_number = source_line.line_number
                    and reversal_line.account_id = source_line.account_id
                    and reversal_line.amount = -source_line.amount
                    and reversal_line.txn_amount = -source_line.txn_amount
                  where source_line.entry_id = ${sourceId}
               ) as exact_lines,
               (
                 select count(*)::int
                   from journal_lines
                  where entry_id = ${sourceId}
               ) as source_lines
          from journal_entries source
          join journal_entries reversal on reversal.id = ${reversalId}
         where source.id = ${sourceId}
      `));
      assert.deepEqual(lineage.rows[0], {
        source_status: "reversed",
        reversal_status: "posted",
        reverses_entry_id: sourceId,
        audit_events: 2,
        exact_lines: 2,
        source_lines: 2,
      });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

for (const mode of ["secondary posting", "secondary forecast", "primary forecast"] as const) {
  test(`project GL refuses implicit ${mode} book selection`, { skip: !DB }, async () => {
    const org = await createScratchOrg();
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    try {
      const alternate = randomUUID();
      await db.execute(sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl)
        values(${alternate},${org.orgId},'AAA-ALTERNATE','Alternate book',false,true,${mode !== "secondary forecast"})`);
      await db.execute(sql`update accounting_books set is_active=${mode === "primary forecast"},posts_gl=${mode !== "primary forecast"}
        where org_id=${org.orgId} and id=${org.bookId}`);
      const post = () => postProjectGlEntry({
        orgId: org.orgId, actorId, origin: "manual", entryNumber: "PROJECT-BOOK-POLICY",
        postingDate: org.date, memo: "Project book policy", subsidiaryId: org.subsidiaryId,
        currency: "CAD", lines: [
          { accountId: org.accounts.adjustment, amount: "10" },
          { accountId: org.accounts.clearing, amount: "-10" },
        ],
      });
      await assert.rejects(post, /no active primary GL book/);
      const count = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from journal_entries where org_id=${org.orgId}`)).rows[0]!.n;
      assert.equal(count, 0);
      await db.execute(sql`update accounting_books set is_active=true,posts_gl=true where org_id=${org.orgId} and id=${org.bookId}`);
      const id = await post();
      const entry = (await db.execute<{ book_id: string }>(sql`
        select book_id from journal_entries where org_id=${org.orgId} and id=${id}`)).rows[0]!;
      assert.equal(entry.book_id, org.bookId, "the explicit primary wins over the earlier-sorting alternate");
    } finally { await dropScratchOrg(org.orgId); }
  });
}
