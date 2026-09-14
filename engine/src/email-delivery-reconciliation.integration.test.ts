import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { reconcileDeliveryAttempts } from "@openbooks/emails";
import {
  appendEmailAttemptEvent,
  claimEmailDeliveryLog,
  confirmEmailSentGuarded,
  markEmailFailed,
  markEmailUncertain,
} from "./email-config.ts";
import { db } from "./db.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Storage-side proof for audit finding #52: one logical delivery maps to ONE
 * canonical email_log row whose attempt lineage decides what a retried
 * attempt may do. The exact duplicate-email scenario — provider accepted,
 * client timed out before confirmation, BullMQ retries — must park the row in
 * `uncertain` and every later attempt must reconcile to suppression, with
 * status guards making an overwrite of that evidence impossible.
 */
test("email delivery attempts share one canonical row and uncertain outcomes block re-sends", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const to = "controller@scratch.test";
    const deliveryKey = `obem_${"a".repeat(40)}`;

    // Attempt 1 claims the canonical row.
    const firstClaim = await claimEmailDeliveryLog({
      orgId: org.orgId,
      deliveryKey,
      jobId: "email-fanout|attempt-proof",
      provider: "resend",
      recipients: [to],
      subject: "Reconciliation proof",
      categoryKey: "report",
      meta: { reason: "integration test" },
    });
    assert.notEqual(firstClaim.id, "");
    assert.equal(firstClaim.status, "queued");

    // A concurrent/lost-then-resumed attempt lands on the SAME row.
    const secondClaim = await claimEmailDeliveryLog({
      orgId: org.orgId,
      deliveryKey,
      jobId: "email-fanout|attempt-proof",
      provider: "resend",
      recipients: [to],
      subject: "Reconciliation proof",
    });
    assert.equal(secondClaim.id, firstClaim.id);

    // Attempt 1 times out after the request was transmitted. The worker parks
    // the outcome as uncertain and records lineage evidence.
    const uncertainty = "Resend: TimeoutError: request timed out before confirmation — acceptance state unresolved";
    await appendEmailAttemptEvent(org.orgId, firstClaim.id, { attempt: 1, outcome: "uncertain", detail: uncertainty });
    await markEmailUncertain(org.orgId, firstClaim.id, uncertainty);

    const parked = (await db.execute<{ status: string; error_message: string | null }>(sql`
      select status, error_message from email_log where id = ${firstClaim.id} and org_id = ${org.orgId}
    `)).rows[0];
    assert.equal(parked?.status, "uncertain");
    assert.match(parked?.error_message ?? "", /timed out/u);

    // Attempt 2 (the BullMQ retry) reconciles BEFORE transmitting.
    const retryClaim = await claimEmailDeliveryLog({
      orgId: org.orgId,
      deliveryKey,
      jobId: "email-fanout|attempt-proof",
      provider: "resend",
      recipients: [to],
      subject: "Reconciliation proof",
    });
    assert.equal(retryClaim.id, firstClaim.id);
    const decision = reconcileDeliveryAttempts(retryClaim.attempts);
    assert.equal(decision.action, "suppress", "an unresolved predecessor must never authorize a re-send");
    if (decision.action === "suppress") {
      await appendEmailAttemptEvent(org.orgId, retryClaim.id, { outcome: "blocked", detail: decision.reason });
    }

    // Even a "failure" stamp from a crashed reconciled attempt cannot rewrite
    // the uncertainty.
    await markEmailFailed(org.orgId, firstClaim.id, "Definitely not a replacement verdict");
    const stillUncertain = (await db.execute<{ status: string }>(sql`
      select status from email_log where id = ${firstClaim.id} and org_id = ${org.orgId}
    `)).rows[0];
    assert.equal(stillUncertain?.status, "uncertain");

    // Later reconciliation proves acceptance (e.g. provider idempotency replay):
    // the canonical row completes WITHOUT any further transmission.
    const completed = await confirmEmailSentGuarded(org.orgId, firstClaim.id, "email_re_accepted_once");
    assert.ok(completed);
    const finalRow = (await db.execute<{ status: string; provider_message_id: string | null; sent_at: Date | null }>(sql`
      select status, provider_message_id, sent_at from email_log where id = ${firstClaim.id} and org_id = ${org.orgId}
    `)).rows[0];
    assert.equal(finalRow?.status, "sent");
    assert.equal(finalRow?.provider_message_id, "email_re_accepted_once");
    assert.ok(finalRow?.sent_at);

    // Idempotent: completing again changes nothing and still returns success.
    const again = await confirmEmailSentGuarded(org.orgId, firstClaim.id, "email_re_accepted_once");
    assert.ok(again);

    // Suppressed rows stay untouched by late completion writes.
    const suppressedClaim = await claimEmailDeliveryLog({
      orgId: org.orgId,
      deliveryKey: `obem_${"b".repeat(40)}`,
      jobId: "email-fanout|attempt-proof-suppressed",
      recipients: [to],
      subject: "Suppressed proof",
      status: "suppressed",
      errorMessage: "sandbox environment — email egress blocked",
    });
    await confirmEmailSentGuarded(org.orgId, suppressedClaim.id, "email_never_sent");
    const suppressedRow = (await db.execute<{ status: string; provider_message_id: string | null }>(sql`
      select status, provider_message_id from email_log where id = ${suppressedClaim.id} and org_id = ${org.orgId}
    `)).rows[0];
    assert.equal(suppressedRow?.status, "suppressed");
    assert.equal(suppressedRow?.provider_message_id, null);

    // The whole story is auditable from meta.attempts alone.
    const lineage = (await db.execute<{ attempts: Array<Record<string, unknown>> }>(sql`
      select meta -> 'attempts' as attempts from email_log where id = ${firstClaim.id} and org_id = ${org.orgId}
    `)).rows[0]?.attempts ?? [];
    const outcomes = lineage.map((entry) => String(entry.outcome));
    assert.deepEqual(outcomes, ["uncertain", "blocked"]);
    assert.ok(outcomes.includes("uncertain"), "lineage retains the unresolved attempt");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * Persistence proof for the crash-gap fix: the full durable path
 * appendEmailAttemptEvent -> claimEmailDeliveryLog -> reconcileDeliveryAttempts.
 * A worker lost between its pre-transmission "started" mark and its verdict
 * must suppress the BullMQ retry (the provider may already have accepted);
 * a start closed by a definitive failure must still allow it. Pure helper
 * tests pin the normalization contract; this test proves the row that a real
 * retry re-claims carries the evidence that drives that decision. No provider
 * is touched — only email_log rows in the scratch org.
 */
test("a dangling start persisted on the canonical row suppresses the retry; a closed failure allows it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const to = "controller@scratch.test";
    async function claimRow(suffix: string) {
      return claimEmailDeliveryLog({
        orgId: org.orgId,
        deliveryKey: `obem_${suffix}`,
        jobId: `email-fanout|crash-gap-${suffix}`,
        provider: "resend",
        recipients: [to],
        subject: "Crash-gap proof",
      });
    }

    // Crash gap: attempt 1 persisted its pre-transmission mark, then died.
    const dangling = await claimRow("c".repeat(38) + "01");
    await appendEmailAttemptEvent(org.orgId, dangling.id, {
      attempt: 1,
      outcome: "started",
      detail: "sending via resend",
    });
    const retryClaim = await claimRow("c".repeat(38) + "01");
    assert.equal(retryClaim.id, dangling.id, "the retry must land on the same canonical row");
    const parked = reconcileDeliveryAttempts(retryClaim.attempts);
    assert.equal(parked.action, "suppress", "a start with no verdict may already be delivered — never re-send blind");

    // Closed failure: attempt 1 started, then definitively never transmitted.
    const closed = await claimRow("c".repeat(38) + "02");
    await appendEmailAttemptEvent(org.orgId, closed.id, { attempt: 1, outcome: "started" });
    await appendEmailAttemptEvent(org.orgId, closed.id, {
      attempt: 1,
      outcome: "notSent",
      detail: "connection refused before transmission",
    });
    const closedClaim = await claimRow("c".repeat(38) + "02");
    assert.deepEqual(
      reconcileDeliveryAttempts(closedClaim.attempts),
      { action: "send" },
      "a definitively failed attempt must not strand the delivery",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
