import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import { endOfMonth } from "../platform/civil-date.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
import { submitAndReleaseIfUngated } from "../flows/submit.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { sameCurrencyAllocation } from "./settlement-policy.ts";
import { openItemsForParty } from "./payment-queries.ts";
import {
  AutopayError,
  classifyDecline,
  enrollAutopay,
  listPaymentMethods,
  parseFinalAction,
  parseRetryOffsetsDays,
  runAutopayCollectionForOrg,
  setMethodFallbackPriority,
  type ChargeFn,
} from "./autopay.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const priorDataKey = process.env.OPENBOOKS_DATA_KEY;

before(() => {
  process.env.OPENBOOKS_DATA_KEY = "00".repeat(32);
});

after(() => {
  if (priorDataKey === undefined) delete process.env.OPENBOOKS_DATA_KEY;
  else process.env.OPENBOOKS_DATA_KEY = priorDataKey;
});

test("decline classification and policy parsing are pure and strict", () => {
  assert.equal(classifyDecline(null), null);
  assert.equal(classifyDecline(""), null);
  assert.equal(classifyDecline("stolen_card"), "hard");
  assert.equal(classifyDecline("closed_account"), "hard");
  assert.equal(classifyDecline("mandate_cancelled"), "hard");
  assert.equal(classifyDecline("insufficient_funds"), "insufficient_funds");
  assert.equal(classifyDecline("some_future_code"), "soft");
  assert.deepEqual(parseRetryOffsetsDays([1, 3, 7]), [1, 3, 7]);
  assert.deepEqual(parseRetryOffsetsDays([]), []);
  assert.throws(() => parseRetryOffsetsDays("nope"), AutopayError);
  assert.throws(() => parseRetryOffsetsDays([0]), AutopayError);
  assert.throws(() => parseRetryOffsetsDays([1.5]), AutopayError);
  assert.equal(parseFinalAction("suspend"), "suspend");
  assert.throws(() => parseFinalAction("email"), AutopayError);
});

interface AutopayFixture {
  org: Awaited<ReturnType<typeof createScratchOrg>>;
  userId: string;
}

/** Scratch org with autopay + onlinePayments on, receipts postable today. */
async function seedAutopayOrg(): Promise<AutopayFixture> {
  const org = await createScratchOrg();
  const userId = await createScratchUser(org.orgId, "Autopay Tester", "admin");
  await db.execute(sql`
    update orgs set settings = settings || '{"features":{"onlinePayments":true,"autopay":true}}'::jsonb
     where id = ${org.orgId}
  `);
  const today = new Date().toISOString().slice(0, 10);
  if (today < "2026-07-01" || today > "2026-07-31") {
    const [year, month] = today.split("-").map(Number) as [number, number, number];
    const startsOn = `${year}-${String(month).padStart(2, "0")}-01`;
    const endsOn = endOfMonth(startsOn);
    await db.execute(sql`
      insert into accounting_periods
        (org_id, fiscal_calendar_id, fiscal_year, period_number, name,
         starts_on, ends_on, is_adjustment)
      select ${org.orgId}, fiscal_calendar_id, ${year}, ${month}, ${today.slice(0, 7)},
             ${startsOn}, ${endsOn}, false
        from accounting_periods
       where id = ${org.periodId}
      on conflict (org_id, fiscal_calendar_id, fiscal_year, period_number) do nothing
    `);
  }
  await db.execute(sql`
    insert into psp_provider_configs
      (org_id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id, secrets, created_by, updated_by)
    values (${org.orgId}, 'stripe', 'Stripe', true, true, ${org.accounts.bank},
            ${sealJson({ apiKey: "sk_test_autopay", webhookSecret: "whsec_autopay" }, { orgId: org.orgId, purpose: "payment.provider.secrets" })}, ${userId}, ${userId})`);
  return { org, userId };
}

async function seedPolicy(orgId: string, userId: string, retryOffsets: number[], finalAction: string): Promise<void> {
  await db.execute(sql`
    insert into dunning_policies
      (org_id, name, applies_to_kind, is_active, autopay_retry_offsets_days, autopay_final_action, created_by, updated_by)
    values (${orgId}, 'Collections', 'customer_invoice', true,
            ${`{${retryOffsets.join(",")}}`}::integer[], ${finalAction}, ${userId}, ${userId})
  `);
}

