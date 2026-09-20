import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { closeApprovedRun, startCloseRun } from "./close.ts";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

test(
  "an org-wide close dominates an existing child subsidiary lock",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const childId = randomUUID();
      await db.execute(sql`
        insert into subsidiaries
          (id, org_id, parent_id, name, base_currency, country,
           tax_ids, is_elimination, is_active, custom)
        values
          (${childId}, ${org.orgId}, ${org.subsidiaryId}, 'Close Child', 'CAD', 'CA',
           '{}'::jsonb, false, true, '{}'::jsonb)
      `);

      const runId = await startCloseRun({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId: actors.adminId,
      });
      await db.execute(sql`
        update close_runs
           set status = 'approved', current_stage = 'lock', approved_at = now(),
               approved_by = ${actors.adminId}, updated_at = now(), updated_by = ${actors.adminId}
         where id = ${runId} and org_id = ${org.orgId}
      `);
      await db.execute(sql`
        insert into period_locks
          (org_id, period_id, book_id, subsidiary_id, module, state, created_by, updated_by)
        values
          (${org.orgId}, ${org.periodId}, ${org.bookId}, ${childId}, 'gl', 'open',
           ${actors.adminId}, ${actors.adminId})
      `);

      await closeApprovedRun(org.orgId, runId, actors.approver1Id);

      const blocked = (await db.execute<{ blocked: boolean }>(sql`
        select period_module_blocks_write(
          ${org.orgId}::uuid, ${org.periodId}::uuid, ${org.bookId}::uuid,
          ${childId}::uuid, 'gl', false) as blocked
      `)).rows[0]!.blocked;
      assert.equal(blocked, true);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
