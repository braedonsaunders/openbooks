import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { applyPaymentToOpenItem } from "./psp-automation-postings.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";

import {
  settleHarness,
  settle,
  invoiceOpen,
  disputeRows,
  decideProviderReview,
} from "./refund-test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("a full refund reverses the receipt and reopens the invoice", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org);
    await settle(h, 10_000);
    assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "0.0000");

    const refunded = await h.fire({
      id: `evt_refund_${randomUUID().slice(0, 8)}`,
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          payment_intent: h.intentId,
          amount_refunded: 10_000,
          amount: 10_000,
          currency: "cad",
        },
      },
    });
    assert.equal(refunded?.status, "refunded_posted");
    assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "100.0000");

    const rows = await disputeRows(h.orgId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "refund");
    assert.equal(rows[0]!.status, "posted");
    assert.equal((rows[0]!.documents_posted as string[]).length, 1);

    const attempt = (
      await db.execute<{ status: string }>(
        sql`
      select status from payment_attempts where id = ${h.attemptId} and org_id = ${h.orgId}`,
        "objects",
      )
    )[0];
    assert.equal(attempt!.status, "refunded");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "a partial refund posts the exact amount and reissues the remainder",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const h = await settleHarness(org);
      await settle(h, 10_000);

      const refunded = await h.fire({
        id: `evt_refund_${randomUUID().slice(0, 8)}`,
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_1",
            payment_intent: h.intentId,
            amount_refunded: 3_000,
            amount: 10_000,
            currency: "cad",
          },
        },
      });
      assert.equal(refunded?.status, "refunded_posted");
      // The invoice reopens by the refunded 30, not the full 100.
      assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "30.0000");

      const receipts = await db.execute<{ total: string; status: string }>(
        sql`
      select total::text as total, status from documents
       where org_id = ${h.orgId} and kind = 'customer_payment' order by created_at`,
        "objects",
      );
      const postedTotals = receipts.filter((r) => r.status === "posted").map((r) => r.total);
      assert.deepEqual(postedTotals, ["70.0000"]);

      const rows = await disputeRows(h.orgId);
      assert.equal(rows.length, 1);
      assert.equal((rows[0]!.documents_posted as string[]).length, 2);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a dispute opened then lost posts the loss and settles the invoice",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const h = await settleHarness(org, { disputeAccounts: true });
      await settle(h, 10_000);

      const opened = await h.fire({
        id: `evt_dp_open_${randomUUID().slice(0, 8)}`,
        type: "charge.dispute.created",
        data: {
          object: {
            id: "dp_1",
            payment_intent: h.intentId,
            amount: 10_000,
            currency: "cad",
            reason: "fraudulent",
          },
        },
      });
      assert.equal(opened?.status, "disputed_posted");
      assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "100.0000");

      const lost = await h.fire({
        id: `evt_dp_lost_${randomUUID().slice(0, 8)}`,
        type: "charge.dispute.closed",
        data: {
          object: {
            id: "dp_1",
            payment_intent: h.intentId,
            amount: 10_000,
            currency: "cad",
            status: "lost",
          },
        },
      });
      assert.equal(lost?.status, "disputed_posted");
      // The customer owes nothing: the held funds settled the invoice.
      assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "0.0000");

      const loss = (
        await db.execute<{ debit: string; credit: string }>(
          sql`
      select sum(case when jl.amount > 0 then jl.amount else 0 end)::text as debit,
             sum(case when jl.amount < 0 then -jl.amount else 0 end)::text as credit
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
       where jl.org_id = ${h.orgId} and a.name = 'Chargeback Losses' and je.status in ('posted', 'reversed')`,
          "objects",
        )
      )[0];
      assert.equal(loss!.debit, "100.0000");

      const clearing = (
        await db.execute<{ balance: string }>(
          sql`
      select coalesce(sum(jl.amount), 0)::text as balance
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
       where jl.org_id = ${h.orgId} and a.name = 'Disputed Funds Clearing' and je.status in ('posted', 'reversed')`,
          "objects",
        )
      )[0];
      assert.equal(clearing!.balance, "0.0000");

      const rows = await disputeRows(h.orgId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, "lost");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a lost dispute clears the full hold when the invoice was already settled",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const h = await settleHarness(org, { disputeAccounts: true });
      await settle(h, 10_000);

      const opened = await h.fire({
        id: `evt_dp_open_${randomUUID().slice(0, 8)}`,
        type: "charge.dispute.created",
        data: {
          object: {
            id: "dp_invoice_settled",
            payment_intent: h.intentId,
            amount: 10_000,
            currency: "cad",
            reason: "fraudulent",
          },
        },
      });
      assert.equal(opened?.status, "disputed_posted");
      const dispute = (await disputeRows(h.orgId))[0]!;
      const documents = dispute.documents_posted as string[];
      const holdId = documents.at(-1)!;
      const lines = await db.execute<{ id: string; document_id: string }>(
        sql`
      select jl.id, je.source_document_id as document_id
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${h.orgId} and jl.is_open_item
         and je.source_document_id in (${holdId}, ${h.invoiceId})
    `,
        "objects",
      );
      const holdLine = lines.find((line) => line.document_id === holdId);
      const invoiceLine = lines.find((line) => line.document_id === h.invoiceId);
      assert.ok(
        holdLine && invoiceLine,
        "the posted hold and invoice retain their open-item lines",
      );

      await applyPaymentToOpenItem(h.orgId, {
        fromLineId: holdLine.id,
        toLineId: invoiceLine.id,
        amount: "100.0000",
        currency: "CAD",
        reference: "settle the invoice before the provider reports the lost dispute",
      });
      assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "0.0000");

      const lost = await h.fire({
        id: `evt_dp_lost_${randomUUID().slice(0, 8)}`,
        type: "charge.dispute.closed",
        data: {
          object: {
            id: "dp_invoice_settled",
            payment_intent: h.intentId,
            amount: 10_000,
            currency: "cad",
            status: "lost",
          },
        },
      });
      assert.equal(lost?.status, "disputed_posted");

      const loss = (
        await db.execute<{ debit: string }>(
          sql`
      select coalesce(sum(case when jl.amount > 0 then jl.amount else 0 end), 0)::text as debit
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
       where jl.org_id = ${h.orgId} and a.name = 'Chargeback Losses' and je.status in ('posted', 'reversed')
    `,
          "objects",
        )
      )[0]!;
      assert.equal(loss.debit, "100.0000", "the loss reflects the full provider chargeback amount");
      const clearing = (
        await db.execute<{ balance: string }>(
          sql`
      select coalesce(sum(jl.amount), 0)::text as balance
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
       where jl.org_id = ${h.orgId} and a.name = 'Disputed Funds Clearing' and je.status in ('posted', 'reversed')
    `,
          "objects",
        )
      )[0]!;
      assert.equal(clearing.balance, "0.0000", "the full disputed-funds balance is cleared");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a foreign-currency dispute loss posts at the hold receipt's rate with the rate as evidence",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId}, 'EUR', 'CAD', '2000-01-01', 'spot', '1.5', 'test')`);
      const h = await settleHarness(org, { disputeAccounts: true, currency: "EUR" });
      await settle(h, 10_000, "eur");
      const dispute = { id: "dp_fx", payment_intent: h.intentId, amount: 10_000, currency: "eur" };
      const opened = await h.fire({
        id: `evt_dp_open_${randomUUID().slice(0, 8)}`,
        type: "charge.dispute.created",
        data: { object: { ...dispute, reason: "fraudulent" } },
      });
      assert.equal(opened?.status, "disputed_posted");
      const lost = await h.fire({
        id: `evt_dp_lost_${randomUUID().slice(0, 8)}`,
        type: "charge.dispute.closed",
        data: { object: { ...dispute, status: "lost" } },
      });
      assert.equal(lost?.status, "disputed_posted");

      const lossLine = await db.execute<{
        amount: string;
        currency: string;
        txn_amount: string;
        fx_rate: string;
        evidence: { rate: string; source: string } | null;
      }>(
        sql`
      select jl.amount::text, jl.currency, jl.txn_amount::text, jl.fx_rate::text, je.custom->'fxEvidence' as evidence
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
       where jl.org_id = ${h.orgId} and a.name = 'Chargeback Losses'`,
        "objects",
      );
      assert.equal(lossLine.length, 1);
      assert.deepEqual(
        {
          currency: lossLine[0]!.currency,
          txn: lossLine[0]!.txn_amount,
          amount: lossLine[0]!.amount,
          rate: Number(lossLine[0]!.fx_rate),
        },
        { currency: "EUR", txn: "100.0000", amount: "150.0000", rate: 1.5 },
      );
      assert.equal(lossLine[0]!.evidence?.source, "dispute_hold_receipt");
      assert.equal(Number(lossLine[0]!.evidence?.rate), 1.5);

      const clearing = (
        await db.execute<{ functional: string; txn: string }>(
          sql`
      select coalesce(sum(jl.amount), 0)::text as functional, coalesce(sum(jl.txn_amount), 0)::text as txn
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
       where jl.org_id = ${h.orgId} and a.name = 'Disputed Funds Clearing' and je.status in ('posted', 'reversed')`,
          "objects",
        )
      )[0];
      assert.deepEqual(clearing, { functional: "0.0000", txn: "0.0000" });
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("a duplicate refund event is a no-op", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org);
    await settle(h, 10_000);
    const event = {
      id: `evt_dup_${randomUUID().slice(0, 8)}`,
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          payment_intent: h.intentId,
          amount_refunded: 10_000,
          amount: 10_000,
          currency: "cad",
        },
      },
    };
    assert.equal((await h.fire(event))?.status, "refunded_posted");
    assert.equal((await h.fire(event))?.status, "refunded_duplicate");

    const reversals = (
      await db.execute<{ n: number }>(
        sql`
      select count(*)::int as n from documents
       where org_id = ${h.orgId} and kind = 'customer_payment' and status = 'voided'`,
        "objects",
      )
    )[0];
    assert.equal(reversals!.n, 1);
    assert.equal((await disputeRows(h.orgId)).length, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a refund parked before settlement posts when the payment lands", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org);
    const parked = await h.fire({
      id: `evt_park_${randomUUID().slice(0, 8)}`,
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          payment_intent: h.intentId,
          amount_refunded: 10_000,
          amount: 10_000,
          currency: "cad",
        },
      },
    });
    assert.equal(parked?.status, "pending_clawback");

    const outcome = await h.fire({
      id: `evt_late_${randomUUID().slice(0, 8)}`,
      type: "checkout.session.completed",
      data: {
        object: {
          id: h.sessionId,
          client_reference_id: h.linkToken,
          payment_intent: h.intentId,
          amount_total: 10_000,
          currency: "cad",
          payment_status: "paid",
        },
      },
    });
    assert.equal(outcome?.status, "settled");
    // The parked return posted instead of noting: the receipt reversed and
    // the invoice reopened.
    assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "100.0000");
    const rows = await disputeRows(h.orgId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "posted");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test(
  "the tenant return Flow holds a full refund until its native approval",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const h = await settleHarness(org, { reviewFlow: true });
      await settle(h, 10_000);
      const queued = await h.fire({
        id: `evt_rev_${randomUUID().slice(0, 8)}`,
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_1",
            payment_intent: h.intentId,
            amount_refunded: 10_000,
            amount: 10_000,
            currency: "cad",
          },
        },
      });
      assert.equal(queued?.status, "refunded_pending_review");
      assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "0.0000");

      const rows = await disputeRows(h.orgId);
      assert.equal(rows[0]!.status, "pending_review");

      const approved = await decideProviderReview(h.orgId, rows[0]!.id, h.userId, "approved");
      assert.equal(approved.status, "posted");
      assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "100.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("a rejected review moves no money", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org, { reviewFlow: true });
    await settle(h, 10_000);
    await h.fire({
      id: `evt_rej_${randomUUID().slice(0, 8)}`,
      type: "charge.refunded",
      data: {
        object: {
          id: "ch_1",
          payment_intent: h.intentId,
          amount_refunded: 10_000,
          amount: 10_000,
          currency: "cad",
        },
      },
    });
    const rows = await disputeRows(h.orgId);
    await decideProviderReview(
      h.orgId,
      rows[0]!.id,
      h.userId,
      "rejected",
      "Customer confirmed the charge is legitimate",
    );
    const after = await disputeRows(h.orgId);
    assert.equal(after[0]!.status, "rejected");
    assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "0.0000");
    const receipts = (
      await db.execute<{ n: number }>(
        sql`
      select count(*)::int as n from documents where org_id = ${h.orgId} and kind = 'customer_payment'`,
        "objects",
      )
    )[0];
    assert.equal(receipts!.n, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
