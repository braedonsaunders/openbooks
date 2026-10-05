import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson, sealSecret } from "../platform/secrets.ts";
import { handleProviderWebhook } from "./acceptance.ts";
import { postDocument } from "../ledger/posting-document.ts";
import {
  approveDisputeReview,
  rejectDisputeReview,
} from "./psp-refund-automation.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function signedStripeBody(secret: string, event: unknown): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  return { body, headers: { "stripe-signature": `t=${t},v1=${v1}` } };
}

async function ensureOpenPeriod(orgId: string, periodId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const [year, month] = today.split("-").map(Number) as [number, number, number];
  await db.execute(sql`
    insert into accounting_periods
      (org_id, fiscal_calendar_id, fiscal_year, period_number, name,
       starts_on, ends_on, is_adjustment)
    select ${orgId}, fiscal_calendar_id, ${year}, ${month}, ${today.slice(0, 7)},
           ${`${year}-${String(month).padStart(2, "0")}-01`},
           ${new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)}, false
      from accounting_periods
     where id = ${periodId}
    on conflict (org_id, fiscal_calendar_id, fiscal_year, period_number) do nothing
  `);
}

async function makeAccount(orgId: string, number: string, name: string, type: string): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  return id;
}

type Harness = {
  orgId: string;
  userId: string;
  invoiceId: string;
  linkToken: string;
  intentId: string;
  sessionId: string;
  attemptId: string;
  secret: string;
  fire: (event: unknown) => ReturnType<typeof handleProviderWebhook>;
};

async function settleHarness(org: Awaited<ReturnType<typeof createScratchOrg>>, opts: {
  invoiceTotal?: string;
  currency?: string;
  policy?: "automatic" | "review";
  disputeAccounts?: boolean;
} = {}): Promise<Harness> {
  const total = opts.invoiceTotal ?? "100";
  const currency = opts.currency ?? "CAD";
  const userId = await createScratchUser(org.orgId, "Refund Tester", "admin");
  await db.execute(sql`
    update orgs set settings = settings || '{"features":{"onlinePayments":true}}'::jsonb where id = ${org.orgId}`);
  await ensureOpenPeriod(org.orgId, org.periodId);

  const invoiceId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${`INV-${randomUUID().slice(0, 8)}`},
            ${org.subsidiaryId}, ${org.customerId}, ${org.date}, ${currency}, '1',
            ${total}, '0', ${total}, ${userId})`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', ${total}, ${total}, '0', '0')`);
  await db.execute(sql`update documents set status = 'approved', updated_at = now() where id = ${invoiceId} and org_id = ${org.orgId}`);
  await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });

  const secret = `whsec_auto_${randomUUID()}`;
  await db.execute(sql`
    insert into psp_provider_configs
      (org_id, provider, display_name, is_enabled, acceptance_enabled,
       default_bank_account_id, secrets, created_by, updated_by)
    values (${org.orgId}, 'stripe', 'Stripe', true, true,
            ${org.accounts.bank}, ${sealJson({ apiKey: "sk_test_auto", webhookSecret: secret }, { orgId: org.orgId, purpose: "payment.provider.secrets" })}, ${userId}, ${userId})`);
  if (opts.policy === "review") {
    await db.execute(sql`update psp_provider_configs set refund_policy = 'review' where org_id = ${org.orgId} and provider = 'stripe'`);
  }
  if (opts.disputeAccounts) {
    const disputedFunds = await makeAccount(org.orgId, "1150", "Disputed Funds Clearing", "asset_current_other");
    const loss = await makeAccount(org.orgId, "7020", "Chargeback Losses", "expense");
    const fee = await makeAccount(org.orgId, "7030", "Dispute Fees", "expense");
    await db.execute(sql`
      update psp_provider_configs
         set default_disputed_funds_account_id = ${disputedFunds},
             default_chargeback_loss_account_id = ${loss},
             default_dispute_fee_account_id = ${fee}
       where org_id = ${org.orgId} and provider = 'stripe'`);
  }
  const linkId = randomUUID(), linkToken = `auto-link-${randomUUID()}`;
  const sessionId = `cs_test_auto_${randomUUID().slice(0, 8)}`;
  const intentId = `pi_auto_${randomUUID().slice(0, 8)}`;
  await db.execute(sql`
    insert into payment_links
      (id, org_id, token_hash, token_sealed, document_id, party_id, subsidiary_id, provider,
       bank_account_id, amount, surcharge_amount, currency, created_by, updated_by)
    values (${linkId}, ${org.orgId}, ${createHash("sha256").update(linkToken, "utf8").digest("hex")}, ${sealSecret(linkToken, { orgId: org.orgId, purpose: "payment.link.token" })}, ${invoiceId}, ${org.customerId},
            ${org.subsidiaryId}, 'stripe', ${org.accounts.bank}, ${total}, '0', ${currency},
            ${userId}, ${userId})`);
  const attemptId = randomUUID();
  await db.execute(sql`
    insert into payment_attempts (id, org_id, link_id, provider, external_ref, status, amount, surcharge_amount)
    values (${attemptId}, ${org.orgId}, ${linkId}, 'stripe', ${sessionId}, 'initiated', ${total}, '0')`);
  const fire = (event: unknown) => {
    const signed = signedStripeBody(secret, event);
    return handleProviderWebhook("stripe", signed.headers, signed.body);
  };
  return { orgId: org.orgId, userId, invoiceId, linkToken, intentId, sessionId, attemptId, secret, fire };
}

