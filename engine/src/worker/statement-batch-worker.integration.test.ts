import type { StatementBatchJobData } from "@openbooks/jobs";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg, withOrgContext } from "../platform/db.ts";
import { saveOrgEmailConfig } from "../delivery/email-config.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import {
  createStatementBatchRun,
  getStatementBatchRun,
  listStatementBatchItems,
  retryStatementBatchRun,
} from "../receivables/statement-batches.ts";
import { processStatementBatchJob, transmitStatementBatchEmail } from "./statement-batch-worker.ts";

/**
 * One batch job renders one customer's statement and sends it through the
 * native delivery. A sent customer never transmits again (reprocessing
 * collapses onto the recorded send), a failed send keeps its error on the
 * run for Retry, and a missing transport refuses the customer with the
 * setup remedy before any render work.
 */
function jobFor(
  orgId: string,
  runId: string,
  partyId: string,
  senderId: string,
): StatementBatchJobData {
  return { orgId, runId, partyId, senderId };
}

test("a customer with no configured transport is refused before any render", async () => {
  const org = await createScratchOrg();
  const enqueued: StatementBatchJobData[] = [];
  try {
    const senderId = await createScratchUser(org.orgId, "Batch Sender", "reviewer");
    await db.execute(
      sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`,
    );
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
            balance: "100.0000",
            overdue: "100.0000",
            currency: "CAD",
            toEmail: "office@acme.test",
          },
        ],
        excluded: [],
        allowedSubsidiaryIds: null,
        enqueue: async (jobs) => {
          enqueued.push(...jobs);
        },
      }),
    );
    assert.equal(enqueued.length, 1);
    let renders = 0;
    const outcome = await processStatementBatchJob(enqueued[0]!, {
      renderPdf: async () => {
        renders += 1;
        return {
          pdf: Buffer.from("%PDF-1.4"),
          attachmentName: "s.pdf",
          orgName: "Acme",
          reference: "as of x",
        };
      },
      transmit: async () => ({ emailLogId: randomUUID(), alreadySent: false }),
    });
    assert.equal(outcome.outcome, "refused");
    assert.equal(renders, 0);
    const items = await withOrg(org.orgId, () => listStatementBatchItems(org.orgId, created.runId));
    assert.equal(items[0]!.status, "failed");
    assert.match(items[0]!.error ?? "", /Email delivery is not enabled.*Admin → Email/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a sent customer never transmits again", async () => {
  const org = await createScratchOrg();
  const enqueued: StatementBatchJobData[] = [];
  try {
    const senderId = await createScratchUser(org.orgId, "Batch Sender", "reviewer");
    await db.execute(
      sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`,
    );
    await withOrg(org.orgId, () =>
      saveOrgEmailConfig(
        org.orgId,
        {
          enabled: true,
          provider: "smtp",
          fromName: "Acme",
          fromEmail: "statements@acme.test",
          smtpHost: "127.0.0.1",
          smtpPort: 1,
          smtpSecure: false,
        },
        { kind: "user", userId: senderId },
      ),
    );
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
            balance: "100.0000",
            overdue: "0.0000",
            currency: "CAD",
            toEmail: "office@acme.test",
          },
        ],
        excluded: [],
        allowedSubsidiaryIds: null,
        enqueue: async (jobs) => {
          enqueued.push(...jobs);
        },
      }),
    );
    let renders = 0;
    let transmits = 0;
    const sentLogId = randomUUID();
    const deps = {
      renderPdf: async () => {
        renders += 1;
        return {
          pdf: Buffer.from("%PDF-1.4"),
          attachmentName: "s.pdf",
          orgName: "Acme",
          reference: "as of x",
        };
      },
      transmit: async () => {
        transmits += 1;
        return { emailLogId: sentLogId, alreadySent: false };
      },
    };
    const first = await processStatementBatchJob(enqueued[0]!, deps);
    assert.equal(first.outcome, "sent");
    const items = await withOrg(org.orgId, () => listStatementBatchItems(org.orgId, created.runId));
    assert.equal(items[0]!.status, "sent");
    assert.equal(items[0]!.emailLogId, sentLogId);
    assert.match(items[0]!.deliveryKey ?? "", /^obem_[0-9a-f]{40}$/);
    assert.ok(items[0]!.sentAt);
    const run = await withOrg(org.orgId, () => getStatementBatchRun(org.orgId, created.runId));
    assert.equal(run!.status, "done");

    const second = await processStatementBatchJob(
      jobFor(org.orgId, created.runId, org.customerId, senderId),
      deps,
    );
    assert.equal(second.outcome, "already-sent");
    assert.equal(renders, 1);
    assert.equal(transmits, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a failed send keeps its error on the run and Retry delivers it", async () => {
  const org = await createScratchOrg();
  const enqueued: StatementBatchJobData[] = [];
  try {
    const senderId = await createScratchUser(org.orgId, "Batch Sender", "reviewer");
    await db.execute(
      sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`,
    );
    await withOrg(org.orgId, () =>
      saveOrgEmailConfig(
        org.orgId,
        {
          enabled: true,
          provider: "smtp",
          fromName: "Acme",
          fromEmail: "statements@acme.test",
          smtpHost: "127.0.0.1",
          smtpPort: 1,
          smtpSecure: false,
        },
        { kind: "user", userId: senderId },
      ),
    );
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
            balance: "100.0000",
            overdue: "0.0000",
            currency: "CAD",
            toEmail: "office@acme.test",
          },
        ],
        excluded: [],
        allowedSubsidiaryIds: null,
        enqueue: async (jobs) => {
          enqueued.push(...jobs);
        },
      }),
    );
    const render = async () => ({
      pdf: Buffer.from("%PDF-1.4"),
      attachmentName: "s.pdf",
      orgName: "Acme",
      reference: "as of x",
    });
    let attempts = 0;
    await assert.rejects(
      processStatementBatchJob(enqueued[0]!, {
        renderPdf: render,
        transmit: async () => {
          attempts += 1;
          throw new Error("provider unavailable");
        },
      }),
      /provider unavailable/,
    );
    const failed = await withOrg(org.orgId, () =>
      listStatementBatchItems(org.orgId, created.runId),
    );
    assert.equal(failed[0]!.status, "failed");
    assert.match(failed[0]!.error ?? "", /provider unavailable/);

    enqueued.length = 0;
    const retried = await withOrg(org.orgId, () =>
      retryStatementBatchRun(org.orgId, created.runId, senderId, async (jobs) => {
        enqueued.push(...jobs);
      }),
    );
    assert.equal(retried.requeued, 1);
    assert.equal(enqueued.length, 1);
    const outcome = await processStatementBatchJob(enqueued[0]!, {
      renderPdf: render,
      transmit: async () => ({ emailLogId: randomUUID(), alreadySent: false }),
    });
    assert.equal(outcome.outcome, "sent");
    assert.equal(attempts, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a definite provider failure is recorded on the delivery log", async () => {
  const org = await createScratchOrg();
  try {
    const senderId = await createScratchUser(org.orgId, "Batch Sender", "reviewer");
    await db.execute(
      sql`update app_roles set permissions='["*"]'::jsonb where org_id=${org.orgId} and key='reviewer'`,
    );
    const transport = await withOrg(org.orgId, async () => {
      await saveOrgEmailConfig(
        org.orgId,
        {
          enabled: true,
          provider: "smtp",
          fromName: "Acme",
          fromEmail: "statements@acme.test",
          smtpHost: "127.0.0.1",
          smtpPort: 1,
          smtpSecure: false,
        },
        { kind: "user", userId: senderId },
      );
      const { resolveOrgEmailTransport } = await import("../delivery/email-config.ts");
      const resolved = await resolveOrgEmailTransport(org.orgId);
      assert.ok(resolved);
      return resolved;
    });
    // Context-only scope like the worker: each delivery write commits on
    // its own, so the failure evidence survives the rejection.
    await assert.rejects(
      withOrgContext(org.orgId, () =>
        transmitStatementBatchEmail({
          orgId: org.orgId,
          transport,
          to: "office@acme.test",
          subject: "Statement as of x — Acme",
          html: "<p>hi</p>",
          text: "hi",
          attachment: {
            filename: "s.pdf",
            content: Buffer.from("%PDF-1.4").toString("base64"),
            contentType: "application/pdf",
          },
          deliveryKey: "obem_ffffffffffffffffffffffffffffffffffffffff",
          senderId,
          partyId: org.customerId,
          runId: "018f6b2a-7c1d-7d3e-9f4a-2b8c4d5e6f70",
        }),
      ),
    );
    const rows = await withOrgContext(org.orgId, () =>
      db.execute<{ status: string; attempts: unknown }>(
        sql`
      select status, meta -> 'attempts' as attempts from email_log
       where org_id = ${org.orgId} and delivery_key = 'obem_ffffffffffffffffffffffffffffffffffffffff'`,
        "objects",
      ),
    );
    assert.equal(rows[0]!.status, "failed");
    assert.ok(JSON.stringify(rows[0]!.attempts).includes("notSent"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