/** Posted customer invoice for the scratch customer, due on the given date. */
async function seedInvoice(fixture: AutopayFixture, memo: string, total: string, dueDate: string): Promise<string> {
  const { org, userId } = fixture;
  const invoiceId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, due_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${memo},
            ${org.subsidiaryId}, ${org.customerId}, ${dueDate}, ${dueDate}, 'CAD', '1',
            ${total}, '0', ${total}, ${userId})`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', ${total}, ${total}, '0', '0')`);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now()
     where id = ${invoiceId} and org_id = ${org.orgId}`);
  await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
  return invoiceId;
}

/** Active default stripe method on file for the scratch customer. */
async function seedMethod(fixture: AutopayFixture): Promise<string> {
  const { org, userId } = fixture;
  const rows = (await db.execute<{ id: string }>(sql`
    insert into customer_payment_methods
      (org_id, party_id, provider, provider_customer_id, provider_method_id,
       brand, last4, exp_month, exp_year, is_default, status, created_by, updated_by)
    values (${org.orgId}, ${org.customerId}, 'stripe', 'cus_test', 'pm_test',
            'visa', '4242', 12, 2030, true, 'active', ${userId}, ${userId})
    returning id
  `)).rows;
  return rows[0]!.id;
}

/** Pay an invoice in full through the manual receipt path (another channel). */
async function payManually(fixture: AutopayFixture, invoiceId: string): Promise<void> {
  const { org, userId } = fixture;
  const invoice = (await db.execute<{ open_balance: string; currency: string; subsidiary_id: string }>(sql`
    select open_balance, currency, subsidiary_id from documents where id = ${invoiceId} and org_id = ${org.orgId}
  `)).rows[0]!;
  const openItems = await openItemsForParty(org.customerId, "ar", org.orgId);
  const item = openItems.find((i) => i.documentId === invoiceId)!;
  const payment = await createPaymentDocument({
    orgId: org.orgId,
    kind: "customer_payment",
    createdBy: userId,
    allowedSubsidiaryIds: null,
    partyId: org.customerId,
    bankAccountId: org.accounts.bank,
    documentDate: org.date,
    subsidiaryId: invoice.subsidiary_id,
    currency: invoice.currency,
  });
  const allocations = [sameCurrencyAllocation(item.lineId, invoice.open_balance)];
  await updateDraftPayment(payment.id, { allocations, onAccountAmount: "0.0000" }, userId, org.orgId);
  const submission = await submitAndReleaseIfUngated("customer_payment", payment.id, userId);
  assert.equal(submission.gated, false);
  await postPaymentWithApplications(payment.id, allocations, userId);
}

type FakeOutcome = { status: "succeeded" } | { status: "failed"; declineCode?: string };

function fakeCharge(resolve: (req: { amount: string }, n: number) => FakeOutcome): { charge: ChargeFn; calls: unknown[] } {
  const calls: unknown[] = [];
  let n = 0;
  const charge: ChargeFn = async (_provider, req) => {
    calls.push(req);
    n += 1;
    const outcome = resolve({ amount: req.amount }, n);
    if (outcome.status === "succeeded") return { status: "succeeded", providerRef: `ch_fake_${n}` };
    return { status: "failed", providerRef: `ch_fake_${n}`, declineCode: outcome.declineCode ?? "insufficient_funds" };
  };
  return { charge, calls };
}

const succeedAll = () => ({ status: "succeeded" }) as FakeOutcome;

async function openBalance(orgId: string, invoiceId: string): Promise<string> {
  return (await db.execute<{ open_balance: string }>(sql`
    select open_balance from documents where id = ${invoiceId} and org_id = ${orgId}
  `)).rows[0]!.open_balance;
}



test("a due invoice is charged once; success posts the receipt and closes the invoice", { skip: !DB }, async () => {
  const fixture = await seedAutopayOrg();
  const { org, userId } = fixture;
  try {
    await seedPolicy(org.orgId, userId, [1, 3], "none");
    await seedMethod(fixture);
    await enrollAutopay(org.orgId, { partyId: org.customerId, actorId: userId });
    const invoiceId = await seedInvoice(fixture, "INV-AUTO-1", "100", org.date);

    const fake = fakeCharge(succeedAll);
    const first = await runAutopayCollectionForOrg(org.orgId, { asOf: org.date, charge: fake.charge });
    assert.equal(first.charged, 1);
    assert.equal(first.succeeded, 1);
    assert.equal(fake.calls.length, 1);

    const attempt = (await db.execute<{ status: string; receipt_document_id: string | null; amount: string }>(sql`
      select status, receipt_document_id, amount from collection_attempts
       where org_id = ${org.orgId} and invoice_id = ${invoiceId}
    `)).rows[0]!;
    assert.equal(attempt.status, "succeeded");
    assert.ok(attempt.receipt_document_id);
    assert.equal(attempt.amount, "100.0000");
    assert.equal(await openBalance(org.orgId, invoiceId), "0.0000");

    // A second tick must not charge again: the position-0 attempt owns it.
    const second = await runAutopayCollectionForOrg(org.orgId, { asOf: org.date, charge: fake.charge });
    assert.equal(second.charged, 0);
    assert.equal(fake.calls.length, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

type ChargeAttemptRow = { id: string; status: string; provider_ref: string | null; receipt_document_id: string | null; decline_code: string | null };

async function attemptFor(orgId: string, invoiceId: string): Promise<ChargeAttemptRow> {
  return (await db.execute<ChargeAttemptRow>(sql`
    select id, status, provider_ref, receipt_document_id, decline_code from collection_attempts
     where org_id = ${orgId} and invoice_id = ${invoiceId} and retry_position = 0
  `)).rows[0]!;
}

test("one invoice's failed outcome write cannot erase another's charge; the next tick replays it under the same key", { skip: !DB }, async () => {
  const fixture = await seedAutopayOrg();
  const { org, userId } = fixture;
  try {
    await seedPolicy(org.orgId, userId, [1, 3], "none");
    await seedMethod(fixture);
    await enrollAutopay(org.orgId, { partyId: org.customerId, actorId: userId });
    const keptId = await seedInvoice(fixture, "INV-AUTO-KEPT", "100", org.date);
    const brokenId = await seedInvoice(fixture, "INV-AUTO-BROKEN", "200", org.date);

    // The provider takes both charges, but the first answer for the 200
    // invoice carries a reference the database refuses (a NUL byte), so
    // recording that outcome fails with a SQL error mid-tick.
    const calls: { amount: string; key: string }[] = [];
    const charge: ChargeFn = async (_provider, req) => {
      calls.push({ amount: req.amount, key: req.idempotencyKey });
      const poisoned = req.amount.startsWith("200") && calls.filter((c) => c.amount === req.amount).length === 1;
      return { status: "succeeded", providerRef: poisoned ? "ch_bad\u0000ref" : `ch_${req.amount}` };
    };
    const first = await runAutopayCollectionForOrg(org.orgId, { asOf: org.date, charge });
    assert.equal(calls.length, 2);

    const kept = await attemptFor(org.orgId, keptId);
    assert.equal(kept.status, "succeeded");
    assert.equal(kept.provider_ref, "ch_100.0000");
    assert.ok(kept.receipt_document_id);
    assert.equal(await openBalance(org.orgId, keptId), "0.0000");

    const broken = await attemptFor(org.orgId, brokenId);
    assert.equal(broken.status, "initiated");
    assert.equal(broken.provider_ref, null);
    const brokenNotice = first.notices.find((n) => n.invoiceId === brokenId);
    assert.match(brokenNotice?.detail ?? "", /INV-AUTO-BROKEN, but the outcome could not be recorded \(invalid byte sequence.*same idempotency key/);
    assert.ok(first.orgErrors.some((e) => e.error.includes("INV-AUTO-BROKEN")));

    const brokenKey = calls.find((c) => c.amount === "200.0000")!.key;
    assert.notEqual(brokenKey, broken.id, "the provider key is derived from the position, not the random row id");
    assert.notEqual(brokenKey, calls.find((c) => c.amount === "100.0000")!.key);

    // Next tick: the collected invoice is never charged again; the open
    // attempt replays under the key it was first sent with and settles.
    const second = await runAutopayCollectionForOrg(org.orgId, { asOf: org.date, charge });
    assert.deepEqual(calls.slice(2), [{ amount: "200.0000", key: brokenKey }]);
    assert.equal(second.succeeded, 1);
    const settled = await attemptFor(org.orgId, brokenId);
    assert.equal(settled.id, broken.id);
    assert.equal(settled.status, "succeeded");
    assert.equal(settled.provider_ref, "ch_200.0000");
    assert.equal(await openBalance(org.orgId, brokenId), "0.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a failed receipt or an unanswered charge keeps its attempt; the next tick finishes it without a second charge", { skip: !DB }, async () => {
  const fixture = await seedAutopayOrg();
  const { org, userId } = fixture;
  try {
    await seedPolicy(org.orgId, userId, [1, 3], "none");
    await seedMethod(fixture);
    await enrollAutopay(org.orgId, { partyId: org.customerId, actorId: userId });
    const collectedId = await seedInvoice(fixture, "INV-AUTO-RCPT", "100", org.date);
    const lostId = await seedInvoice(fixture, "INV-AUTO-LOST", "300", org.date);
    // No receipt can post while the provider has no bank account.
    await db.execute(sql`update psp_provider_configs set default_bank_account_id = null where org_id = ${org.orgId}`);

    const calls: { amount: string; key: string }[] = [];
    const charge: ChargeFn = async (_provider, req) => {
      calls.push({ amount: req.amount, key: req.idempotencyKey });
      if (req.amount.startsWith("300")) throw new Error("socket hang up");
      return { status: "succeeded", providerRef: "ch_collected" };
    };
    const first = await runAutopayCollectionForOrg(org.orgId, { asOf: org.date, charge });
    assert.equal(calls.length, 2);
    const collected = await attemptFor(org.orgId, collectedId);
    assert.equal(collected.provider_ref, "ch_collected", "the provider evidence survives the failed receipt");
    assert.equal(collected.receipt_document_id, null);
    assert.match(first.notices.find((n) => n.invoiceId === collectedId)?.detail ?? "", /ch_collected.*no default bank account/);
    const lost = await attemptFor(org.orgId, lostId);
    assert.equal(lost.status, "initiated");
    assert.match(first.notices.find((n) => n.invoiceId === lostId)?.detail ?? "", /did not confirm the charge.*socket hang up/);

    // The unanswered attempt is now older than providers keep its key, so it
    // must be closed for review rather than sent again.
    await db.execute(sql`
      update collection_attempts set created_at = created_at - interval '2 days'
       where org_id = ${org.orgId} and invoice_id = ${lostId}
    `);
    await db.execute(sql`update psp_provider_configs set default_bank_account_id = ${org.accounts.bank} where org_id = ${org.orgId}`);
    const second = await runAutopayCollectionForOrg(org.orgId, { asOf: org.date, charge });
    assert.equal(calls.length, 2, "nothing is charged again");
    const receipted = await attemptFor(org.orgId, collectedId);
    assert.equal(receipted.status, "succeeded");
    assert.ok(receipted.receipt_document_id);
    assert.equal(await openBalance(org.orgId, collectedId), "0.0000");
    const closed = await attemptFor(org.orgId, lostId);
    assert.equal(closed.status, "canceled");
    assert.equal(closed.decline_code, "outcome_unknown");
    const lostKey = calls.find((c) => c.amount === "300.0000")!.key;
    assert.ok(second.orgErrors.some((e) => e.error.includes(lostKey) && e.error.includes("INV-AUTO-LOST")));
    assert.equal(await openBalance(org.orgId, lostId), "300.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a soft decline retries on schedule; a hard decline stops without retry", { skip: !DB }, async () => {
  const fixture = await seedAutopayOrg();
  const { org, userId } = fixture;
  try {
    await seedPolicy(org.orgId, userId, [1, 3], "none");
    await seedMethod(fixture);
    await enrollAutopay(org.orgId, { partyId: org.customerId, actorId: userId });
    const softId = await seedInvoice(fixture, "INV-AUTO-SOFT", "50", org.date);
    const hardId = await seedInvoice(fixture, "INV-AUTO-HARD", "60", org.date);

    // The 50 invoice declines soft (do_not_honor retries on the generic
    // cadence), the 60 invoice declines hard (stolen card).
    const mixed = fakeCharge(({ amount }) =>
      amount.startsWith("60") ? { status: "failed", declineCode: "stolen_card" } : { status: "failed", declineCode: "do_not_honor" },
    );
    const first = await runAutopayCollectionForOrg(org.orgId, { asOf: org.date, charge: mixed.charge });
    assert.equal(first.charged, 2);
    assert.equal(first.retried, 1);
    const softAttempt = (await db.execute<{ status: string; decline_kind: string | null; next_retry_on: string | null }>(sql`
      select status, decline_kind, next_retry_on::text as "next_retry_on" from collection_attempts
       where org_id = ${org.orgId} and invoice_id = ${softId} and retry_position = 0
    `)).rows[0]!;
    assert.equal(softAttempt.status, "failed");
    assert.equal(softAttempt.decline_kind, "soft");
    assert.equal(softAttempt.next_retry_on, "2026-07-16");

    // Same-day tick: nothing due yet — the soft retry waits for tomorrow and the hard decline never retries.
    const sameDay = await runAutopayCollectionForOrg(org.orgId, { asOf: org.date, charge: mixed.charge });
    assert.equal(sameDay.charged, 0);
    assert.equal(mixed.calls.length, 2);
    const hardAttempt = (await db.execute<{ status: string; decline_kind: string | null; next_retry_on: string | null }>(sql`
      select status, decline_kind, next_retry_on::text as "next_retry_on" from collection_attempts
       where org_id = ${org.orgId} and invoice_id = ${hardId} and retry_position = 0
    `)).rows[0]!;
    assert.equal(hardAttempt.decline_kind, "hard");
    assert.equal(hardAttempt.next_retry_on, null);

    // Retry day: the soft invoice charges at position 1 and succeeds.
    const retryDay = await runAutopayCollectionForOrg(org.orgId, { asOf: "2026-07-16", charge: fakeCharge(succeedAll).charge });
    assert.equal(retryDay.charged, 1);
    assert.equal(retryDay.succeeded, 1);
    assert.equal(await openBalance(org.orgId, softId), "0.0000");
    // The hard invoice never retried: still exactly one attempt.
    const hardAttempts = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from collection_attempts where org_id = ${org.orgId} and invoice_id = ${hardId}
    `)).rows[0]!.n;
    assert.equal(hardAttempts, "1");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an invoice paid by another channel is never charged", { skip: !DB }, async () => {
  const fixture = await seedAutopayOrg();
  const { org, userId } = fixture;
  try {
    await seedPolicy(org.orgId, userId, [1], "none");
    await seedMethod(fixture);
    await enrollAutopay(org.orgId, { partyId: org.customerId, actorId: userId });
    const openId = await seedInvoice(fixture, "INV-AUTO-OPEN", "80", org.date);
    const paidId = await seedInvoice(fixture, "INV-AUTO-PAID", "90", org.date);
    await payManually(fixture, paidId);
    assert.equal(await openBalance(org.orgId, paidId), "0.0000");

    const fake = fakeCharge(succeedAll);
    const result = await runAutopayCollectionForOrg(org.orgId, { asOf: org.date, charge: fake.charge });
    assert.equal(result.charged, 1);
    assert.equal(fake.calls.length, 1);
    const paidAttempts = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from collection_attempts where org_id = ${org.orgId} and invoice_id = ${paidId}
    `)).rows[0]!.n;
    assert.equal(paidAttempts, "0");
    assert.equal(await openBalance(org.orgId, openId), "0.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("exhausting the schedule suspends the subscription; a later success reactivates it", { skip: !DB }, async () => {
  const fixture = await seedAutopayOrg();
  const { org, userId } = fixture;
  try {
    await seedPolicy(org.orgId, userId, [1], "suspend");
    await seedMethod(fixture);
    await enrollAutopay(org.orgId, { partyId: org.customerId, actorId: userId });
    const subscriptionId = randomUUID();
    await db.execute(sql`
      insert into subscriptions (id, org_id, customer_id, plan_id, status, start_on, next_bill_on, created_by, updated_by)
      values (${subscriptionId}, ${org.orgId}, ${org.customerId}, ${randomUUID()}, 'active', ${org.date}, ${org.date}, ${userId}, ${userId})
    `);
    const invoiceId = await seedInvoice(fixture, "INV-AUTO-SUB", "70", org.date);

    // A generic-cadence decline: the single-rung [1] ladder exhausts on the
    // retry day and the suspend action fires.
    const failing = fakeCharge(() => ({ status: "failed", declineCode: "do_not_honor" }));
    const day0 = await runAutopayCollectionForOrg(org.orgId, { asOf: org.date, charge: failing.charge });
    assert.equal(day0.charged, 1);
    assert.equal(day0.retried, 1);
    assert.equal(day0.suspended, 0);

    const day1 = await runAutopayCollectionForOrg(org.orgId, { asOf: "2026-07-16", charge: failing.charge });
    assert.equal(day1.charged, 1);
    assert.equal(day1.suspended, 1);
    // The failed invoice still owes in full: declines never move money.
    assert.equal(await openBalance(org.orgId, invoiceId), "70.0000");
    const suspended = (await db.execute<{ status: string }>(sql`
      select status from subscriptions where id = ${subscriptionId} and org_id = ${org.orgId}
    `)).rows[0]!.status;
    assert.equal(suspended, "suspended");
    const suspensionAudit = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from audit_log
       where org_id = ${org.orgId} and table_name = 'subscriptions' and row_id = ${subscriptionId}
    `)).rows[0]!.n;
    assert.equal(suspensionAudit, "1");

    // A later success on a new invoice reactivates billing.
    const secondInvoiceId = await seedInvoice(fixture, "INV-AUTO-SUB2", "30", "2026-07-16");
    const succeeding = fakeCharge(succeedAll);
    const day2 = await runAutopayCollectionForOrg(org.orgId, { asOf: "2026-07-16", charge: succeeding.charge });
    assert.equal(day2.succeeded, 1);
    assert.equal(day2.reactivated, 1);
    const reactivated = (await db.execute<{ status: string }>(sql`
      select status from subscriptions where id = ${subscriptionId} and org_id = ${org.orgId}
    `)).rows[0]!.status;
    assert.equal(reactivated, "active");
    assert.equal(await openBalance(org.orgId, secondInvoiceId), "0.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("enrollment refuses duplicates and everything refuses while the gate is off", { skip: !DB }, async () => {
  const fixture = await seedAutopayOrg();
  const { org, userId } = fixture;
  try {
    await seedPolicy(org.orgId, userId, [1], "none");
    await seedMethod(fixture);
    await enrollAutopay(org.orgId, { partyId: org.customerId, actorId: userId });
    await assert.rejects(
      enrollAutopay(org.orgId, { partyId: org.customerId, actorId: userId }),
      (error: unknown) => error instanceof AutopayError && /already enrolled/.test(error.message),
    );
    await db.execute(sql`
      update orgs set settings = settings || '{"features":{"autopay":false}}'::jsonb where id = ${org.orgId}
    `);
    await assert.rejects(
      enrollAutopay(org.orgId, { partyId: org.customerId, actorId: userId }),
      (error: unknown) => error instanceof AutopayError && /disabled/.test(error.message),
    );
    const fake = fakeCharge(succeedAll);
    await seedInvoice(fixture, "INV-AUTO-OFF", "40", org.date);
    const result = await runAutopayCollectionForOrg(org.orgId, { asOf: org.date, charge: fake.charge });
    assert.equal(result.charged, 0);
    assert.equal(fake.calls.length, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("backup methods order by fallback priority with creation time breaking ties", { skip: !DB }, async () => {
  const { org, userId } = await seedAutopayOrg();
  try {
    const seedBackup = async (providerMethodId: string): Promise<string> => {
      const rows = (await db.execute<{ id: string }>(sql`
        insert into customer_payment_methods
          (org_id, party_id, provider, provider_customer_id, provider_method_id,
           brand, last4, exp_month, exp_year, is_default, status, created_by, updated_by)
        values (${org.orgId}, ${org.customerId}, 'stripe', 'cus_test', ${providerMethodId},
                'visa', '4242', 12, 2030, false, 'active', ${userId}, ${userId})
        returning id`)).rows;
      return rows[0]!.id;
    };
    // Charge order, as the collector reads it: the default first, then
    // active backups by priority with creation time breaking ties.
    const chargeOrder = async (): Promise<string[]> => {
      const methods = await listPaymentMethods(org.orgId, org.customerId);
      return methods
        .filter((method) => !method.isDefault && method.status === "active")
        .sort((a, b) => a.fallbackPriority - b.fallbackPriority || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
        .map((method) => method.id);
    };
    const older = await seedBackup("pm_older");
    const newer = await seedBackup("pm_newer");
    assert.deepEqual(await chargeOrder(), [older, newer]);
    // Moving the older card behind the newer one sticks.
    await setMethodFallbackPriority(org.orgId, older, 1, userId);
    assert.deepEqual(await chargeOrder(), [newer, older]);
    const stored = (await listPaymentMethods(org.orgId, org.customerId)).find((method) => method.id === older)!;
    assert.equal(stored.fallbackPriority, 1);
    // Out-of-range priorities and unknown methods refuse by name.
    await assert.rejects(
      setMethodFallbackPriority(org.orgId, older, 1000, userId),
      (error: unknown) => error instanceof AutopayError && /whole number between 0 and 999/.test(error.message),
    );
    await assert.rejects(
      setMethodFallbackPriority(org.orgId, randomUUID(), 0, userId),
      (error: unknown) => error instanceof AutopayError && /not found/.test(error.message),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