async function settle(h: Harness, minor: number, currency = "cad"): Promise<void> {
  const event = {
    id: `evt_settle_${randomUUID().slice(0, 8)}`,
    type: "checkout.session.completed",
    data: {
      object: {
        id: h.sessionId,
        client_reference_id: h.linkToken,
        payment_intent: h.intentId,
        amount_total: minor,
        currency,
        payment_status: "paid",
      },
    },
  };
  const outcome = await h.fire(event);
  assert.equal(outcome?.status, "settled");
}

async function invoiceOpen(orgId: string, invoiceId: string): Promise<string> {
  const row = (await db.execute<{ open_balance: string }>(sql`
    select open_balance::text from documents where id = ${invoiceId} and org_id = ${orgId}`)).rows[0];
  return row!.open_balance;
}

async function disputeRows(orgId: string): Promise<{ id: string; kind: string; status: string; documents_posted: unknown }[]> {
  return (await db.execute<{ id: string; kind: string; status: string; documents_posted: unknown }>(sql`
    select id, kind, status, documents_posted from payment_disputes where org_id = ${orgId} order by created_at`)).rows;
}

test("a full refund reverses the receipt and reopens the invoice", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org);
    await settle(h, 10_000);
    assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "0.0000");

    const refunded = await h.fire({
      id: `evt_refund_${randomUUID().slice(0, 8)}`,
      type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: h.intentId, amount_refunded: 10_000, amount: 10_000, currency: "cad" } },
    });
    assert.equal(refunded?.status, "refunded_posted");
    assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "100.0000");

    const rows = await disputeRows(h.orgId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.kind, "refund");
    assert.equal(rows[0]!.status, "posted");
    assert.equal((rows[0]!.documents_posted as string[]).length, 1);

    const attempt = (await db.execute<{ status: string }>(sql`
      select status from payment_attempts where id = ${h.attemptId} and org_id = ${h.orgId}`)).rows[0];
    assert.equal(attempt!.status, "refunded");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a partial refund posts the exact amount and reissues the remainder", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org);
    await settle(h, 10_000);

    const refunded = await h.fire({
      id: `evt_refund_${randomUUID().slice(0, 8)}`,
      type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: h.intentId, amount_refunded: 3_000, amount: 10_000, currency: "cad" } },
    });
    assert.equal(refunded?.status, "refunded_posted");
    // The invoice reopens by the refunded 30, not the full 100.
    assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "30.0000");

    const receipts = (await db.execute<{ total: string; status: string }>(sql`
      select total::text as total, status from documents
       where org_id = ${h.orgId} and kind = 'customer_payment' order by created_at`)).rows;
    const postedTotals = receipts.filter((r) => r.status === "posted").map((r) => r.total);
    assert.deepEqual(postedTotals, ["70.0000"]);

    const rows = await disputeRows(h.orgId);
    assert.equal(rows.length, 1);
    assert.equal((rows[0]!.documents_posted as string[]).length, 2);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a dispute opened then lost posts the loss and settles the invoice", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org, { disputeAccounts: true });
    await settle(h, 10_000);

    const opened = await h.fire({
      id: `evt_dp_open_${randomUUID().slice(0, 8)}`,
      type: "charge.dispute.created",
      data: { object: { id: "dp_1", payment_intent: h.intentId, amount: 10_000, currency: "cad", reason: "fraudulent" } },
    });
    assert.equal(opened?.status, "disputed_posted");
    assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "100.0000");

    const lost = await h.fire({
      id: `evt_dp_lost_${randomUUID().slice(0, 8)}`,
      type: "charge.dispute.closed",
      data: { object: { id: "dp_1", payment_intent: h.intentId, amount: 10_000, currency: "cad", status: "lost" } },
    });
    assert.equal(lost?.status, "disputed_posted");
    // The customer owes nothing: the held funds settled the invoice.
    assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "0.0000");

    const loss = (await db.execute<{ debit: string; credit: string }>(sql`
      select sum(case when jl.amount > 0 then jl.amount else 0 end)::text as debit,
             sum(case when jl.amount < 0 then -jl.amount else 0 end)::text as credit
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
       where jl.org_id = ${h.orgId} and a.name = 'Chargeback Losses' and je.status in ('posted', 'reversed')`)).rows[0];
    assert.equal(loss!.debit, "100.0000");

    const clearing = (await db.execute<{ balance: string }>(sql`
      select coalesce(sum(jl.amount), 0)::text as balance
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
       where jl.org_id = ${h.orgId} and a.name = 'Disputed Funds Clearing' and je.status in ('posted', 'reversed')`)).rows[0];
    assert.equal(clearing!.balance, "0.0000");

    const rows = await disputeRows(h.orgId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.status, "lost");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a foreign-currency dispute loss posts at the hold receipt's rate with the rate as evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId}, 'EUR', 'CAD', '2000-01-01', 'spot', '1.5', 'test')`);
    const h = await settleHarness(org, { disputeAccounts: true, currency: "EUR" });
    await settle(h, 10_000, "eur");
    const dispute = { id: "dp_fx", payment_intent: h.intentId, amount: 10_000, currency: "eur" };
    const opened = await h.fire({ id: `evt_dp_open_${randomUUID().slice(0, 8)}`, type: "charge.dispute.created", data: { object: { ...dispute, reason: "fraudulent" } } });
    assert.equal(opened?.status, "disputed_posted");
    const lost = await h.fire({ id: `evt_dp_lost_${randomUUID().slice(0, 8)}`, type: "charge.dispute.closed", data: { object: { ...dispute, status: "lost" } } });
    assert.equal(lost?.status, "disputed_posted");

    const lossLine = (await db.execute<{ amount: string; currency: string; txn_amount: string; fx_rate: string; evidence: { rate: string; source: string } | null }>(sql`
      select jl.amount::text, jl.currency, jl.txn_amount::text, jl.fx_rate::text, je.custom->'fxEvidence' as evidence
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
       where jl.org_id = ${h.orgId} and a.name = 'Chargeback Losses'`)).rows;
    assert.equal(lossLine.length, 1);
    assert.deepEqual(
      { currency: lossLine[0]!.currency, txn: lossLine[0]!.txn_amount, amount: lossLine[0]!.amount, rate: Number(lossLine[0]!.fx_rate) },
      { currency: "EUR", txn: "100.0000", amount: "150.0000", rate: 1.5 },
    );
    assert.equal(lossLine[0]!.evidence?.source, "dispute_hold_receipt");
    assert.equal(Number(lossLine[0]!.evidence?.rate), 1.5);

    const clearing = (await db.execute<{ functional: string; txn: string }>(sql`
      select coalesce(sum(jl.amount), 0)::text as functional, coalesce(sum(jl.txn_amount), 0)::text as txn
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
        join accounts a on a.id = jl.account_id and a.org_id = jl.org_id
       where jl.org_id = ${h.orgId} and a.name = 'Disputed Funds Clearing' and je.status in ('posted', 'reversed')`)).rows[0];
    assert.deepEqual(clearing, { functional: "0.0000", txn: "0.0000" });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a duplicate refund event is a no-op", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org);
    await settle(h, 10_000);
    const event = {
      id: `evt_dup_${randomUUID().slice(0, 8)}`,
      type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: h.intentId, amount_refunded: 10_000, amount: 10_000, currency: "cad" } },
    };
    assert.equal((await h.fire(event))?.status, "refunded_posted");
    assert.equal((await h.fire(event))?.status, "refunded_duplicate");

    const reversals = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from documents
       where org_id = ${h.orgId} and kind = 'customer_payment' and status = 'voided'`)).rows[0];
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
      data: { object: { id: "ch_1", payment_intent: h.intentId, amount_refunded: 10_000, amount: 10_000, currency: "cad" } },
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

test("review policy parks the refund until approved or rejected", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org, { policy: "review" });
    await settle(h, 10_000);
    const queued = await h.fire({
      id: `evt_rev_${randomUUID().slice(0, 8)}`,
      type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: h.intentId, amount_refunded: 10_000, amount: 10_000, currency: "cad" } },
    });
    assert.equal(queued?.status, "refunded_pending_review");
    assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "0.0000");

    const rows = await disputeRows(h.orgId);
    assert.equal(rows[0]!.status, "pending_review");

    const approved = await approveDisputeReview(h.orgId, rows[0]!.id, h.userId);
    assert.equal(approved.status, "posted");
    assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "100.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a rejected review moves no money", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const h = await settleHarness(org, { policy: "review" });
    await settle(h, 10_000);
    await h.fire({
      id: `evt_rej_${randomUUID().slice(0, 8)}`,
      type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: h.intentId, amount_refunded: 10_000, amount: 10_000, currency: "cad" } },
    });
    const rows = await disputeRows(h.orgId);
    await rejectDisputeReview(h.orgId, rows[0]!.id, h.userId, "customer confirmed the charge is legitimate");
    const after = await disputeRows(h.orgId);
    assert.equal(after[0]!.status, "rejected");
    assert.equal(await invoiceOpen(h.orgId, h.invoiceId), "0.0000");
    const receipts = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from documents where org_id = ${h.orgId} and kind = 'customer_payment'`)).rows[0];
    assert.equal(receipts!.n, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
