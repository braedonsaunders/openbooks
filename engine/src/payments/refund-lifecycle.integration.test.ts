import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  grantScratchPermissions,
  seedApprovalFlow,
} from "../testing/fixtures.ts";
import { decideGate } from "../flows/gates.ts";
import {
  claimPostingEffectsForDocument,
  markPostingEffectsFailed,
  MAX_POSTING_EFFECTS_ATTEMPTS,
  processDuePostingEffects,
  replayTerminalPostingEffect,
  POSTING_EFFECT_TERMINAL_NOTICE_KIND,
} from "../ledger/posting-effects.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { finalizePaymentAcceptanceForDocument } from "../payments-core/acceptance-effect.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
import { openItemsForParty } from "./payment-queries.ts";
import { sameCurrencyAllocation } from "./settlement-policy.ts";
import { reversePaymentForReturn } from "./payment-return.ts";
import { postReturnReceipt, returnFinancialStage } from "./psp-return-stages.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import {
  approveDisputeReview,
  processProviderDisputeEvent,
  processProviderRefundEvent,
} from "./psp-refund-automation.ts";
import { rejectDisputeReview } from "./psp-return-review.ts";
import {
  settleHarness,
  settle,
  invoiceOpen,
  disputeRows,
  seedProviderReviewFlow,
  decideProviderReview,
  type Harness,
} from "./refund-test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function refund(h: Harness, cumulativeMinor: number, id = `refund-${randomUUID()}`) {
  return {
    id,
    type: "charge.refunded",
    data: {
      object: {
        id: `charge-${h.attemptId}`,
        payment_intent: h.intentId,
        amount_refunded: cumulativeMinor,
        amount: 10000,
        currency: "cad",
      },
    },
  };
}

function dispute(h: Harness, ref: string, state: "opened" | "won" | "lost", minor = 10000) {
  return {
    id: `dispute-${randomUUID()}`,
    type: state === "opened" ? "charge.dispute.created" : "charge.dispute.closed",
    data: {
      object: {
        id: ref,
        payment_intent: h.intentId,
        amount: minor,
        currency: "cad",
        ...(state === "opened" ? {} : { status: state }),
      },
    },
  };
}

async function receipts(orgId: string) {
  return await db.execute<{ id: string; status: string; total: string }>(
    sql`
    select id, status, total::text as total from documents where org_id = ${orgId} and kind = 'customer_payment' order by created_at, id`,
    "objects",
  );
}

async function enableReceiptEvents(orgId: string) {
  const enabled =
    await db.execute<never>(sql`update orgs set settings = jsonb_set(settings, '{features}',
    coalesce(settings->'features', '{}'::jsonb) || '{"apiAccess":true,"outboundWebhooks":true}'::jsonb)
    where id = ${orgId}`);
  assert.equal(enabled.rowCount, 1);
}

async function receiptEffect(orgId: string, documentId: string) {
  return (
    await db.execute<{ id: string; status: string; attempt_count: number }>(
      sql`
    select id, status, attempt_count from posting_effects where org_id = ${orgId} and document_id = ${documentId}`,
      "objects",
    )
  )[0]!;
}

async function assertReceiptEffectsCompleted(orgId: string) {
  for (const receipt of (await receipts(orgId)).filter(
    (row) => row.status === "posted" || row.status === "voided",
  )) {
    assert.equal((await receiptEffect(orgId, receipt.id)).status, "succeeded", receipt.id);
    const events = (
      await db.execute<{ count: number }>(
        sql`select count(*)::int as count from webhook_events
      where org_id = ${orgId} and entity_id = ${receipt.id} and event_type = 'payment.received'`,
        "objects",
      )
    )[0]!;
    assert.equal(events.count, 1, "native receipt completion emits once across provider replay");
  }
}

/** A native posted receipt with its outbox intentionally deferred models an
 * interrupted acceptance close before the projection worker runs. */
async function pendingReceipt(org: Awaited<ReturnType<typeof createScratchOrg>>) {
  await enableReceiptEvents(org.orgId);
  const h = await settleHarness(org);
  await grantScratchPermissions(org.orgId, h.userId, ["ar.pay"]);
  const receiptId = await withOrgTransaction(org.orgId, async () => {
    const receipt = await createPaymentDocument({
      orgId: org.orgId,
      kind: "customer_payment",
      createdBy: h.userId,
      allowedSubsidiaryIds: null,
      partyId: org.customerId,
      bankAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId,
      currency: "CAD",
      documentDate: org.date,
    });
    const item = (await openItemsForParty(org.customerId, "ar", org.orgId, null)).find(
      (row) => row.documentId === h.invoiceId,
    )!;
    await updateDraftPayment(
      receipt.id,
      { allocations: [sameCurrencyAllocation(item.lineId, "100")] },
      h.userId,
      org.orgId,
      { allowedSubsidiaryIds: null },
    );
    // Reserve the provider identity as acceptance does before posting. The
    // native finalizer, rather than fixture status writes, closes the attempt.
    const reserved =
      await db.execute<never>(sql`update payment_attempts set payment_document_id = ${receipt.id},
      event_payload = coalesce(event_payload, '{}'::jsonb) || ${JSON.stringify({ paymentIntent: h.intentId })}::jsonb
      where org_id = ${org.orgId} and id = ${h.attemptId} and journal_entry_id is null`);
    assert.equal(reserved.rowCount, 1);
    await submitAndReleaseIfUngated("customer_payment", receipt.id, h.userId);
    await postPaymentWithApplications(receipt.id, undefined, h.userId, "api", {
      deferEffects: true,
    });
    await finalizePaymentAcceptanceForDocument(receipt.id);
    return receipt.id;
  });
  assert.equal((await receiptEffect(org.orgId, receiptId)).status, "pending");
  assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
  return { h, receiptId };
}

