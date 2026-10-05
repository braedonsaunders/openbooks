import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { closeApprovedRun } from "./run-completion.ts";
import { startCloseRun } from "./run-start.ts";
import { setPeriodLockState } from "../periods/period-locks.ts";
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

test(
  "an org-wide soft close tightens a looser child lock, with audit, and leaves a hard-closed child alone",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const org = await createScratchOrg();
    try {
      const actors = await seedFlowActors(org.orgId);
      const [openChild, closedChild] = [randomUUID(), randomUUID()];
      for (const [id, state] of [[openChild, "open"], [closedChild, "closed"]] as const) {
        await db.execute(sql`
          insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
          values (${id}, ${org.orgId}, ${org.subsidiaryId}, ${`Child ${state}`}, 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
        await db.execute(sql`
          insert into period_locks (org_id, period_id, book_id, subsidiary_id, module, state, created_by, updated_by)
          values (${org.orgId}, ${org.periodId}, ${org.bookId}, ${id}, 'gl', ${state}, ${actors.adminId}, ${actors.adminId})`);
      }
      await setPeriodLockState({
        orgId: org.orgId, periodId: org.periodId, bookId: org.bookId, module: "gl",
        state: "soft_closed", actorId: actors.adminId, reason: "Month-end soft close",
      });
      const children = (await db.execute<{ subsidiary_id: string; state: string; blocked: boolean; audited: boolean }>(sql`
        select l.subsidiary_id, l.state,
               period_module_blocks_write(${org.orgId}::uuid, ${org.periodId}::uuid, ${org.bookId}::uuid, l.subsidiary_id, 'gl', false) as blocked,
               exists (select 1 from audit_log a where a.org_id = l.org_id and a.table_name = 'period_locks'
                        and a.row_id = l.id and a.action = 'update') as audited
          from period_locks l
         where l.org_id = ${org.orgId} and l.period_id = ${org.periodId} and l.subsidiary_id is not null`)).rows;
      const byId = new Map(children.map((row) => [row.subsidiary_id, row]));
      assert.deepEqual(byId.get(openChild), { subsidiary_id: openChild, state: "soft_closed", blocked: true, audited: true });
      assert.deepEqual(byId.get(closedChild), { subsidiary_id: closedChild, state: "closed", blocked: true, audited: false });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
