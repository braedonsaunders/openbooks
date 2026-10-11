import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg, grantScratchPermissions, seedApprovalFlow } from "../testing/fixtures.ts";
import { decideGate } from "../flows/gates.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { approveDisputeReview, rejectDisputeReview, processProviderDisputeEvent } from "./psp-refund-automation.ts";
import { settleHarness, settle, invoiceOpen, disputeRows, type Harness } from "./refund-test-support.integration.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function refund(h: Harness, cumulativeMinor: number, id = `refund-${randomUUID()}`) {
  return { id, type: "charge.refunded", data: { object: { id: `charge-${h.attemptId}`, payment_intent: h.intentId, amount_refunded: cumulativeMinor, amount: 10000, currency: "cad" } } };
}

function dispute(h: Harness, ref: string, state: "opened" | "won" | "lost", minor = 10000) {
  return { id: `dispute-${randomUUID()}`, type: state === "opened" ? "charge.dispute.created" : "charge.dispute.closed",
    data: { object: { id: ref, payment_intent: h.intentId, amount: minor, currency: "cad", ...(state === "opened" ? {} : { status: state }) } } };
}

async function receipts(orgId: string) {
  return (await db.execute<{ id: string; status: string; total: string }>(sql`
    select id, status, total::text as total from documents where org_id = ${orgId} and kind = 'customer_payment' order by created_at, id`)).rows;
}

async function approveReceipts(orgId: string, actorId: string) {
  const gates = (await db.execute<{ id: string }>(sql`select id from flow_gates
    where org_id = ${orgId} and subject_kind = 'customer_payment' and status = 'pending' order by created_at, id`)).rows;
  for (const gate of gates) await decideGate({ gateId: gate.id, decision: "approved", userId: actorId, allowedSubsidiaryIds: null });
}

async function gateReceipts(orgId: string) {
  const actorId = await createScratchUser(orgId, "Receipt approver", "receipt_approver");
  await grantScratchPermissions(orgId, actorId, ["ar.pay"]);
  await seedApprovalFlow(orgId, { subjectKind: "customer_payment", assignees: [{ type: "user", userId: actorId }], mode: "any" });
  return actorId;
}

test("successive, repeated and stale Stripe refund snapshots reconcile the original charge", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org);
    await settle(h, 10000);
    assert.equal((await h.fire(refund(h, 3000)))?.status, "refunded_posted");
    assert.equal((await h.fire(refund(h, 5000)))?.status, "refunded_posted");
    assert.equal((await h.fire(refund(h, 5000)))?.status, "refunded_duplicate");
    assert.equal((await h.fire(refund(h, 3000)))?.status, "refunded_duplicate");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "50.0000");
    assert.deepEqual((await receipts(org.orgId)).filter(row => row.status === "posted").map(row => row.total), ["50.0000"]);
    const totals = (await db.execute<{ total: string }>(sql`select sum(amount)::numeric(19,4)::text as total from payment_disputes
      where org_id = ${org.orgId} and attempt_id = ${h.attemptId} and kind = 'refund' and status = 'posted'`)).rows[0];
    assert.equal(totals?.total, "50.0000");
    assert.equal((await h.fire(refund(h, 10000)))?.status, "refunded_posted");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "100.0000");
    assert.equal((await receipts(org.orgId)).filter(row => row.status === "posted").length, 0);
  } finally { await dropScratchOrg(org.orgId); }
});

test("concurrent cumulative snapshots converge regardless of delivery order", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org);
    await settle(h, 10000);
    // Each delivery owns its own tenant transaction; the attempt is the shared mutex.
    await Promise.all([h.fire(refund(h, 3000)), h.fire(refund(h, 5000))]);
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "50.0000");
    assert.deepEqual((await receipts(org.orgId)).filter(row => row.status === "posted").map(row => row.total), ["50.0000"]);
  } finally { await dropScratchOrg(org.orgId); }
});

test("Stripe refund object status updates do not account for the same cash twice", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org);
    await settle(h, 10000);
    await h.fire(refund(h, 3000));
    const result = await h.fire({ id: `refund-update-${randomUUID()}`, type: "charge.refund.updated",
      data: { object: { id: "refund-object", payment_intent: h.intentId, amount: 3000, currency: "cad", status: "succeeded" } } });
    assert.equal(result?.status, "refunded_noted");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
    assert.equal((await disputeRows(org.orgId)).length, 1);
  } finally { await dropScratchOrg(org.orgId); }
});

