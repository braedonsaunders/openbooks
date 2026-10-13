import type { StatementBatchJobData } from "@openbooks/jobs";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import {
  createStatementBatchRun,
  listStatementBatchItems,
} from "./statement-batches.ts";

/**
 * Run creation writes one item per customer and enqueues exactly one job
 * per emailable customer — no-email exclusions are recorded as skipped,
 * never enqueued — and a doubled customer in one run refuses instead of
 * sending twice.
 */
test("run creation enqueues one job per emailable customer and refuses doubled customers", async () => {
  const org = await createScratchOrg();
  try {
    const senderId = await createScratchUser(org.orgId, "Batch Creator", "accountant");
    const secondId = randomUUID();
    const silentId = randomUUID();
    await withOrg(org.orgId, async () => {
      await db.execute(
        sql`insert into parties (id, org_id, kind, display_name) values (${secondId}, ${org.orgId}, 'customer', 'Second')`,
      );
      await db.execute(
        sql`insert into parties (id, org_id, kind, display_name) values (${silentId}, ${org.orgId}, 'customer', 'Silent')`,
      );
    });
    const enqueued: StatementBatchJobData[] = [];
    const created = await withOrg(org.orgId, () =>
      createStatementBatchRun({
        orgId: org.orgId,
        senderId,
        periodFrom: null,
        periodTo: org.date,
        filters: { overdueOnly: true },
        recipients: [
          { partyId: org.customerId, balance: "100.0000", overdue: "100.0000", currency: "CAD", toEmail: "a@acme.test" },
          { partyId: secondId, balance: "50.0000", overdue: "50.0000", currency: null, toEmail: "b@acme.test" },
        ],
        excluded: [{ partyId: silentId, balance: "10.0000", overdue: "0.0000" }],
        allowedSubsidiaryIds: null,
        enqueue: async (jobs) => {
          enqueued.push(...jobs);
        },
      }),
    );
    assert.equal(created.queued, 2);
    assert.equal(created.skipped, 1);
    assert.deepEqual(
      enqueued.map((job) => job.partyId).sort(),
      [org.customerId, secondId].sort(),
    );
    assert.ok(enqueued.every((job) => job.runId === created.runId && job.senderId === senderId));
    const items = await withOrg(org.orgId, () => listStatementBatchItems(org.orgId, created.runId));
    assert.deepEqual(
      items.map((item) => item.status).sort(),
      ["queued", "queued", "skipped"],
    );

    await assert.rejects(
      withOrg(org.orgId, () =>
        createStatementBatchRun({
          orgId: org.orgId,
          senderId,
          periodFrom: null,
          periodTo: org.date,
          filters: {},
          recipients: [
            { partyId: org.customerId, balance: "1.0000", overdue: "0.0000", currency: null, toEmail: "a@acme.test" },
            { partyId: org.customerId, balance: "1.0000", overdue: "0.0000", currency: null, toEmail: "a@acme.test" },
          ],
          excluded: [],
          allowedSubsidiaryIds: null,
          enqueue: async () => {},
        }),
      ),
      /was not recorded/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
