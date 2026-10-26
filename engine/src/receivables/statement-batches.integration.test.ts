import type { StatementBatchJobData } from "@openbooks/jobs";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import {
  createStatementBatchRun,
  getStatementBatchRun,
  listStatementBatchRuns,
  listStatementBatchItems,
  retryStatementBatchRun,
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
          {
            partyId: org.customerId,
            balance: "100.0000",
            overdue: "100.0000",
            currency: "CAD",
            toEmail: "a@acme.test",
          },
          {
            partyId: secondId,
            balance: "50.0000",
            overdue: "50.0000",
            currency: null,
            toEmail: "b@acme.test",
          },
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
    assert.deepEqual(enqueued.map((job) => job.partyId).sort(), [org.customerId, secondId].sort());
    assert.ok(enqueued.every((job) => job.runId === created.runId && job.senderId === senderId));
    const items = await withOrg(org.orgId, () => listStatementBatchItems(org.orgId, created.runId));
    assert.deepEqual(items.map((item) => item.status).sort(), ["queued", "queued", "skipped"]);

    await assert.rejects(
      withOrg(org.orgId, () =>
        createStatementBatchRun({
          orgId: org.orgId,
          senderId,
          periodFrom: null,
          periodTo: org.date,
          filters: {},
          recipients: [
            {
              partyId: org.customerId,
              balance: "1.0000",
              overdue: "0.0000",
              currency: null,
              toEmail: "a@acme.test",
            },
            {
              partyId: org.customerId,
              balance: "1.0000",
              overdue: "0.0000",
              currency: null,
              toEmail: "a@acme.test",
            },
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

test("statement batch reads and retries require coverage of the recorded scope", async () => {
  const org = await createScratchOrg();
  try {
    const senderId = await createScratchUser(org.orgId, "Scoped Batch Reader", "accountant");
    const scope = new Set([org.subsidiaryId]);
    const enqueued: StatementBatchJobData[] = [];
    const created = await withOrg(org.orgId, () =>
      createStatementBatchRun({
        orgId: org.orgId,
        senderId,
        periodFrom: null,
        periodTo: org.date,
        filters: {},
        recipients: [
          {
            partyId: org.customerId,
            balance: "25.0000",
            overdue: "0.0000",
            currency: "CAD",
            toEmail: "a@acme.test",
          },
        ],
        excluded: [],
        allowedSubsidiaryIds: [org.subsidiaryId],
        enqueue: async (jobs) => enqueued.push(...jobs),
      }),
    );

    assert.equal(
      (await withOrg(org.orgId, () => getStatementBatchRun(org.orgId, created.runId, scope)))?.id,
      created.runId,
    );
    assert.equal(
      await withOrg(org.orgId, () => getStatementBatchRun(org.orgId, created.runId, new Set())),
      null,
    );
    assert.deepEqual(
      await withOrg(org.orgId, () =>
        listStatementBatchRuns(org.orgId, { allowedSubsidiaryIds: new Set() }),
      ),
      [],
    );
    assert.deepEqual(
      await withOrg(org.orgId, () => listStatementBatchItems(org.orgId, created.runId, new Set())),
      [],
    );

    await assert.rejects(
      withOrg(org.orgId, () =>
        retryStatementBatchRun(
          org.orgId,
          created.runId,
          senderId,
          async (jobs) => enqueued.push(...jobs),
          new Set(),
        ),
      ),
      /was not found/,
    );
    assert.equal(enqueued.length, 1, "an unauthorized retry does not enqueue another delivery");
    const retried = await withOrg(org.orgId, () =>
      retryStatementBatchRun(
        org.orgId,
        created.runId,
        senderId,
        async (jobs) => enqueued.push(...jobs),
        scope,
      ),
    );
    assert.equal(retried.requeued, 1);
    assert.equal(enqueued.length, 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