test("a Stripe return without its refunded total waits for confirmed redelivery", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org);
    await settle(h, 10000);
    const confirmed = refund(h, 3000);
    const { amount_refunded: _refunded, ...object } = confirmed.data.object;
    assert.equal((await h.fire({ ...confirmed, data: { object } }))?.status, "refunded_pending_review");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
    assert.equal((await h.fire(confirmed))?.status, "refunded_posted");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
    assert.equal((await disputeRows(org.orgId)).length, 1);
  } finally { await dropScratchOrg(org.orgId); }
});

test("a gated partial refund preserves the original payment and resumes the same approved receipt", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org);
    await settle(h, 10000);
    const original = (await receipts(org.orgId))[0]!;
    const approver = await gateReceipts(org.orgId);
    const event = refund(h, 3000);
    assert.equal((await h.fire(event))?.status, "refunded_pending_review");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
    const staged = (await receipts(org.orgId)).find(row => row.status === "pending_approval")!;
    assert.equal(staged.total, "70.0000");
    assert.equal((await receipts(org.orgId)).find(row => row.id === original.id)?.status, "posted");
    await h.fire(event);
    assert.equal((await receipts(org.orgId)).length, 2, "redelivery retains one approval subject");
    await approveReceipts(org.orgId, approver);
    await assert.rejects(postPaymentWithApplications(staged.id), /provider return/);
    const review = (await disputeRows(org.orgId))[0]!;
    assert.equal((await approveDisputeReview(org.orgId, review.id, h.userId, null)).status, "posted");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
    assert.equal((await receipts(org.orgId)).find(row => row.id === staged.id)?.status, "posted");
    assert.equal((await receipts(org.orgId)).length, 2);
  } finally { await dropScratchOrg(org.orgId); }
});

test("a late receipt posting refusal rolls the source reversal and applications back", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org);
    await settle(h, 10000);
    const original = (await receipts(org.orgId))[0]!;
    await db.execute(sql`update accounts set is_active = false where org_id = ${org.orgId} and id = ${org.accounts.bank}`);
    assert.equal((await h.fire(refund(h, 3000)))?.status, "refunded_pending_review");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
    assert.equal((await receipts(org.orgId)).find(row => row.id === original.id)?.status, "posted");
    const reversed = (await db.execute<{ count: number }>(sql`select count(*)::int as count from journal_entries
      where org_id = ${org.orgId} and reverses_entry_id is not null`)).rows[0];
    assert.equal(reversed?.count, 0);
  } finally { await dropScratchOrg(org.orgId); }
});

test("an opened dispute releases its actual hold receipt when won", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
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
    const hold = (await db.execute<{ total: string }>(sql`select coalesce(sum(jl.amount), 0)::numeric(19,4)::text as total
      from journal_lines jl join journal_entries e on e.org_id = jl.org_id and e.id = jl.entry_id and e.status in ('posted', 'reversed')
      join accounts a on a.org_id = jl.org_id and a.id = jl.account_id
      where jl.org_id = ${org.orgId} and a.name = 'Disputed Funds Clearing'`)).rows[0];
    assert.equal(hold?.total, "0.0000");
  } finally { await dropScratchOrg(org.orgId); }
});

