import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext } from "./db.ts";
import { postPaymentRun } from "./payments.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * F-t03-005: posting a run whose instructions fail (here: an instruction
 * with no payment document, standing in for any per-instruction refusal such
 * as the closed-period lock) returned the reasons in the POST response but
 * persisted only counts. The toast dismissed, the activity feed showed bare
 * tallies, and the clerk could never learn WHY nothing moved. The
 * run_posting_failed event must carry the per-instruction reasons — the same
 * store the activity feed already renders (F-t04-007 contract).
 */
test(
  "a partially failed posting persists its per-instruction reasons on the run event",
  { skip: !DB },
  async () => {
    const org = await withBypassContext(() => createScratchOrg());
    try {
      const actorId = await withBypassContext(() =>
        createScratchUser(org.orgId, "Run clerk", "admin"),
      );
      const runId = randomUUID();
      const instructionId = randomUUID();
      await withBypassContext(() =>
        db.execute(sql`
          insert into payment_runs
            (id, org_id, run_number, bank_account_id, method, status,
             payment_count, total_amount, created_by, updated_by)
          values
            (${runId}, ${org.orgId}, ${`REASONS-RUN-${runId}`}, ${org.accounts.bank},
             'wire', 'generated', 1, '25', ${actorId}, ${actorId})`),
      );
      await withBypassContext(() =>
        db.execute(sql`
          insert into payment_instructions
            (id, org_id, payment_run_id, payee_party_id, amount, currency,
             payment_document_id, status, created_by, updated_by)
          values
            (${instructionId}, ${org.orgId}, ${runId}, ${org.vendorId},
             '25', 'CAD', null, 'pending', ${actorId}, ${actorId})`),
      );
      const outcome = await withBypassContext(() =>
        postPaymentRun(runId, org.orgId, actorId),
      );
      assert.deepEqual(outcome, {
        posted: 0,
        failures: [{ payee: "Acme Vendor", error: "instruction has no payment document" }],
      });
      const event = await withBypassContext(() =>
        db.execute<{ eventType: string; details: unknown }>(sql`
          select event_type as "eventType", details
            from payment_events
           where payment_run_id = ${runId} and org_id = ${org.orgId}
             and event_type = 'run_posting_failed'
           order by created_at desc limit 1
        `),
      );
      assert.equal(event.rows.length, 1, "a run_posting_failed event must exist");
      const details = event.rows[0]!.details as Record<string, unknown>;
      assert.deepEqual(details.failures, [
        { payee: "Acme Vendor", error: "instruction has no payment document" },
      ]);
      const run = await withBypassContext(() =>
        db.execute<{ status: string }>(sql`
          select status from payment_runs where id = ${runId} and org_id = ${org.orgId}
        `),
      );
      assert.equal(run.rows[0]!.status, "partially_failed");
    } finally {
      await withBypassContext(() => dropScratchOrg(org.orgId));
    }
  },
);