async function approveReceipts(orgId: string, actorId: string) {
  const gates = await db.execute<{ id: string }>(
    sql`select id from flow_gates
    where org_id = ${orgId} and subject_kind = 'customer_payment' and status = 'pending' order by created_at, id`,
    "objects",
  );
  for (const gate of gates)
    await decideGate({
      gateId: gate.id,
      decision: "approved",
      userId: actorId,
      allowedSubsidiaryIds: null,
    });
}

async function gateReceipts(orgId: string) {
  const actorId = await createScratchUser(orgId, "Receipt approver", "receipt_approver");
  await grantScratchPermissions(orgId, actorId, ["ar.approve"]);
  await seedApprovalFlow(orgId, {
    subjectKind: "customer_payment",
    assignees: [{ type: "user", userId: actorId }],
    mode: "any",
  });
  return actorId;
}

test(
  "successive, repeated and stale Stripe refund snapshots reconcile the original charge",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await enableReceiptEvents(org.orgId);
      const h = await settleHarness(org);
      await settle(h, 10000);
      assert.equal((await h.fire(refund(h, 3000)))?.status, "refunded_posted");
      assert.equal((await h.fire(refund(h, 5000)))?.status, "refunded_posted");
      assert.equal((await h.fire(refund(h, 5000)))?.status, "refunded_duplicate");
      assert.equal((await h.fire(refund(h, 3000)))?.status, "refunded_duplicate");
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "50.0000");
      assert.deepEqual(
        (await receipts(org.orgId))
          .filter((row) => row.status === "posted")
          .map((row) => row.total),
        ["50.0000"],
      );
      const totals = (
        await db.execute<{ total: string }>(
          sql`select sum(amount)::numeric(19,4)::text as total from payment_disputes
      where org_id = ${org.orgId} and attempt_id = ${h.attemptId} and kind = 'refund' and status = 'posted'`,
          "objects",
        )
      )[0];
      assert.equal(totals?.total, "50.0000");
      assert.equal((await h.fire(refund(h, 10000)))?.status, "refunded_posted");
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "100.0000");
      assert.equal((await receipts(org.orgId)).filter((row) => row.status === "posted").length, 0);
      await assertReceiptEffectsCompleted(org.orgId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "concurrent cumulative snapshots converge regardless of delivery order",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const h = await settleHarness(org);
      await settle(h, 10000);
      // Each delivery owns its own tenant transaction; the attempt is the shared mutex.
      await Promise.all([h.fire(refund(h, 3000)), h.fire(refund(h, 5000))]);
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "50.0000");
      assert.deepEqual(
        (await receipts(org.orgId))
          .filter((row) => row.status === "posted")
          .map((row) => row.total),
        ["50.0000"],
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "Stripe refund object status updates do not account for the same cash twice",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const h = await settleHarness(org);
      await settle(h, 10000);
      await h.fire(refund(h, 3000));
      const result = await h.fire({
        id: `refund-update-${randomUUID()}`,
        type: "charge.refund.updated",
        data: {
          object: {
            id: "refund-object",
            payment_intent: h.intentId,
            amount: 3000,
            currency: "cad",
            status: "succeeded",
          },
        },
      });
      assert.equal(result?.status, "refunded_noted");
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
      assert.equal((await disputeRows(org.orgId)).length, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a Stripe return without its refunded total waits for confirmed redelivery",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const h = await settleHarness(org);
      await settle(h, 10000);
      const confirmed = refund(h, 3000);
      const { amount_refunded: _refunded, ...object } = confirmed.data.object;
      assert.equal(
        (await h.fire({ ...confirmed, data: { object } }))?.status,
        "refunded_pending_review",
      );
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      assert.equal((await h.fire(confirmed))?.status, "refunded_posted");
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
      assert.equal((await disputeRows(org.orgId)).length, 1);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a gated partial refund preserves the original payment and resumes the same approved receipt",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const h = await settleHarness(org);
      await settle(h, 10000);
      const original = (await receipts(org.orgId))[0]!;
      const approver = await gateReceipts(org.orgId);
      const event = refund(h, 3000);
      assert.equal((await h.fire(event))?.status, "refunded_pending_review");
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      const staged = (await receipts(org.orgId)).find((row) => row.status === "pending_approval")!;
      assert.equal(staged.total, "70.0000");
      assert.equal(
        (await receipts(org.orgId)).find((row) => row.id === original.id)?.status,
        "posted",
      );
      await h.fire(event);
      assert.equal(
        (await receipts(org.orgId)).length,
        2,
        "redelivery retains one approval subject",
      );
      await approveReceipts(org.orgId, approver);
      await assert.rejects(postPaymentWithApplications(staged.id), /provider return/);
      const review = (await disputeRows(org.orgId))[0]!;
      assert.equal(
        (await approveDisputeReview(org.orgId, review.id, h.userId, null)).status,
        "posted",
      );
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
      assert.equal(
        (await receipts(org.orgId)).find((row) => row.id === staged.id)?.status,
        "posted",
      );
      assert.equal((await receipts(org.orgId)).length, 2);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a full provider refund waits for its tenant Flow and posts once across concurrent approval and redelivery",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const h = await settleHarness(org, { reviewFlow: true });
      await settle(h, 10000);
      const original = (await receipts(org.orgId))[0]!;
      const event = refund(h, 10000);
      assert.equal((await h.fire(event))?.status, "refunded_pending_review");
      const review = (await disputeRows(org.orgId))[0]!;
      const snapshot = async () =>
        (
          await db.execute<{ fingerprint: string; submissions: number }>(
            sql`
      select public.provider_return_approval_fingerprint(${org.orgId}, ${review.id}) as fingerprint,
        (select count(*)::int from flow_submissions where org_id=${org.orgId}
          and subject_kind='payment_dispute_review' and subject_id=${review.id}) as submissions`,
            "objects",
          )
        )[0]!;
      const before = await snapshot();
      assert.equal(before.submissions, 1);
      assert.equal(
        (await receipts(org.orgId)).find((row) => row.id === original.id)?.status,
        "posted",
      );
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      await h.fire({ ...event, id: `redelivery-${randomUUID()}` });
      assert.deepEqual(await snapshot(), before, "redelivery retains the frozen submission");
      await Promise.all([
        decideProviderReview(org.orgId, review.id, h.userId, "approved"),
        h.fire({ ...event, id: `concurrent-redelivery-${randomUUID()}` }),
      ]);
      assert.equal((await disputeRows(org.orgId))[0]!.status, "posted");
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "100.0000");
      assert.equal((await snapshot()).submissions, 1);
      const reversals = (
        await db.execute<{ count: number }>(
          sql`select count(*)::int as count
      from journal_entries where org_id=${org.orgId} and reverses_entry_id is not null`,
          "objects",
        )
      )[0]!;
      assert.equal(reversals.count, 1);
      assert.equal((await h.fire(event))?.status, "refunded_duplicate");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "completed provider gates remain authoritative while a replacement receipt awaits its own tenant gates",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const h = await settleHarness(org, { reviewFlow: true });
      await settle(h, 10000);
      const receiptApprover = await gateReceipts(org.orgId);
      const event = refund(h, 3000);
      assert.equal((await h.fire(event))?.status, "refunded_pending_review");
      const review = (await disputeRows(org.orgId))[0]!;
      assert.equal(
        (await decideProviderReview(org.orgId, review.id, h.userId, "approved")).status,
        "pending_review",
      );
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      assert.equal(
        (await receipts(org.orgId)).filter((row) => row.status === "pending_approval").length,
        1,
      );
      await h.fire({ ...event, id: `redelivery-${randomUUID()}` });
      await approveReceipts(org.orgId, receiptApprover);
      assert.equal(
        (await approveDisputeReview(org.orgId, review.id, h.userId, null)).status,
        "posted",
      );
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
      const decisions = (
        await db.execute<{ submissions: number; pending: number }>(
          sql`
      select (select count(*)::int from flow_submissions where org_id=${org.orgId}
        and subject_kind='payment_dispute_review' and subject_id=${review.id}) as submissions,
        (select count(*)::int from flow_gates where org_id=${org.orgId}
        and subject_kind='payment_dispute_review' and subject_id=${review.id} and status='pending') as pending`,
          "objects",
        )
      )[0]!;
      assert.deepEqual(decisions, { submissions: 1, pending: 0 });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "changed provider evidence cannot replace the terms of a pending return approval",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const h = await settleHarness(org, { reviewFlow: true });
      await settle(h, 10000);
      const event = {
        provider: "stripe",
        providerEventId: `event-${randomUUID()}`,
        attemptId: h.attemptId,
        refundedAmount: "30.0000",
        refundCurrency: "CAD",
        providerRef: "charge-evidence",
        refundAmountBasis: "incremental" as const,
        providerRefundId: "refund-evidence",
      };
      const outcome = await withOrgTransaction(org.orgId, () =>
        processProviderRefundEvent(org.orgId, event),
      );
      assert.equal(outcome.status, "pending_review");
      const fingerprint = async () =>
        (
          await db.execute<{ value: string }>(
            sql`
      select public.provider_return_approval_fingerprint(${org.orgId},${outcome.disputeId}) as value`,
            "objects",
          )
        )[0]!.value;
      const before = await fingerprint();
      await assert.rejects(
        withOrgTransaction(org.orgId, () =>
          processProviderRefundEvent(org.orgId, {
            ...event,
            providerEventId: `changed-${randomUUID()}`,
            refundedAmount: "40.0000",
          }),
        ),
        /changed while its Flow gates are pending/,
      );
      assert.equal(await fingerprint(), before);
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      assert.equal(
        (await decideProviderReview(org.orgId, outcome.disputeId, h.userId, "approved")).status,
        "posted",
      );
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a late receipt posting refusal rolls the source reversal and applications back",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const h = await settleHarness(org);
      await settle(h, 10000);
      const original = (await receipts(org.orgId))[0]!;
      await db.execute(
        sql`update accounts set is_active = false where org_id = ${org.orgId} and id = ${org.accounts.bank}`,
      );
      assert.equal((await h.fire(refund(h, 3000)))?.status, "refunded_pending_review");
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      assert.equal(
        (await receipts(org.orgId)).find((row) => row.id === original.id)?.status,
        "posted",
      );
      const reversed = (
        await db.execute<{ count: number }>(
          sql`select count(*)::int as count from journal_entries
      where org_id = ${org.orgId} and reverses_entry_id is not null`,
          "objects",
        )
      )[0];
      assert.equal(reversed?.count, 0);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("an opened dispute releases its actual hold receipt when won", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await enableReceiptEvents(org.orgId);
    const h = await settleHarness(org, { disputeAccounts: true });
    await settle(h, 10000);
    const ref = `dispute-${randomUUID()}`;
    assert.equal((await h.fire(dispute(h, ref, "opened")))?.status, "disputed_posted");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "100.0000");
    assert.equal((await h.fire(dispute(h, ref, "opened")))?.status, "disputed_duplicate");
    assert.equal((await h.fire(dispute(h, ref, "won")))?.status, "disputed_posted");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
    const rows = await disputeRows(org.orgId);
    assert.equal(rows[0]?.status, "won");
    const hold = (
      await db.execute<{ total: string }>(
        sql`select coalesce(sum(jl.amount), 0)::numeric(19,4)::text as total
      from journal_lines jl join journal_entries e on e.org_id = jl.org_id and e.id = jl.entry_id and e.status in ('posted', 'reversed')
      join accounts a on a.org_id = jl.org_id and a.id = jl.account_id
      where jl.org_id = ${org.orgId} and a.name = 'Disputed Funds Clearing'`,
        "objects",
      )
    )[0];
    assert.equal(hold?.total, "0.0000");
    await assertReceiptEffectsCompleted(org.orgId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "credit-backed refund approvals retain one cash-out receipt and settle the native credit",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const h = await settleHarness(org);
      await settle(h, 10000);
      const creditId = randomUUID();
      await db.execute(sql`insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${creditId}, ${org.orgId}, 'customer_credit', 'draft', ${`CREDIT-${randomUUID()}`}, ${org.subsidiaryId}, ${org.customerId},
              ${org.date}, 'CAD', '1', '30', '0', '30', ${h.userId})`);
      await db.execute(sql`insert into document_lines (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${creditId}, 1, ${org.accounts.revenue}, '1', '30', '30', '0', '0')`);
      await db.execute(sql`update documents set status = 'approved', updated_at = now()
      where org_id = ${org.orgId} and id = ${creditId} and status = 'draft'`);
      await postDocument(creditId, {
        control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
      });
      const approver = await gateReceipts(org.orgId);
      const event = refund(h, 3000);
      assert.equal((await h.fire(event))?.status, "refunded_pending_review");
      await h.fire(event);
      assert.deepEqual(
        (await receipts(org.orgId))
          .filter((row) => row.status === "pending_approval")
          .map((row) => row.total),
        ["-30.0000"],
      );
      await approveReceipts(org.orgId, approver);
      assert.equal(
        (
          await approveDisputeReview(
            org.orgId,
            (await disputeRows(org.orgId))[0]!.id,
            h.userId,
            null,
          )
        ).status,
        "posted",
      );
      assert.equal(await invoiceOpen(org.orgId, creditId), "0.0000");
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      const bank = (
        await db.execute<{ amount: string }>(
          sql`select sum(jl.amount)::numeric(19,4)::text as amount
      from journal_lines jl join journal_entries e on e.id = jl.entry_id and e.org_id = jl.org_id and e.status in ('posted', 'reversed')
      where jl.org_id = ${org.orgId} and jl.account_id = ${org.accounts.bank}`,
          "objects",
        )
      )[0];
      assert.equal(bank?.amount, "70.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

for (const missingFxAccount of [false, true]) {
  test(
    `foreign dispute loss consumes original carrying amounts and ${missingFxAccount ? "refuses missing FX policy before resumption" : "replays without another FX adjustment"}`,
    { skip: !DB },
    async () => {
      const org = await createScratchOrg();
      try {
        await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${org.orgId}, 'EUR', 'CAD', '2000-01-01', 'spot', '1.5', 'test')`);
        const h = await settleHarness(org, { currency: "EUR", disputeAccounts: true });
        await settle(h, 10000, "eur");
        const today = new Date().toISOString().slice(0, 10);
        await db.execute(sql`insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
        values (${org.orgId}, 'EUR', 'CAD', ${today}, 'spot', '1.8', 'test')`);
        const ref = `fx-dispute-${randomUUID()}`;
        const opened = dispute(h, ref, "opened");
        opened.data.object.currency = "eur";
        assert.equal((await h.fire(opened))?.status, "disputed_posted");
        const lost = dispute(h, ref, "lost");
        lost.data.object.currency = "eur";
        if (missingFxAccount) {
          await db.execute(
            sql`update orgs set settings = settings #- '{controlAccounts,fxRealizedGainLoss}' where id = ${org.orgId}`,
          );
          assert.equal((await h.fire(lost))?.status, "disputed_pending_review");
          assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "100.0000");
          const prematurelyApplied = (
            await db.execute<{ count: number }>(
              sql`select count(*)::int as count from applications
          where org_id = ${org.orgId} and unapplied_at is null`,
              "objects",
            )
          )[0];
          assert.equal(prematurelyApplied?.count, 0);
          await db.execute(
            sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,fxRealizedGainLoss}', to_jsonb(${org.accounts.fxGainLoss}::text)) where id = ${org.orgId}`,
          );
          assert.equal(
            (
              await approveDisputeReview(
                org.orgId,
                (await disputeRows(org.orgId))[0]!.id,
                h.userId,
                null,
              )
            ).status,
            "posted",
          );
        } else assert.equal((await h.fire(lost))?.status, "disputed_posted");
        const allocations = await db.execute<{
          amount: string;
          source_amount: string;
          source_txn: string;
          target_txn: string;
          fx_id: string | null;
        }>(
          sql`
        select amount::text, source_amount::text, source_transaction_amount::text as source_txn,
               target_transaction_amount::text as target_txn, fx_gain_loss_entry_id as fx_id
          from applications where org_id = ${org.orgId} and unapplied_at is null`,
          "objects",
        );
        assert.equal(allocations.length, 1);
        assert.deepEqual(
          { ...allocations[0], fx_id: !!allocations[0]!.fx_id },
          {
            amount: "150.0000",
            source_amount: "180.0000",
            source_txn: "100.0000",
            target_txn: "100.0000",
            fx_id: true,
          },
        );
        assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
        const adjustment = (
          await db.execute<{ amount: string }>(
            sql`select sum(jl.amount)::numeric(19,4)::text as amount
        from journal_lines jl join journal_entries e on e.id = jl.entry_id and e.org_id = jl.org_id
        where jl.org_id = ${org.orgId} and jl.account_id = ${org.accounts.ar} and e.origin = 'fx_settlement' and e.status = 'posted'`,
            "objects",
          )
        )[0];
        assert.equal(adjustment?.amount, "30.0000");
        assert.equal((await h.fire(lost))?.status, "disputed_duplicate");
        assert.equal(
          (
            await db.execute<{ count: number }>(
              sql`select count(*)::int as count from journal_entries
        where org_id = ${org.orgId} and origin = 'fx_settlement' and status = 'posted'`,
              "objects",
            )
          )[0]?.count,
          1,
        );
      } finally {
        await dropScratchOrg(org.orgId);
      }
    },
  );
}