test("credit-backed refund approvals retain one cash-out receipt and settle the native credit", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org);
    await settle(h, 10000);
    const creditId = randomUUID();
    await db.execute(sql`insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id, document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${creditId}, ${org.orgId}, 'customer_credit', 'approved', ${`CREDIT-${randomUUID()}`}, ${org.subsidiaryId}, ${org.customerId},
              ${org.date}, 'CAD', '1', '30', '0', '30', ${h.userId})`);
    await db.execute(sql`insert into document_lines (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${creditId}, 1, ${org.accounts.revenue}, '1', '30', '30', '0', '0')`);
    await postDocument(creditId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
    const approver = await gateReceipts(org.orgId);
    const event = refund(h, 3000);
    assert.equal((await h.fire(event))?.status, "refunded_pending_review");
    await h.fire(event);
    assert.deepEqual((await receipts(org.orgId)).filter(row => row.status === "pending_approval").map(row => row.total), ["-30.0000"]);
    await approveReceipts(org.orgId, approver);
    assert.equal((await approveDisputeReview(org.orgId, (await disputeRows(org.orgId))[0]!.id, h.userId, null)).status, "posted");
    assert.equal(await invoiceOpen(org.orgId, creditId), "0.0000");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
    const bank = (await db.execute<{ amount: string }>(sql`select sum(jl.amount)::numeric(19,4)::text as amount
      from journal_lines jl join journal_entries e on e.id = jl.entry_id and e.org_id = jl.org_id and e.status in ('posted', 'reversed')
      where jl.org_id = ${org.orgId} and jl.account_id = ${org.accounts.bank}`)).rows[0];
    assert.equal(bank?.amount, "70.0000");
  } finally { await dropScratchOrg(org.orgId); }
});

for (const missingFxAccount of [false, true]) {
  test(`foreign dispute loss consumes original carrying amounts and ${missingFxAccount ? "refuses missing FX policy before resumption" : "replays without another FX adjustment"}`, { skip: !DB }, async () => {
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
        await db.execute(sql`update orgs set settings = settings #- '{controlAccounts,fxRealizedGainLoss}' where id = ${org.orgId}`);
        assert.equal((await h.fire(lost))?.status, "disputed_pending_review");
        assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "100.0000");
        const prematurelyApplied = (await db.execute<{ count: number }>(sql`select count(*)::int as count from applications
          where org_id = ${org.orgId} and unapplied_at is null`)).rows[0];
        assert.equal(prematurelyApplied?.count, 0);
        await db.execute(sql`update orgs set settings = jsonb_set(settings, '{controlAccounts,fxRealizedGainLoss}', to_jsonb(${org.accounts.fxGainLoss}::text)) where id = ${org.orgId}`);
        assert.equal((await approveDisputeReview(org.orgId, (await disputeRows(org.orgId))[0]!.id, h.userId, null)).status, "posted");
      } else assert.equal((await h.fire(lost))?.status, "disputed_posted");
      const allocations = (await db.execute<{ amount: string; source_amount: string; source_txn: string; target_txn: string; fx_id: string | null }>(sql`
        select amount::text, source_amount::text, source_transaction_amount::text as source_txn,
               target_transaction_amount::text as target_txn, fx_gain_loss_entry_id as fx_id
          from applications where org_id = ${org.orgId} and unapplied_at is null`)).rows;
      assert.equal(allocations.length, 1);
      assert.deepEqual({ ...allocations[0], fx_id: !!allocations[0]!.fx_id }, { amount: "150.0000", source_amount: "180.0000", source_txn: "100.0000", target_txn: "100.0000", fx_id: true });
      assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
      const adjustment = (await db.execute<{ amount: string }>(sql`select sum(jl.amount)::numeric(19,4)::text as amount
        from journal_lines jl join journal_entries e on e.id = jl.entry_id and e.org_id = jl.org_id
        where jl.org_id = ${org.orgId} and jl.account_id = ${org.accounts.ar} and e.origin = 'fx_settlement' and e.status = 'posted'`)).rows[0];
      assert.equal(adjustment?.amount, "30.0000");
      assert.equal((await h.fire(lost))?.status, "disputed_duplicate");
      assert.equal((await db.execute<{ count: number }>(sql`select count(*)::int as count from journal_entries
        where org_id = ${org.orgId} and origin = 'fx_settlement' and status = 'posted'`)).rows[0]?.count, 1);
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test("reviewing a lost dispute preserves the confirmed provider fee", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org, { disputeAccounts: true });
    await settle(h, 10000);
    const ref = `fee-dispute-${randomUUID()}`;
    await h.fire(dispute(h, ref, "opened"));
    await db.execute(sql`update psp_provider_configs set refund_policy = 'review' where org_id = ${org.orgId} and provider = 'stripe'`);
    const event = { provider: "stripe", providerEventId: `fee-event-${randomUUID()}`, attemptId: h.attemptId,
      dispute: { id: ref, state: "lost" as const, amount: "100", currency: "CAD" }, raw: { feeAmount: "5" } };
    assert.equal((await processProviderDisputeEvent(org.orgId, event)).status, "pending_review");
    const review = (await disputeRows(org.orgId))[0]!;
    assert.equal((await approveDisputeReview(org.orgId, review.id, h.userId, null)).status, "posted");
    const fee = (await db.execute<{ amount: string }>(sql`select sum(jl.amount)::numeric(19,4)::text as amount
      from journal_lines jl join journal_entries e on e.id = jl.entry_id and e.org_id = jl.org_id and e.status = 'posted'
      join accounts a on a.id = jl.account_id and a.org_id = jl.org_id where jl.org_id = ${org.orgId} and a.name = 'Dispute Fees'`)).rows[0];
    assert.equal(fee?.amount, "5.0000");
    assert.equal((await db.execute<{ fee: string }>(sql`select fee_amount::text as fee from payment_disputes
      where org_id = ${org.orgId} and id = ${review.id}`)).rows[0]?.fee, "5.0000");
    assert.equal((await approveDisputeReview(org.orgId, review.id, h.userId, null)).status, "duplicate");
  } finally { await dropScratchOrg(org.orgId); }
});