test("reviewing a lost dispute preserves the confirmed provider fee", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org, { disputeAccounts: true });
    await settle(h, 10000);
    const ref = `fee-dispute-${randomUUID()}`;
    await h.fire(dispute(h, ref, "opened"));
    await seedProviderReviewFlow(org.orgId, h.userId);
    const event = {
      provider: "stripe",
      providerEventId: `fee-event-${randomUUID()}`,
      attemptId: h.attemptId,
      dispute: { id: ref, state: "lost" as const, amount: "100", currency: "CAD" },
      raw: { feeAmount: "5" },
    };
    assert.equal((await processProviderDisputeEvent(org.orgId, event)).status, "pending_review");
    const review = (await disputeRows(org.orgId))[0]!;
    assert.equal(
      (await decideProviderReview(org.orgId, review.id, h.userId, "approved")).status,
      "lost",
    );
    const fee = (
      await db.execute<{ amount: string }>(
        sql`select sum(jl.amount)::numeric(19,4)::text as amount
      from journal_lines jl join journal_entries e on e.id = jl.entry_id and e.org_id = jl.org_id and e.status = 'posted'
      join accounts a on a.id = jl.account_id and a.org_id = jl.org_id where jl.org_id = ${org.orgId} and a.name = 'Dispute Fees'`,
        "objects",
      )
    )[0];
    assert.equal(fee?.amount, "5.0000");
    assert.equal(
      (
        await db.execute<{ fee: string }>(
          sql`select fee_amount::text as fee from payment_disputes
      where org_id = ${org.orgId} and id = ${review.id}`,
          "objects",
        )
      )[0]?.fee,
      "5.0000",
    );
    assert.equal(
      (await approveDisputeReview(org.orgId, review.id, h.userId, null)).status,
      "duplicate",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "gated dispute receipts preserve the source and a gated win preserves the hold until resumption",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await enableReceiptEvents(org.orgId);
      const h = await settleHarness(org, { disputeAccounts: true });
      await settle(h, 10000);
      const approver = await gateReceipts(org.orgId);
      const ref = `dispute-${randomUUID()}`;
      assert.equal(
        (await h.fire(dispute(h, ref, "opened", 3000)))?.status,
        "disputed_pending_review",
      );
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      await approveReceipts(org.orgId, approver);
      const review = (await disputeRows(org.orgId))[0]!;
      assert.equal(
        (await approveDisputeReview(org.orgId, review.id, h.userId, null)).status,
        "posted",
      );
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
      assert.equal((await h.fire(dispute(h, ref, "won", 3000)))?.status, "disputed_pending_review");
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
      await approveReceipts(org.orgId, approver);
      assert.equal(
        (await approveDisputeReview(org.orgId, review.id, h.userId, null)).status,
        "posted",
      );
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      assert.equal((await disputeRows(org.orgId))[0]?.status, "won");
      await assertReceiptEffectsCompleted(org.orgId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "rejected refunds stay rejected across delivery identities and scoped reviewers cannot act",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const h = await settleHarness(org, { reviewFlow: true });
      await settle(h, 10000);
      const event = refund(h, 10000);
      await h.fire(event);
      const row = (await disputeRows(org.orgId))[0]!;
      const restricted = new Set<string>();
      await assert.rejects(
        approveDisputeReview(org.orgId, row.id, h.userId, restricted),
        ScopeNotFoundError,
      );
      await assert.rejects(
        rejectDisputeReview(
          org.orgId,
          row.id,
          h.userId,
          "Cannot act outside my entity",
          restricted,
        ),
        ScopeNotFoundError,
      );
      await db.execute(sql`update app_roles set subsidiary_restriction = '{"mode":"list","subsidiaryIds":[]}'::jsonb
      where org_id = ${org.orgId} and key = 'admin'`);
      await assert.rejects(
        approveDisputeReview(org.orgId, row.id, h.userId, null),
        ScopeNotFoundError,
      );
      await assert.rejects(
        rejectDisputeReview(org.orgId, row.id, h.userId, "Cannot act after scope revocation", null),
        ScopeNotFoundError,
      );
      await db.execute(
        sql`update app_roles set subsidiary_restriction = '{"mode":"all"}'::jsonb where org_id = ${org.orgId} and key = 'admin'`,
      );
      await decideProviderReview(
        org.orgId,
        row.id,
        h.userId,
        "rejected",
        "Customer confirmed a duplicate provider notice",
      );
      assert.equal((await h.fire(event))?.status, "refunded_duplicate");
      assert.equal((await h.fire(refund(h, 10000)))?.status, "refunded_duplicate");
      assert.equal((await disputeRows(org.orgId))[0]?.status, "rejected");
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      await db.execute(sql`update user_permission_overrides set effect = 'deny'
      where org_id = ${org.orgId} and user_id = ${h.userId} and permission = 'banking.reconcile'`);
      await assert.rejects(
        approveDisputeReview(org.orgId, row.id, h.userId, null),
        ScopeNotFoundError,
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

for (const initialState of ["pending", "failed"] as const) {
  test(
    `a provider refund completes ${initialState} native receipt effects before reversal and completes its replacement once`,
    { skip: !DB },
    async () => {
      const org = await createScratchOrg();
      try {
        const { h, receiptId } = await pendingReceipt(org);
        if (initialState === "failed") {
          await withOrgTransaction(org.orgId, async () => {
            const claim = await claimPostingEffectsForDocument(receiptId);
            assert.ok(claim && typeof claim === "object");
            await markPostingEffectsFailed(
              claim,
              new Error("Receipt projection worker interrupted before processing"),
            );
          });
          assert.equal((await receiptEffect(org.orgId, receiptId)).status, "failed");
        }
        const event = refund(h, 3000);
        assert.equal((await h.fire(event))?.status, "refunded_posted");
        assert.equal(
          (await receipts(org.orgId)).find((row) => row.id === receiptId)!.status,
          "voided",
        );
        assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
        await assertReceiptEffectsCompleted(org.orgId);
        const completed = await receiptEffect(org.orgId, receiptId);
        assert.equal(completed.attempt_count, initialState === "failed" ? 2 : 1);
        assert.equal((await h.fire(event))?.status, "refunded_duplicate");
        assert.equal((await receipts(org.orgId)).length, 2);
        assert.deepEqual(await receiptEffect(org.orgId, receiptId), completed);
        await assertReceiptEffectsCompleted(org.orgId);
      } finally {
        await dropScratchOrg(org.orgId);
      }
    },
  );
}

test(
  "a running receipt effect keeps a provider return recoverable until the native worker recovers its lease",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { h, receiptId } = await pendingReceipt(org);
      const approver = await gateReceipts(org.orgId);
      const event = refund(h, 3000);
      assert.equal((await h.fire(event))?.status, "refunded_pending_review");
      await approveReceipts(org.orgId, approver);
      await withOrgTransaction(org.orgId, async () => {
        const claim = await claimPostingEffectsForDocument(
          receiptId,
          new Date("2000-01-01T00:00:00Z"),
        );
        assert.ok(claim && typeof claim === "object");
      });
      assert.equal((await h.fire(event))?.status, "refunded_pending_review");
      assert.equal((await receiptEffect(org.orgId, receiptId)).status, "running");
      assert.equal(
        (await receipts(org.orgId)).find((row) => row.id === receiptId)!.status,
        "posted",
      );
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      const review = (await disputeRows(org.orgId))[0]!;
      const refusal = (
        await db.execute<{ reason: string }>(
          sql`select reason from payment_disputes
      where org_id = ${org.orgId} and id = ${review.id}`,
          "objects",
        )
      )[0]!;
      assert.match(refusal.reason, /running.*wait for their native completion/);
      const identities = (await receipts(org.orgId)).map((row) => row.id).sort();
      const recovered = await withOrgTransaction(org.orgId, () =>
        processDuePostingEffects(new Date(), 10),
      );
      assert.equal(recovered.failed, 0);
      assert.equal(recovered.succeeded, 1);
      assert.equal((await receiptEffect(org.orgId, receiptId)).status, "succeeded");
      assert.equal(
        (await approveDisputeReview(org.orgId, review.id, h.userId, null)).status,
        "posted",
      );
      assert.deepEqual((await receipts(org.orgId)).map((row) => row.id).sort(), identities);
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
      await assertReceiptEffectsCompleted(org.orgId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "terminal receipt effects require the native reasoned replay before a provider return can resume",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { h, receiptId } = await pendingReceipt(org);
      const approver = await gateReceipts(org.orgId);
      const event = refund(h, 3000);
      assert.equal((await h.fire(event))?.status, "refunded_pending_review");
      await approveReceipts(org.orgId, approver);
      await withOrgTransaction(org.orgId, async () => {
        for (let attempt = 0; attempt < MAX_POSTING_EFFECTS_ATTEMPTS; attempt++) {
          const claim = await claimPostingEffectsForDocument(receiptId);
          assert.ok(claim && typeof claim === "object");
          await markPostingEffectsFailed(
            claim,
            new Error("Receipt projection worker could not complete its task"),
          );
        }
      });
      const effect = await receiptEffect(org.orgId, receiptId);
      assert.equal(effect.status, "terminal_failed");
      const notice = (
        await db.execute<{ count: number }>(
          sql`select count(*)::int as count from notifications
      where org_id = ${org.orgId} and user_id = ${h.userId} and kind = ${POSTING_EFFECT_TERMINAL_NOTICE_KIND}`,
          "objects",
        )
      )[0]!;
      assert.equal(notice.count, 1, "terminal payment effects notify the native ar.pay operator");
      const invoicePoster = await createScratchUser(
        org.orgId,
        "Invoice posting operator",
        "invoice_poster",
      );
      await grantScratchPermissions(org.orgId, invoicePoster, ["ar.post"]);
      await assert.rejects(
        replayTerminalPostingEffect({
          orgId: org.orgId,
          id: effect.id,
          actorId: invoicePoster,
          reason: "Invoice authority does not authorize receipt recovery",
        }),
        /posting permission and legal-entity access/,
      );
      await assert.rejects(
        replayTerminalPostingEffect({
          orgId: org.orgId,
          id: effect.id,
          actorId: h.userId,
          reason: "Recovery requested outside the selected legal entity",
          allowedSubsidiaryIds: new Set(),
        }),
        ScopeNotFoundError,
      );
      assert.deepEqual(await receiptEffect(org.orgId, receiptId), effect);
      assert.equal((await h.fire(event))?.status, "refunded_pending_review");
      assert.equal(
        (await receipts(org.orgId)).find((row) => row.id === receiptId)!.status,
        "posted",
      );
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      const review = (await disputeRows(org.orgId))[0]!;
      const refusal = (
        await db.execute<{ reason: string }>(
          sql`select reason from payment_disputes
      where org_id = ${org.orgId} and id = ${review.id}`,
          "objects",
        )
      )[0]!;
      assert.match(refusal.reason, /Retry posting effects.*review reason/);
      assert.equal(
        (await approveDisputeReview(org.orgId, review.id, h.userId, null)).status,
        "pending_review",
      );
      assert.deepEqual(await receiptEffect(org.orgId, receiptId), effect);
      const identities = (await receipts(org.orgId)).map((row) => row.id).sort();
      await assert.rejects(
        replayTerminalPostingEffect({
          orgId: org.orgId,
          id: effect.id,
          actorId: h.userId,
          reason: "",
        }),
        /reason/,
      );
      await replayTerminalPostingEffect({
        orgId: org.orgId,
        id: effect.id,
        actorId: h.userId,
        reason: "Receipt projection cause resolved; retry before the provider return",
      });
      assert.equal((await receiptEffect(org.orgId, receiptId)).status, "pending");
      const audit = await db.execute<{ actor_id: string; changes: { reason: string } }>(
        sql`
      select actor_id, changes from audit_log where org_id = ${org.orgId} and row_id = ${effect.id}
        and changes->>'event' = 'posting_effects_replay_authorized'`,
        "objects",
      );
      assert.equal(audit.length, 1);
      assert.equal(audit[0]!.actor_id, h.userId);
      assert.equal(
        audit[0]!.changes.reason,
        "Receipt projection cause resolved; retry before the provider return",
      );
      assert.equal(
        (await approveDisputeReview(org.orgId, review.id, h.userId, null)).status,
        "posted",
      );
      assert.deepEqual((await receipts(org.orgId)).map((row) => row.id).sort(), identities);
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
      await assertReceiptEffectsCompleted(org.orgId);
      assert.equal((await h.fire(event))?.status, "refunded_duplicate");
      await assertReceiptEffectsCompleted(org.orgId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a caught nested financial rollback admits no receipt effects and the same approved receipt remains resumable",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await enableReceiptEvents(org.orgId);
      const h = await settleHarness(org);
      await settle(h, 10000);
      const original = (await receipts(org.orgId))[0]!;
      const approver = await gateReceipts(org.orgId);
      assert.equal((await h.fire(refund(h, 3000)))?.status, "refunded_pending_review");
      const staged = (await receipts(org.orgId)).find((row) => row.status === "pending_approval")!;
      await approveReceipts(org.orgId, approver);
      await withOrgTransaction(org.orgId, () =>
        returnFinancialStage(async () => {
          await assert.rejects(
            returnFinancialStage(async () => {
              await reversePaymentForReturn(
                original.id,
                org.orgId,
                "Return accounting must settle as one unit",
                h.userId,
              );
              await postReturnReceipt(org.orgId, staged.id);
              throw new PaymentError("The parent accounting unit refused its final allocation");
            }),
            /parent accounting unit/,
          );
        }),
      );
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      assert.equal(
        (await receipts(org.orgId)).find((row) => row.id === original.id)!.status,
        "posted",
      );
      assert.equal(
        (await receipts(org.orgId)).find((row) => row.id === staged.id)!.status,
        "approved",
      );
      assert.equal(await receiptEffect(org.orgId, staged.id), undefined);
      assert.equal(
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from webhook_events
      where org_id = ${org.orgId} and entity_id = ${staged.id}`,
            "objects",
          )
        )[0]!.count,
        0,
      );
      assert.equal(
        (
          await db.execute<{ count: number }>(
            sql`select count(*)::int as count from journal_entries
      where org_id = ${org.orgId} and reverses_entry_id is not null`,
            "objects",
          )
        )[0]!.count,
        0,
      );
      assert.equal(
        (
          await approveDisputeReview(
            org.orgId,
            (await disputeRows(org.orgId))[0]!.id,
            h.userId,
            null,
          )
        ).status,
        "posted",
      );
      assert.equal(
        (await receipts(org.orgId)).find((row) => row.id === staged.id)!.status,
        "posted",
      );
      assert.equal((await receipts(org.orgId)).length, 2);
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
      await assertReceiptEffectsCompleted(org.orgId);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "provider returns retain the original receipt author and refuse revoked authority before any financial change",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const h = await settleHarness(org);
      await settle(h, 10000);
      const original = (await receipts(org.orgId)).find((row) => row.status === "posted")!;
      const entries = async () =>
        await db.execute<{ id: string; status: string }>(
          sql`
      select id,status from journal_entries where org_id=${org.orgId} order by id`,
          "objects",
        );
      const before = await entries();
      const event = refund(h, 3000);
      await db.execute(sql`update user_permission_overrides set effect='deny'
      where org_id=${org.orgId} and user_id=${h.userId} and permission='ar.pay'`);
      assert.equal((await h.fire(event))?.status, "refunded_pending_review");
      const review = (await disputeRows(org.orgId))[0]!;
      assert.equal(review.status, "pending_review");
      const reason = (
        await db.execute<{ reason: string }>(
          sql`select reason from payment_disputes where org_id=${org.orgId} and id=${review.id}`,
          "objects",
        )
      )[0]!.reason;
      assert.match(reason, /original receipt.*acting user.*receipt authority/i);
      assert.deepEqual(
        await entries(),
        before,
        "refused provider returns retain every original journal",
      );
      assert.deepEqual(
        await receipts(org.orgId),
        [original],
        "no receipt is reversed or staged without current authority",
      );
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      await grantScratchPermissions(org.orgId, h.userId, ["ar.pay"]);
      assert.equal(
        (await approveDisputeReview(org.orgId, review.id, h.userId, null)).status,
        "posted",
      );
      const replacement = await db.execute<{ created_by: string }>(
        sql`
      select created_by from documents where org_id=${org.orgId} and kind='customer_payment' and status='posted'`,
        "objects",
      );
      assert.deepEqual(replacement, [{ created_by: h.userId }]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