test("gated dispute receipts preserve the source and a gated win preserves the hold until resumption", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org, { disputeAccounts: true });
    await settle(h, 10000);
    const approver = await gateReceipts(org.orgId);
    const ref = `dispute-${randomUUID()}`;
    assert.equal((await h.fire(dispute(h, ref, "opened", 3000)))?.status, "disputed_pending_review");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
    await approveReceipts(org.orgId, approver);
    const review = (await disputeRows(org.orgId))[0]!;
    assert.equal((await approveDisputeReview(org.orgId, review.id, h.userId, null)).status, "posted");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
    assert.equal((await h.fire(dispute(h, ref, "won", 3000)))?.status, "disputed_pending_review");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "30.0000");
    await approveReceipts(org.orgId, approver);
    assert.equal((await approveDisputeReview(org.orgId, review.id, h.userId, null)).status, "posted");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
    assert.equal((await disputeRows(org.orgId))[0]?.status, "won");
  } finally { await dropScratchOrg(org.orgId); }
});

test("rejected refunds stay rejected across delivery identities and scoped reviewers cannot act", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org, { policy: "review" });
    await settle(h, 10000);
    const event = refund(h, 10000);
    await h.fire(event);
    const row = (await disputeRows(org.orgId))[0]!;
    const restricted = new Set<string>();
    await assert.rejects(approveDisputeReview(org.orgId, row.id, h.userId, restricted), ScopeNotFoundError);
    await assert.rejects(rejectDisputeReview(org.orgId, row.id, h.userId, "Cannot act outside my entity", restricted), ScopeNotFoundError);
    await db.execute(sql`update app_roles set subsidiary_restriction = '{"mode":"list","subsidiaryIds":[]}'::jsonb
      where org_id = ${org.orgId} and key = 'admin'`);
    await assert.rejects(approveDisputeReview(org.orgId, row.id, h.userId, null), ScopeNotFoundError);
    await assert.rejects(rejectDisputeReview(org.orgId, row.id, h.userId, "Cannot act after scope revocation", null), ScopeNotFoundError);
    await db.execute(sql`update app_roles set subsidiary_restriction = null where org_id = ${org.orgId} and key = 'admin'`);
    await rejectDisputeReview(org.orgId, row.id, h.userId, "Customer confirmed a duplicate provider notice", null);
    assert.equal((await h.fire(event))?.status, "refunded_duplicate");
    assert.equal((await h.fire(refund(h, 10000)))?.status, "refunded_duplicate");
    assert.equal((await disputeRows(org.orgId))[0]?.status, "rejected");
    assert.equal(await invoiceOpen(org.orgId, h.invoiceId), "0.0000");
    await db.execute(sql`update user_permission_overrides set effect = 'deny'
      where org_id = ${org.orgId} and user_id = ${h.userId} and permission = 'banking.reconcile'`);
    await assert.rejects(approveDisputeReview(org.orgId, row.id, h.userId, null), ScopeNotFoundError);
  } finally { await dropScratchOrg(org.orgId); }
});
