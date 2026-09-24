import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import {
  checkoutSessionLockKey,
  createCheckoutSession,
  createPaymentLink,
  handleProviderWebhook,
  listPaymentLinks,
  PAYMENT_WEBHOOK_EVENT_FAILURE_LOG_EVENT,
  PAYMENT_WEBHOOK_ITEM_MALFORMED_LOG_EVENT,
  PaymentAcceptanceError,
  PaymentWebhookBatchError,
  publicPaymentPage,
  resolveSurcharge,
  toMinorUnits,
  voidPaymentLink,
} from "./acceptance.ts";
import { add } from "../money/money.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createPaymentDocument, updateDraftPayment } from "./payment-documents.ts";
import { postPaymentWithApplications } from "./payment-posting.ts";
import { sameCurrencyAllocation } from "./settlement-policy.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
// engine/src/platform/secrets.ts reads the data key live from process.env (never the
// engine db.ts module-evaluation snapshot), so seed it there too.
const priorDataKey = process.env.OPENBOOKS_DATA_KEY;

before(() => {
  process.env.OPENBOOKS_DATA_KEY = "00".repeat(32);
});

after(() => {
  if (priorDataKey === undefined) delete process.env.OPENBOOKS_DATA_KEY;
  else process.env.OPENBOOKS_DATA_KEY = priorDataKey;
});

/** Hosted checkout is feature-gated per org; acceptance tests need it on. */
async function enableOnlinePayments(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = settings || '{"features":{"onlinePayments":true}}'::jsonb
     where id = ${orgId}
  `);
}

interface AcceptanceFixture {
  userId: string;
  invoiceId: string;
  link: Awaited<ReturnType<typeof createPaymentLink>>;
}

/** Posted $100 CAD invoice + stripe config + 3% rule + active link. */
async function seedAcceptance(org: Awaited<ReturnType<typeof createScratchOrg>>, memo: string): Promise<AcceptanceFixture> {
  const userId = await createScratchUser(org.orgId, "Pay Tester", "admin");
  await enableOnlinePayments(org.orgId);
  // Receipts post on today's business date; make sure the scratch calendar
  // covers it (the fixture pins its own historical period).
  const today = new Date().toISOString().slice(0, 10);
  if (today < "2026-07-01" || today > "2026-07-31") {
    const [year, month] = today.split("-").map(Number) as [number, number, number];
    const startsOn = `${year}-${String(month).padStart(2, "0")}-01`;
    const endsOn = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
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
  const invoiceId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${memo},
            ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
            '100', '0', '100', ${userId})`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
  await db.execute(sql`
    update documents set status = 'approved', updated_at = now()
     where id = ${invoiceId} and org_id = ${org.orgId}`);
  await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
  await db.execute(sql`
    insert into psp_provider_configs
      (org_id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id, secrets, created_by, updated_by)
    values (${org.orgId}, 'stripe', 'Stripe', true, true, ${org.accounts.bank},
            ${sealJson({ apiKey: "sk_test_itest", webhookSecret: `whsec_${memo}` })}, ${userId}, ${userId})`);
  await db.execute(sql`
    insert into payment_surcharge_rules
      (org_id, name, calculation, percent, fee_income_account_id, provider, payment_method, effective_from, created_by, updated_by)
    values (${org.orgId}, 'Card fee', 'percent', '3', ${org.accounts.revenue}, null, 'all', '2020-01-01', ${userId}, ${userId})`);
  const link = await createPaymentLink(org.orgId, userId, { documentId: invoiceId, provider: "stripe" }, null);
  return { userId, invoiceId, link };
}

function signedStripeBody(
  secret: string,
  sessionId: string,
  linkToken: string,
  amountTotal = 10_300,
  currency = "cad",
): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({
    id: `evt_${sessionId}`,
    type: "checkout.session.completed",
    data: { object: { id: sessionId, client_reference_id: linkToken, amount_total: amountTotal, currency } },
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  return { body, headers: { "stripe-signature": `t=${t},v1=${v1}` } };
}

test("a poison webhook event rolls back without starving its later batch sibling", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const originalConsoleError = console.error;
  const failureLogs: string[] = [];
  try {
    const userId = await createScratchUser(org.orgId, "Poison Batch Tester", "admin");
    const invoiceId = randomUUID();
    const linkId = randomUUID();
    const secret = `gc-poison-${randomUUID()}`;
    const linkToken = `gc-poison-link-${randomUUID()}`;
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total,
         open_balance, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-GC-POISON',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
              '20', '0', '20', '20', ${userId})
    `);
    await db.execute(sql`
      insert into psp_provider_configs
        (org_id, provider, display_name, is_enabled, acceptance_enabled,
         default_bank_account_id, secrets, created_by, updated_by)
      values (${org.orgId}, 'gocardless', 'GoCardless', true, true,
              ${org.accounts.bank}, ${sealJson({ webhookSecret: secret })}, ${userId}, ${userId})
    `);
    await db.execute(sql`
      insert into payment_links
        (id, org_id, token, document_id, party_id, subsidiary_id, provider,
         bank_account_id, amount, surcharge_amount, currency, created_by, updated_by)
      values (${linkId}, ${org.orgId}, ${linkToken}, ${invoiceId}, ${org.customerId},
              ${org.subsidiaryId}, 'gocardless', ${org.accounts.bank}, '20', '0', 'CAD',
              ${userId}, ${userId})
    `);
    await db.execute(sql`
      insert into payment_attempts
        (org_id, link_id, provider, external_ref, status, amount, surcharge_amount)
      values (${org.orgId}, ${linkId}, 'gocardless', 'BRQ-ENGINE-POISON', 'initiated', '10', '0'),
             (${org.orgId}, ${linkId}, 'gocardless', 'BRQ-ENGINE-LATER', 'initiated', '10', '0')
    `);

    const body = JSON.stringify({
      events: [
        {
          resource_type: "payments",
          action: "confirmed",
          links: { payment: "PM-ENGINE-POISON", billing_request: "BRQ-ENGINE-POISON" },
        },
        {
          resource_type: "payments",
          action: "failed",
          links: { payment: "PM-ENGINE-LATER", billing_request: "BRQ-ENGINE-LATER" },
        },
      ],
    });
    const signature = createHmac("sha256", secret).update(body, "utf8").digest("hex");
    let batchError: PaymentWebhookBatchError | undefined;
    console.error = (...args: unknown[]) => {
      failureLogs.push(args.map(String).join(" "));
    };

    await assert.rejects(
      handleProviderWebhook("gocardless", { "webhook-signature": signature }, body),
      (error: unknown) => {
        if (!(error instanceof PaymentWebhookBatchError)) return false;
        batchError = error;
        return true;
      },
    );
    console.error = originalConsoleError;

    assert.ok(batchError);
    assert.match(batchError.message, /invoice open item not found/);
    assert.ok(
      batchError.cause instanceof PaymentAcceptanceError,
      "batch error must retain the original event-processing error as its cause",
    );
    assert.equal(batchError.cause.message, "invoice open item not found");
    assert.deepEqual(batchError.result, {
      signatureValid: true,
      orgId: org.orgId,
      status: "processing_failed",
      eventResults: [
        {
          externalRef: "PM-ENGINE-POISON",
          orgId: org.orgId,
          status: "processing_failed",
        },
        {
          externalRef: "PM-ENGINE-LATER",
          orgId: org.orgId,
          status: "failed",
        },
      ],
    });

    const attempts = await db.execute<{
      external_ref: string;
      status: string;
      event_payload: Record<string, unknown> | null;
    }>(sql`
      select external_ref, status, event_payload
        from payment_attempts
       where org_id = ${org.orgId} and link_id = ${linkId}
       order by external_ref
    `);
    assert.deepEqual(attempts.rows, [
      {
        external_ref: "BRQ-ENGINE-POISON",
        status: "initiated",
        event_payload: null,
      },
      {
        external_ref: "PM-ENGINE-LATER",
        status: "failed",
        event_payload: { webhook: true, status: "failed" },
      },
    ]);

    const emitted = failureLogs
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.event === PAYMENT_WEBHOOK_EVENT_FAILURE_LOG_EVENT);
    assert.equal(emitted.length, 1, `expected one poison-event emission, got ${JSON.stringify(emitted)}`);
    assert.deepEqual(
      {
        event: emitted[0]!.event,
        provider: emitted[0]!.provider,
        orgId: emitted[0]!.orgId,
        externalRef: emitted[0]!.externalRef,
        eventStatus: emitted[0]!.eventStatus,
        error: emitted[0]!.error,
      },
      {
        event: PAYMENT_WEBHOOK_EVENT_FAILURE_LOG_EVENT,
        provider: "gocardless",
        orgId: org.orgId,
        externalRef: "PM-ENGINE-POISON",
        eventStatus: "succeeded",
        error: "invoice open item not found",
      },
    );
    assert.match(String(emitted[0]!.at), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    console.error = originalConsoleError;
    await dropScratchOrg(org.orgId);
  }
});

/**
 * A signature-valid Adyen item whose fields cannot be normalized exactly is
 * quarantined during verification instead of crashing handleProviderWebhook:
 * the delivery stays authenticated, its signed sibling still reaches event
 * processing, and the quarantine leaves structured evidence behind.
 */
test("an authenticated adyen delivery quarantines an un-normalizable item and processes its sibling", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const originalConsoleError = console.error;
  const malformedLogs: string[] = [];
  try {
    const userId = await createScratchUser(org.orgId, "Adyen Quarantine Tester", "admin");
    const webhookSecret = Buffer.alloc(32, 17).toString("base64");
    await db.execute(sql`
      insert into psp_provider_configs
        (org_id, provider, display_name, is_enabled, acceptance_enabled,
         default_bank_account_id, secrets, created_by, updated_by)
      values (${org.orgId}, 'adyen', 'Adyen', true, true,
              ${org.accounts.bank}, ${sealJson({ webhookSecret })}, ${userId}, ${userId})
    `);

    const keyBytes = Buffer.from(webhookSecret, "base64");
    const signItem = (item: {
      pspReference?: unknown;
      originalReference?: unknown;
      merchantAccountCode?: unknown;
      merchantReference?: unknown;
      amount?: { value?: unknown; currency?: unknown };
      eventCode?: unknown;
      success?: unknown;
      additionalData?: Record<string, unknown>;
    }) => {
      const message = [
        item.pspReference ?? "",
        item.originalReference ?? "",
        item.merchantAccountCode ?? "",
        item.merchantReference ?? "",
        item.amount?.value ?? "",
        item.amount?.currency ?? "",
        item.eventCode ?? "",
        item.success ?? "",
      ].join(":");
      item.additionalData = {
        ...item.additionalData,
        "metadata.hmacSignature": createHmac("sha256", keyBytes).update(message, "utf8").digest("base64"),
      };
    };
    const malformed = {
      pspReference: "PSP-INT-BAD",
      originalReference: "",
      merchantAccountCode: "TestMerchant",
      merchantReference: "tok_int_bad",
      amount: { value: "103.5", currency: "CAD" },
      eventCode: "AUTHORISATION",
      success: "true",
    };
    const sibling = {
      pspReference: "PSP-INT-GOOD",
      originalReference: "",
      merchantAccountCode: "TestMerchant",
      merchantReference: "tok_int_good",
      amount: { value: 10300, currency: "CAD" },
      eventCode: "AUTHORISATION",
      success: "true",
    };
    signItem(malformed);
    signItem(sibling);
    const body = JSON.stringify({
      notificationItems: [
        { NotificationRequestItem: malformed },
        { NotificationRequestItem: sibling },
      ],
    });

    console.error = (...args: unknown[]) => {
      malformedLogs.push(args.map(String).join(" "));
    };
    let result;
    try {
      result = await handleProviderWebhook("adyen", {}, body);
    } finally {
      console.error = originalConsoleError;
    }

    // The batch resolves — no rejection — and only the normalizable sibling
    // reaches event processing (no attempts exist, so it resolves unknown).
    assert.deepEqual(result, {
      signatureValid: true,
      orgId: org.orgId,
      status: "unknown_attempt",
      eventResults: [
        { externalRef: "PSP-INT-GOOD", orgId: org.orgId, status: "unknown_attempt" },
      ],
    });

    const emitted = malformedLogs
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((entry) => entry?.event === PAYMENT_WEBHOOK_ITEM_MALFORMED_LOG_EVENT);
    assert.equal(emitted.length, 1, `expected one quarantine emission, got ${JSON.stringify(malformedLogs)}`);
    assert.deepEqual(
      {
        provider: emitted[0]!.provider,
        externalRef: emitted[0]!.externalRef,
        itemTypeOrCode: emitted[0]!.itemTypeOrCode,
      },
      { provider: "adyen", externalRef: "PSP-INT-BAD", itemTypeOrCode: "AUTHORISATION" },
    );
  } finally {
    console.error = originalConsoleError;
    await dropScratchOrg(org.orgId);
  }
});

/**
 * The full acceptance loop against a real org: link → checkout → signed
 * webhook → posted receipt auto-applied to the invoice, surcharge as a
 * fee-income leg, idempotent redelivery.
 */
test("payment link settles a signed webhook into an applied receipt with a surcharge leg", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Pay Tester", "admin");
    await enableOnlinePayments(org.orgId);
    // Online receipts post on the provider event date. Keep the fixed invoice
    // fixture date while ensuring the scratch calendar also covers today so
    // this boundary test remains valid when the suite runs after July 2026.
    const today = new Date().toISOString().slice(0, 10);
    if (today < "2026-07-01" || today > "2026-07-31") {
      const [year, month] = today.split("-").map(Number) as [number, number, number];
      const startsOn = `${year}-${String(month).padStart(2, "0")}-01`;
      const endsOn = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
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

    // Posted $100 invoice.
    const invoiceId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-PAY-1',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
              '100', '0', '100', ${userId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now()
       where id = ${invoiceId} and org_id = ${org.orgId}`);
    await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });

    // Provider config: stripe, acceptance on, receipt to the scratch bank.
    const webhookSecret = "whsec_itest";
    await db.execute(sql`
      insert into psp_provider_configs
        (org_id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id, secrets, created_by, updated_by)
      values (${org.orgId}, 'stripe', 'Stripe', true, true, ${org.accounts.bank},
              ${sealJson({ apiKey: "sk_test_itest", webhookSecret })}, ${userId}, ${userId})`);
    // 3% surcharge rule → fee income to revenue account.
    await db.execute(sql`
      insert into payment_surcharge_rules
        (org_id, name, calculation, percent, fee_income_account_id, provider, payment_method, effective_from, created_by, updated_by)
      values (${org.orgId}, 'Card fee', 'percent', '3', ${org.accounts.revenue}, null, 'all', '2020-01-01', ${userId}, ${userId})`);

    const link = await createPaymentLink(org.orgId, userId, { documentId: invoiceId, provider: "stripe" }, null);
    assert.equal(link.amount, "100.0000");
    assert.equal(link.surchargeAmount, "3.0000");

    // Checkout via a stubbed provider call.
    const session = await createCheckoutSession(link.token, "https://app.test/pay/" + link.token, async () => ({
      status: 200,
      json: async () => ({ id: "cs_test_123", url: "https://checkout.stripe.test/cs_test_123" }),
    }));
    assert.equal(session.redirectUrl, "https://checkout.stripe.test/cs_test_123");
    const attempt = (await db.execute<{ status: string; amount: string; surcharge_amount: string }>(sql`
      select status, amount, surcharge_amount from payment_attempts where org_id = ${org.orgId} and external_ref = 'cs_test_123'
    `));
    assert.equal(attempt.rows[0]!.status, "initiated");
    assert.equal(attempt.rows[0]!.amount, "100.0000");
    assert.equal(attempt.rows[0]!.surcharge_amount, "3.0000");

    // Signed webhook: checkout.session.completed for $103.
    const body = JSON.stringify({
      id: "evt_cs_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_123", client_reference_id: link.token, amount_total: 10300, currency: "cad" } },
    });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", webhookSecret).update(`${t}.${body}`, "utf8").digest("hex");
    const result = await handleProviderWebhook("stripe", { "stripe-signature": `t=${t},v1=${v1}` }, body);
    assert.ok(result);
    assert.equal(result.status, "settled");
    assert.equal(result.orgId, org.orgId);

    // Receipt posted and fully applied: invoice clears.
    const invoice = (await db.execute<{ open_balance: string }>(sql`
      select open_balance from documents where id = ${invoiceId}
    `));
    assert.equal(invoice.rows[0]!.open_balance, "0.0000");

    const payment = (await db.execute<{ id: string; status: string; total: string }>(sql`
      select id, status, total from documents
       where org_id = ${org.orgId} and kind = 'customer_payment' and memo like '%INV-PAY-1%'
    `));
    assert.equal(payment.rows.length, 1);
    assert.equal(payment.rows[0]!.status, "posted");
    assert.equal(payment.rows[0]!.total, "103.0000");

    // Journal: DR bank 103 / CR AR 100 / CR fee income 3.
    const lines = (await db.execute<{ account_id: string; amount: string }>(sql`
      select jl.account_id, jl.amount from journal_lines jl
        join journal_entries je on je.id = jl.entry_id
       where je.source_document_id = ${payment.rows[0]!.id} order by jl.line_number
    `));
    assert.deepEqual(
      lines.rows.map((l) => [l.account_id === org.accounts.bank ? "bank" : l.account_id === org.accounts.ar ? "ar" : "fee", l.amount]),
      [["bank", "103.0000"], ["ar", "-100.0000"], ["fee", "-3.0000"]],
    );

    // Application row settles the invoice's AR open item.
    const apps = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from applications a
        join journal_lines jl on jl.id = a.to_line_id
        join journal_entries je on je.id = jl.entry_id
       where a.org_id = ${org.orgId} and a.unapplied_at is null and je.source_document_id = ${invoiceId}
    `));
    assert.equal(apps.rows[0]!.n, 1);

    // Link + attempt terminal states.
    const terminal = (await db.execute<{ link_status: string; attempt_status: string }>(sql`
      select (select status from payment_links where id = ${link.id}) as link_status,
             (select status from payment_attempts where org_id = ${org.orgId} and external_ref = 'cs_test_123') as attempt_status
    `));
    assert.equal(terminal.rows[0]!.link_status, "paid");
    assert.equal(terminal.rows[0]!.attempt_status, "succeeded");

    // Redelivery is a duplicate, never a second receipt.
    const replay = await handleProviderWebhook("stripe", { "stripe-signature": `t=${t},v1=${v1}` }, body);
    assert.equal(replay?.status, "duplicate");
    const paymentCount = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from documents where org_id = ${org.orgId} and kind = 'customer_payment'
    `));
    assert.equal(paymentCount.rows[0]!.n, 1);

    // A forged signature never resolves an org.
    const forged = await handleProviderWebhook("stripe", { "stripe-signature": `t=${t},v1=${"0".repeat(64)}` }, body);
    assert.equal(forged, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the pay-link bearer token never rests in plaintext", { skip: !DB }, async () => {
  // The link token paid real invoices from a URL alone, and it was the only
  // one of six token types stored raw: a database read was enough to mint
  // payable URLs. Now the row carries the sha256 lookup hash and the sealed
  // display copy only — and the public /pay/{token} resolution still works,
  // because it resolves by hash.
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Token rest tester", "admin");
    await enableOnlinePayments(org.orgId);
    const invoiceId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-TOKEN-REST-1',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
              '100', '0', '100', ${userId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now()
       where id = ${invoiceId} and org_id = ${org.orgId}`);
    await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
    await db.execute(sql`
      insert into psp_provider_configs
        (org_id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id, secrets, created_by, updated_by)
      values (${org.orgId}, 'stripe', 'Stripe', true, true, ${org.accounts.bank},
              ${sealJson({ apiKey: "sk_test_itest", webhookSecret: "whsec_itest" })}, ${userId}, ${userId})`);
    const link = await createPaymentLink(org.orgId, userId, { documentId: invoiceId, provider: "stripe" }, null);

    // The row on disk: no plaintext token anywhere.
    const stored = (await db.execute<{ token: string | null; token_hash: string | null; token_sealed: string | null }>(sql`
      select token, token_hash, token_sealed from payment_links
       where org_id = ${org.orgId} and document_id = ${invoiceId}`)).rows[0]!;
    assert.equal(stored.token, null, "the raw bearer token must not be stored");
    assert.ok(stored.token_hash, "the lookup hash must be stored");
    assert.ok(stored.token_sealed, "the sealed display copy must be stored");
    assert.ok(!stored.token_sealed!.includes(link.token), "the seal is ciphertext, not the token");

    // The public surface still resolves by hash, and the panel still gets
    // the URL-bearing token from the sealed copy.
    const page = await publicPaymentPage(link.token);
    assert.equal(page?.status, "active");
    assert.equal(page?.invoiceAmount, "100.0000");
    const listed = await listPaymentLinks(org.orgId, invoiceId, null);
    assert.equal(listed[0]?.token, link.token, "display copy unseals to the same token");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a provider outage answering HTML surfaces as the named refusal, never a parse error", { skip: !DB }, async () => {  // Before the infallible body read, a WAF's HTML 502 (or an empty gateway
  // response) made res.json() throw a SyntaxError from inside the adapter,
  // displacing the composed refusal — the pay-link route turned it into a
  // 500 "Unexpected token" so an operator could not tell a bad API key from
  // a provider outage. The refusal must name the provider and the status.
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Outage Tester", "admin");
    await enableOnlinePayments(org.orgId);
    const invoiceId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-OUTAGE-1',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
              '100', '0', '100', ${userId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
    await db.execute(sql`
      update documents set status = 'approved', updated_at = now()
       where id = ${invoiceId} and org_id = ${org.orgId}`);
    await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
    await db.execute(sql`
      insert into psp_provider_configs
        (org_id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id, secrets, created_by, updated_by)
      values (${org.orgId}, 'stripe', 'Stripe', true, true, ${org.accounts.bank},
              ${sealJson({ apiKey: "sk_test_itest", webhookSecret: "whsec_itest" })}, ${userId}, ${userId})`);
    const link = await createPaymentLink(org.orgId, userId, { documentId: invoiceId, provider: "stripe" }, null);
    await assert.rejects(
      () =>
        createCheckoutSession(link.token, "https://app.test/pay/" + link.token, async () => ({
          status: 502,
          // A WAF's HTML error page: the body is not JSON at all.
          json: async () => {
            throw new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON");
          },
        })),
      (e: unknown) =>
        e instanceof PaymentAcceptanceError && /stripe checkout failed: 502/.test(e.message),
      "an HTML outage must surface as the composed refusal naming the provider and status",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a receipt keeps the over-collected remainder on-account when another channel paid first", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    // Posted $100 invoice + stripe config + 3% rule + active link for $103.
    const { userId, invoiceId, link } = await seedAcceptance(org, "INV-D2-OVER");

    // Checkout fixes the provider collection at $100 + $3 fee. Another
    // channel then collects $20 before the provider settles: the invoice has
    // $80 open, but checkout already committed the attempt to the full $103.
    await createCheckoutSession(link.token, "https://app.test/pay/" + link.token, async () => ({
      status: 200,
      json: async () => ({ id: "cs_test_d2over", url: "https://checkout.stripe.test/cs_test_d2over" }),
    }));
    const openLineId = (await db.execute<{ id: string }>(sql`
      select jl.id from journal_lines jl
        join journal_entries je on je.id = jl.entry_id
       where je.source_document_id = ${invoiceId} and jl.org_id = ${org.orgId}
         and jl.is_open_item
    `)).rows[0]!.id;
    const first = await createPaymentDocument({ allowedSubsidiaryIds: null,
      orgId: org.orgId,
      kind: "customer_payment",
      createdBy: userId,
      partyId: org.customerId,
      bankAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId,
      documentDate: org.date,
      currency: "CAD",
      fxRate: "1",
    });
    await updateDraftPayment(first.id, {
      partyId: org.customerId,
      bankAccountId: org.accounts.bank,
      allocations: [sameCurrencyAllocation(openLineId, "20")],
    }, userId, org.orgId);
    await db.execute(sql`
      update documents set status = 'approved', submitted_by = ${userId}, submitted_at = now()
       where id = ${first.id} and org_id = ${org.orgId}`);
    await postPaymentWithApplications(first.id, undefined, userId);

    // Signed provider settlement for the full quoted $103.
    const { body, headers } = signedStripeBody("whsec_INV-D2-OVER", "cs_test_d2over", link.token);
    const result = await handleProviderWebhook("stripe", headers, body);
    assert.ok(result);
    assert.equal(result.status, "settled");

    // The provider collected $103: the receipt must book all of it — $80
    // applied to the invoice, $20 held on-account, $3 fee income — instead
    // of posting only the $80 still open and dropping the $20 collected.
    const receipt = (await db.execute<{ id: string; total: string }>(sql`
      select id, total from documents
       where org_id = ${org.orgId} and kind = 'customer_payment'
         and memo like '%INV-D2-OVER%' and status = 'posted'
    `));
    assert.equal(receipt.rows.length, 1);
    assert.equal(receipt.rows[0]!.total, "103.0000");
    const legs = (await db.execute<{ leg: string; amount: string }>(sql`
      select case when jl.account_id = ${org.accounts.bank} then 'bank'
                  when jl.account_id = ${org.accounts.ar} then 'ar'
                  else 'fee' end as leg, jl.amount
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id
       where je.source_document_id = ${receipt.rows[0]!.id}
       order by jl.line_number
    `));
    assert.deepEqual(
      legs.rows.map((l) => [l.leg, l.amount]),
      [["bank", "103.0000"], ["ar", "-100.0000"], ["fee", "-3.0000"]],
    );
    const invoice = (await db.execute<{ open_balance: string }>(sql`
      select open_balance from documents where id = ${invoiceId}
    `));
    assert.equal(invoice.rows[0]!.open_balance, "0.0000");
    // Both applications settle the invoice; the second receipt's source leg
    // consumes only its $80 application, leaving the $20 remainder available
    // as an on-account credit rather than absorbing it.
    const apps = (await db.execute<{ target: string; source: string }>(sql`
      select a.target_transaction_amount::text as target, a.source_amount::text as source
        from applications a
        join journal_lines jl on jl.id = a.to_line_id
        join journal_entries je on je.id = jl.entry_id
       where a.org_id = ${org.orgId} and a.unapplied_at is null
         and je.source_document_id = ${invoiceId}
       order by a.target_transaction_amount
    `));
    assert.deepEqual(
      apps.rows.map((a) => [a.target, a.source]),
      [["20.0000", "20.0000"], ["80.0000", "80.0000"]],
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("webhook settles only the provider-confirmed quoted amount and currency", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fx = await seedAcceptance(org, "INV-PAY-EVIDENCE");
    await createCheckoutSession(fx.link.token, "https://app.test/pay/" + fx.link.token, async () => ({
      status: 200,
      json: async () => ({ id: "cs_evidence_1", url: "https://checkout.stripe.test/cs_evidence_1" }),
    }));

    const underpaid = signedStripeBody(
      "whsec_INV-PAY-EVIDENCE",
      "cs_evidence_1",
      fx.link.token,
      10_000,
    );
    await assert.rejects(
      handleProviderWebhook("stripe", underpaid.headers, underpaid.body),
      /reported 100\.0000 CAD, but checkout expected 103\.0000 CAD/,
    );

    const underpaymentEvidence = (await db.execute<{
      attempt_discrepancy: Record<string, unknown> | null;
      audit_discrepancy: Record<string, unknown> | null;
    }>(sql`
      select
        attempt.event_payload->'settlementDiscrepancy' as attempt_discrepancy,
        (
          select audit.changes->'after'->'settlementDiscrepancy'
            from audit_log audit
           where audit.org_id = ${org.orgId}
             and audit.table_name = 'payment_attempts'
             and audit.row_id = attempt.id
             and audit.action = 'update'
           order by audit.at desc
           limit 1
        ) as audit_discrepancy
        from payment_attempts attempt
       where attempt.org_id = ${org.orgId}
         and attempt.external_ref = 'cs_evidence_1'
    `)).rows[0]!;
    const expectedUnderpaymentEvidence = {
      reason: "amount_currency_mismatch",
      provider: "stripe",
      externalRef: "cs_evidence_1",
      reportedAmount: "100.0000",
      reportedCurrency: "CAD",
      expectedAmount: "103.0000",
      expectedCurrency: "CAD",
    };
    assert.deepEqual(underpaymentEvidence.attempt_discrepancy, expectedUnderpaymentEvidence);
    assert.deepEqual(underpaymentEvidence.audit_discrepancy, expectedUnderpaymentEvidence);

    const wrongCurrency = signedStripeBody(
      "whsec_INV-PAY-EVIDENCE",
      "cs_evidence_1",
      fx.link.token,
      10_300,
      "usd",
    );
    await assert.rejects(
      handleProviderWebhook("stripe", wrongCurrency.headers, wrongCurrency.body),
      /reported 103\.0000 USD, but checkout expected 103\.0000 CAD/,
    );

    const unchanged = (await db.execute<{
      attempt_status: string;
      invoice_balance: string;
      payment_count: number;
      discrepancy_count: number;
    }>(sql`
      select
        (select status from payment_attempts
          where org_id = ${org.orgId} and external_ref = 'cs_evidence_1') as attempt_status,
        (select open_balance from documents where id = ${fx.invoiceId}) as invoice_balance,
        (select count(*)::int from documents
          where org_id = ${org.orgId} and kind = 'customer_payment') as payment_count,
        (select count(*)::int
           from audit_log audit
           join payment_attempts attempt on attempt.id = audit.row_id
          where audit.org_id = ${org.orgId}
            and audit.table_name = 'payment_attempts'
            and audit.action = 'update'
            and audit.changes->'after' ? 'settlementDiscrepancy'
            and attempt.external_ref = 'cs_evidence_1') as discrepancy_count
    `));
    assert.equal(unchanged.rows[0]!.attempt_status, "initiated");
    assert.equal(unchanged.rows[0]!.invoice_balance, "100.0000");
    assert.equal(unchanged.rows[0]!.payment_count, 0);
    assert.equal(unchanged.rows[0]!.discrepancy_count, 2);

    const paid = signedStripeBody(
      "whsec_INV-PAY-EVIDENCE",
      "cs_evidence_1",
      fx.link.token,
    );
    const result = await handleProviderWebhook("stripe", paid.headers, paid.body);
    assert.equal(result?.status, "settled");

    const settled = (await db.execute<{
      payment_total: string;
      payment_currency: string;
      paid_amount: string;
      paid_currency: string;
    }>(sql`
      select payment.total as payment_total,
             payment.currency as payment_currency,
             attempt.event_payload->>'paidAmount' as paid_amount,
             attempt.event_payload->>'paidCurrency' as paid_currency
        from payment_attempts attempt
        join documents payment on payment.id = attempt.payment_document_id
       where attempt.org_id = ${org.orgId}
         and attempt.external_ref = 'cs_evidence_1'
    `));
    assert.equal(settled.rows[0]!.payment_total, "103.0000");
    assert.equal(settled.rows[0]!.payment_currency, "CAD");
    assert.equal(settled.rows[0]!.paid_amount, "103.0000");
    assert.equal(settled.rows[0]!.paid_currency, "CAD");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * F1.3: a claim that committed and a settlement that never ran (process died
 * between them) used to strand the attempt at succeeded + journal_entry_id
 * null forever — redelivery answered "duplicate", the collected money stayed
 * unbooked, and the customer's retry minted a second charge. The redelivery
 * must now resume settlement exactly once, with no reserved receipt draft
 * (the crash preceded the reservation).
 */
test("redelivery recovers an attempt stranded by a crash after its claim committed", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fx = await seedAcceptance(org, "INV-PAY-KILL");
    const session = await createCheckoutSession(fx.link.token, "https://app.test/pay/" + fx.link.token, async () => ({
      status: 200,
      json: async () => ({ id: "cs_kill_1", url: "https://checkout.stripe.test/cs_kill_1" }),
    }));
    assert.equal(session.redirectUrl, "https://checkout.stripe.test/cs_kill_1");

    // Crash simulation: the claim committed, the settlement never started.
    await db.execute(sql`
      update payment_attempts
         set status = 'succeeded', payment_document_id = null, journal_entry_id = null
       where org_id = ${org.orgId} and external_ref = 'cs_kill_1'
    `);

    const delivery = signedStripeBody("whsec_INV-PAY-KILL", "cs_kill_1", fx.link.token);
    const result = await handleProviderWebhook("stripe", delivery.headers, delivery.body);
    assert.ok(result);
    assert.equal(result.orgId, org.orgId);
    assert.equal(result.status, "settled");

    // Exactly one posted receipt, applied to the invoice.
    const payments = (await db.execute<{ id: string; status: string; total: string }>(sql`
      select id, status, total from documents
       where org_id = ${org.orgId} and kind = 'customer_payment'
    `));
    assert.equal(payments.rows.length, 1);
    assert.equal(payments.rows[0]!.status, "posted");
    assert.equal(payments.rows[0]!.total, "103.0000");
    const invoice = (await db.execute<{ open_balance: string }>(sql`
      select open_balance from documents where id = ${fx.invoiceId}
    `));
    assert.equal(invoice.rows[0]!.open_balance, "0.0000");

    // The completion marker is written: the attempt is terminal again.
    const attempt = (await db.execute<{ status: string; journal_entry_id: string | null }>(sql`
      select status, journal_entry_id from payment_attempts
       where org_id = ${org.orgId} and external_ref = 'cs_kill_1'
    `));
    assert.equal(attempt.rows[0]!.status, "succeeded");
    assert.ok(attempt.rows[0]!.journal_entry_id, "recovered attempt must record its journal entry");

    // And the next redelivery dedupes — still one receipt, one journal entry.
    const replay = await handleProviderWebhook("stripe", delivery.headers, delivery.body);
    assert.equal(replay?.status, "duplicate");
    const counts = (await db.execute<{ docs: number; entries: number }>(sql`
      select (select count(*)::int from documents where org_id = ${org.orgId} and kind = 'customer_payment') as docs,
             (select count(*)::int from journal_entries je
                join documents d on d.id = je.source_document_id and d.org_id = je.org_id
               where d.org_id = ${org.orgId} and d.kind = 'customer_payment') as entries
    `));
    assert.equal(counts.rows[0]!.docs, 1);
    assert.equal(counts.rows[0]!.entries, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * F1.3 concurrency: two simultaneous redeliveries of the same collection must
 * serialize on the recovery claim so only one receipt is ever posted.
 */
test("concurrent double-resume of a stranded attempt posts exactly one journal entry", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fx = await seedAcceptance(org, "INV-PAY-RACE");
    await createCheckoutSession(fx.link.token, "https://app.test/pay/" + fx.link.token, async () => ({
      status: 200,
      json: async () => ({ id: "cs_race_1", url: "https://checkout.stripe.test/cs_race_1" }),
    }));
    await db.execute(sql`
      update payment_attempts
         set status = 'succeeded', payment_document_id = null, journal_entry_id = null
       where org_id = ${org.orgId} and external_ref = 'cs_race_1'
    `);

    // Two distinct deliveries of the same provider object, fired together.
    const first = signedStripeBody("whsec_INV-PAY-RACE", "cs_race_1", fx.link.token);
    const second = signedStripeBody("whsec_INV-PAY-RACE", "cs_race_1", fx.link.token);
    const results = await Promise.all([
      handleProviderWebhook("stripe", first.headers, first.body),
      handleProviderWebhook("stripe", second.headers, second.body),
    ]);
    const statuses = results.map((r) => r?.status).sort();
    assert.deepEqual(statuses, ["duplicate", "settled"]);

    const counts = (await db.execute<{ docs: number; entries: number; marker: string | null }>(sql`
      select (select count(*)::int from documents where org_id = ${org.orgId} and kind = 'customer_payment') as docs,
             (select count(*)::int from journal_entries je
                join documents d on d.id = je.source_document_id and d.org_id = je.org_id
               where d.org_id = ${org.orgId} and d.kind = 'customer_payment') as entries,
             (select journal_entry_id::text from payment_attempts
               where org_id = ${org.orgId} and external_ref = 'cs_race_1') as marker
    `));
    assert.equal(counts.rows[0]!.docs, 1, "exactly one receipt despite concurrent resumers");
    assert.equal(counts.rows[0]!.entries, 1, "exactly one journal entry despite concurrent resumers");
    assert.ok(counts.rows[0]!.marker, "completion marker recorded");

    const invoice = (await db.execute<{ open_balance: string }>(sql`
      select open_balance from documents where id = ${fx.invoiceId}
    `));
    assert.equal(invoice.rows[0]!.open_balance, "0.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * Hosted-checkout concurrency: two simultaneous /pay/{token} requests for one
 * invoice must not each drive the provider. The initiated-attempt reuse probe
 * is only a control if two requests cannot pass it simultaneously — creation
 * is serialized per link behind a transaction advisory lock taken BEFORE the
 * probe or the un-undoable provider side effect. A concurrent pair therefore
 * produces exactly one provider checkout call and one initiated attempt, and
 * the loser resolves with the winner's live redirect URL instead of minting a
 * second session or failing; a failed provider call rolls the lock back with
 * its transaction, so nothing survives to block a genuine retry.
 */
test("concurrent hosted-checkout requests share one provider session for one invoice", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fx = await seedAcceptance(org, "INV-PAY-CHECKOUT-RACE");

    // Barrier at the stubbed PSP boundary: hold each caller until BOTH have
    // arrived. Reaching the adapter implies that caller already missed the
    // initiated-attempt reuse probe, so on pre-lock code this structurally
    // guarantees both create sessions (neither can insert while parked).
    // Post-lock only one request ever reaches the adapter — the other waits
    // at the advisory lock — so the bounded wait expires and the single
    // arrival completes alone before the loser re-probes inside the lock.
    let releaseSecond!: () => void;
    const secondArrival = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let expireQuorum!: () => void;
    const quorum = Promise.race([
      secondArrival,
      new Promise<void>((resolve) => {
        expireQuorum = resolve;
      }),
    ]);
    const quorumTimer = setTimeout(expireQuorum, 5_000);
    quorumTimer.unref();
    let providerCalls = 0;
    const fetchFn = async () => {
      const n = ++providerCalls;
      if (n >= 2) releaseSecond();
      else await quorum;
      return {
        status: 200,
        json: async () => ({
          id: `cs_checkout_race_${n}`,
          url: `https://checkout.stripe.test/cs_checkout_race_${n}`,
        }),
      };
    };
    const returnUrl = "https://app.test/pay/" + fx.link.token;

    const results = await Promise.all([
      createCheckoutSession(fx.link.token, returnUrl, fetchFn),
      createCheckoutSession(fx.link.token, returnUrl, fetchFn),
    ]);

    assert.equal(providerCalls, 1, "exactly one provider checkout call despite the concurrent pair");
    // The winner's session is cs_checkout_race_1: arrival order assigns ids,
    // and the first adapter arrival is whoever held the per-link lock.
    assert.deepEqual(results, [
      { redirectUrl: "https://checkout.stripe.test/cs_checkout_race_1" },
      { redirectUrl: "https://checkout.stripe.test/cs_checkout_race_1" },
    ]);

    const attempts = (await db.execute<{ external_ref: string; status: string; amount: string; surcharge_amount: string; payload: Record<string, unknown> | null }>(sql`
      select external_ref, status, amount, surcharge_amount, event_payload as payload
        from payment_attempts
       where org_id = ${org.orgId} and link_id = ${fx.link.id}
    `));
    assert.equal(attempts.rows.length, 1, "exactly one initiated attempt for the link despite the concurrent pair");
    assert.deepEqual(
      {
        external_ref: attempts.rows[0]!.external_ref,
        status: attempts.rows[0]!.status,
        amount: attempts.rows[0]!.amount,
        surcharge_amount: attempts.rows[0]!.surcharge_amount,
        redirectUrl: attempts.rows[0]!.payload?.redirectUrl,
      },
      {
        external_ref: "cs_checkout_race_1",
        status: "initiated",
        amount: "100.0000",
        surcharge_amount: "3.0000",
        redirectUrl: "https://checkout.stripe.test/cs_checkout_race_1",
      },
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("checkout rechecks a link voided while it waits for its per-link lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fx = await seedAcceptance(org, "INV-PAY-VOID-CHECKOUT-RACE");
    const lockKey = checkoutSessionLockKey(org.orgId, fx.link.id);
    let providerCalls = 0;
    let checkout: Promise<{ redirectUrl: string }> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
      `);
      checkout = createCheckoutSession(
        fx.link.token,
        `https://app.test/pay/${fx.link.token}`,
        async () => {
          providerCalls += 1;
          return { status: 200, json: async () => ({ id: "cs_voided", url: "https://checkout.stripe.test/cs_voided" }) };
        },
      );

      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const locks = await db.execute<{ waiting: number }>(sql`
          select count(*)::int as waiting from pg_locks
           where locktype = 'advisory' and not granted
        `);
        if (locks.rows[0]!.waiting > 0) {
          waiting = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(waiting, "checkout must reach the held lock before the admin voids the link");
      await voidPaymentLink(org.orgId, fx.userId, fx.link.id, null);
    });

    await assert.rejects(
      checkout!,
      (error: unknown) => error instanceof PaymentAcceptanceError && error.message === "payment link is void",
    );
    assert.equal(providerCalls, 0, "a voided link must be refused before contacting the provider");
    const attempts = (await db.execute<{ count: number }>(sql`
      select count(*)::int as count from payment_attempts where org_id = ${org.orgId} and link_id = ${fx.link.id}
    `)).rows[0]!;
    assert.equal(attempts.count, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * The per-link lock rides the org transaction, so a failed provider call
 * must leave no claim behind: the rolled-back checkout frees the link and a
 * genuine retry creates its own live session.
 */
test("a failed provider checkout leaves the link free for a genuine retry", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fx = await seedAcceptance(org, "INV-PAY-CHECKOUT-RETRY");
    const returnUrl = "https://app.test/pay/" + fx.link.token;

    await assert.rejects(
      createCheckoutSession(fx.link.token, returnUrl, async () => ({
        status: 500,
        json: async () => ({ error: { message: "processor unavailable" } }),
      })),
      /stripe checkout failed: processor unavailable/,
    );
    const afterFailure = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from payment_attempts where org_id = ${org.orgId} and link_id = ${fx.link.id}
    `));
    assert.equal(afterFailure.rows[0]!.n, 0, "failed checkout leaves no attempt behind");

    const retry = await createCheckoutSession(fx.link.token, returnUrl, async () => ({
      status: 200,
      json: async () => ({ id: "cs_retry_ok", url: "https://checkout.stripe.test/cs_retry_ok" }),
    }));
    assert.deepEqual(retry, { redirectUrl: "https://checkout.stripe.test/cs_retry_ok" });
    const attempts = (await db.execute<{ external_ref: string; status: string }>(sql`
      select external_ref, status from payment_attempts where org_id = ${org.orgId} and link_id = ${fx.link.id}
    `));
    assert.deepEqual(attempts.rows, [{ external_ref: "cs_retry_ok", status: "initiated" }]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * F1.3, partial progress: the crash landed after the receipt draft was
 * reserved but before it was built out and posted. Resume must reuse that
 * exact draft — never mint a second receipt for the same collection.
 */
test("redelivery resumes onto the reserved receipt draft after a mid-settlement crash", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fx = await seedAcceptance(org, "INV-PAY-DRAFT");
    await createCheckoutSession(fx.link.token, "https://app.test/pay/" + fx.link.token, async () => ({
      status: 200,
      json: async () => ({ id: "cs_draft_1", url: "https://checkout.stripe.test/cs_draft_1" }),
    }));
    const draft = await createPaymentDocument({ allowedSubsidiaryIds: null,
      orgId: org.orgId,
      kind: "customer_payment",
      createdBy: fx.userId,
      partyId: org.customerId,
      bankAccountId: org.accounts.bank,
      documentDate: new Date().toISOString().slice(0, 10),
      memo: `Online payment — INV-PAY-DRAFT`,
      subsidiaryId: org.subsidiaryId,
      currency: "CAD",
    });
    // Crash simulation: claim committed, draft reserved, settlement stalled.
    await db.execute(sql`
      update payment_attempts
         set status = 'succeeded', payment_document_id = ${draft.id}, journal_entry_id = null
       where org_id = ${org.orgId} and external_ref = 'cs_draft_1'
    `);

    const delivery = signedStripeBody("whsec_INV-PAY-DRAFT", "cs_draft_1", fx.link.token);
    const result = await handleProviderWebhook("stripe", delivery.headers, delivery.body);
    assert.ok(result);
    assert.equal(result.status, "settled");

    const payments = (await db.execute<{ id: string; status: string }>(sql`
      select id, status from documents where org_id = ${org.orgId} and kind = 'customer_payment'
    `));
    assert.equal(payments.rows.length, 1, "resume must reuse the reserved draft, not mint another");
    assert.equal(payments.rows[0]!.id, draft.id);
    assert.equal(payments.rows[0]!.status, "posted");
    const invoice = (await db.execute<{ open_balance: string }>(sql`
      select open_balance from documents where id = ${fx.invoiceId}
    `));
    assert.equal(invoice.rows[0]!.open_balance, "0.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * F2.1: the pay page must render the fee quoted at link creation, not a live
 * re-resolution against whatever surcharge rules happen to be active today.
 */
test("pay page shows the stored link surcharge even after surcharge rules change", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fx = await seedAcceptance(org, "INV-PAY-FEE");
    // The rule landscape moves after the quote: 3% replaced by 10%.
    await db.execute(sql`
      update payment_surcharge_rules set percent = '10', effective_from = '2020-01-01'
       where org_id = ${org.orgId}
    `);

    const page = await publicPaymentPage(fx.link.token);
    assert.ok(page);
    assert.equal(page.surchargeAmount, "3.0000", "pay page must show the stored quoted fee");
    assert.equal(page.totalAmount, "103.0000");
    assert.equal(page.invoiceAmount, "100.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("pay page and checkout keep the link's principal quote after a partial payment", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fx = await seedAcceptance(org, "INV-PAY-QUOTE-AFTER-PAYMENT");
    const openLineId = (await db.execute<{ id: string }>(sql`
      select jl.id from journal_lines jl
        join journal_entries je on je.id = jl.entry_id
       where je.source_document_id = ${fx.invoiceId} and jl.org_id = ${org.orgId}
         and jl.is_open_item
    `)).rows[0]!.id;
    const partial = await createPaymentDocument({ allowedSubsidiaryIds: null,
      orgId: org.orgId,
      kind: "customer_payment",
      createdBy: fx.userId,
      partyId: org.customerId,
      bankAccountId: org.accounts.bank,
      subsidiaryId: org.subsidiaryId,
      documentDate: org.date,
      currency: "CAD",
      fxRate: "1",
    });
    await updateDraftPayment(partial.id, {
      partyId: org.customerId,
      bankAccountId: org.accounts.bank,
      allocations: [sameCurrencyAllocation(openLineId, "50")],
    }, fx.userId, org.orgId);
    await db.execute(sql`
      update documents set status = 'approved', submitted_by = ${fx.userId}, submitted_at = now()
       where id = ${partial.id} and org_id = ${org.orgId}
    `);
    await postPaymentWithApplications(partial.id, undefined, fx.userId);

    const page = await publicPaymentPage(fx.link.token);
    assert.ok(page);
    assert.equal(page.invoiceAmount, "100.0000");
    assert.equal(page.surchargeAmount, "3.0000");
    assert.equal(page.totalAmount, "103.0000");

    await createCheckoutSession(fx.link.token, `https://app.test/pay/${fx.link.token}`, async () => ({
      status: 200,
      json: async () => ({ id: "cs_quoted_after_partial_payment", url: "https://checkout.stripe.test/cs_quoted_after_partial_payment" }),
    }));
    const attempt = (await db.execute<{ amount: string; surcharge_amount: string; invoice_amount: string }>(sql`
      select amount, surcharge_amount, event_payload->>'invoiceAmount' as invoice_amount
        from payment_attempts where org_id = ${org.orgId} and link_id = ${fx.link.id}
    `)).rows[0]!;
    assert.deepEqual(attempt, {
      amount: "100.0000",
      surcharge_amount: "3.0000",
      invoice_amount: "100.0000",
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("hosted checkout reads the quoted fee account from payment-link audit evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fx = await seedAcceptance(org, "INV-PAY-AUDIT-FEE");
    await db.execute(sql`
      update payment_surcharge_rules set percent = '10', effective_from = '2020-01-01'
       where org_id = ${org.orgId}
    `);

    const session = await createCheckoutSession(
      fx.link.token,
      `https://app.test/pay/${fx.link.token}`,
      async () => ({
        status: 200,
        json: async () => ({ id: "cs_audit_fee", url: "https://checkout.stripe.test/cs_audit_fee" }),
      }),
    );
    assert.deepEqual(session, { redirectUrl: "https://checkout.stripe.test/cs_audit_fee" });

    const attempt = (await db.execute<{ surcharge_amount: string; fee_income_account_id: string | null }>(sql`
      select surcharge_amount, event_payload->>'feeIncomeAccountId' as fee_income_account_id
        from payment_attempts
       where org_id = ${org.orgId} and external_ref = 'cs_audit_fee'
    `)).rows[0]!;
    assert.equal(attempt.surcharge_amount, "3.0000");
    assert.equal(attempt.fee_income_account_id, org.accounts.revenue);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * F-payment-method: surcharge rules carry a payment-method dimension
 * (all / card / bank_debit) and hosted checkout collects cards on Stripe/Adyen
 * but bank debits on GoCardless. A card-only rule must therefore never price a
 * bank-debit checkout and vice versa — not when it is global,
 * provider-specific, or even the provider-configured rule — while precedence
 * stays deterministic (configured > provider-specific > global, each tier
 * newest-effective first with a stable tie-break). The quote freezes onto the
 * link at creation and survives later rule churn.
 */
test("surcharge resolution honors the payment method across card and bank-debit providers", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Fee Method Tester", "admin");
    await enableOnlinePayments(org.orgId);
    const today = new Date().toISOString().slice(0, 10);
    const onDate = today;

    await db.execute(sql`
      insert into psp_provider_configs
        (org_id, provider, display_name, is_enabled, acceptance_enabled, default_bank_account_id, secrets, created_by, updated_by)
      values
        (${org.orgId}, 'stripe', 'Stripe', true, true, ${org.accounts.bank},
         ${sealJson({ apiKey: "sk_test_method", webhookSecret: "whsec_card" })}, ${userId}, ${userId}),
        (${org.orgId}, 'gocardless', 'GoCardless', true, true, ${org.accounts.bank},
         ${sealJson({ apiKey: "gc_test_method", webhookSecret: "whsec_debit" })}, ${userId}, ${userId})
    `);

    // Global rules on each side of the method dimension.
    const cardRuleId = randomUUID();
    const bankRuleId = randomUUID();
    await db.execute(sql`
      insert into payment_surcharge_rules
        (id, org_id, name, calculation, percent, fixed_amount, fee_income_account_id, provider, payment_method, effective_from, created_by, updated_by)
      values
        (${cardRuleId}, ${org.orgId}, 'Card fee', 'percent', '3', null, ${org.accounts.revenue}, null, 'card', '2020-01-01', ${userId}, ${userId}),
        (${bankRuleId}, ${org.orgId}, 'Debit fee', 'fixed', null, '2.0000', ${org.accounts.revenue}, null, 'bank_debit', '2020-01-01', ${userId}, ${userId})
    `);

    const postedInvoice = async (documentNumber: string): Promise<string> => {
      const invoiceId = randomUUID();
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, subsidiary_id, party_id,
           document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
        values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', ${documentNumber},
                ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
                '100', '0', '100', ${userId})`);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
      await db.execute(sql`
        update documents set status = 'approved', updated_at = now()
         where id = ${invoiceId} and org_id = ${org.orgId}`);
      await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
      return invoiceId;
    };

    // Each rail resolves its own dimension: the card rule prices Stripe and
    // the bank-debit rule prices GoCardless.
    assert.deepEqual(
      await resolveSurcharge(org.orgId, { provider: "stripe", amount: "100.0000", currency: "CAD", onDate }),
      { amount: "3.0000", ruleId: cardRuleId, feeIncomeAccountId: org.accounts.revenue },
    );
    assert.deepEqual(
      await resolveSurcharge(org.orgId, { provider: "gocardless", amount: "100.0000", currency: "CAD", onDate }),
      { amount: "2.0000", ruleId: bankRuleId, feeIncomeAccountId: org.accounts.revenue },
    );

    // End-to-end: links freeze the method-correct quote at creation.
    const stripeLink = await createPaymentLink(org.orgId, userId, {
      documentId: await postedInvoice("INV-METHOD-STRIPE"),
      provider: "stripe",
    }, null);
    const debitLink = await createPaymentLink(org.orgId, userId, {
      documentId: await postedInvoice("INV-METHOD-GC"),
      provider: "gocardless",
    }, null);
    assert.equal(stripeLink.surchargeAmount, "3.0000");
    assert.equal(debitLink.surchargeAmount, "2.0000");

    // Card-only landscape: the bank debit gets no fee — never the card fee.
    await db.execute(sql`update payment_surcharge_rules set is_active = false where id = ${bankRuleId}`);
    assert.deepEqual(
      await resolveSurcharge(org.orgId, { provider: "gocardless", amount: "100.0000", currency: "CAD", onDate }),
      { amount: "0", ruleId: null, feeIncomeAccountId: null },
    );
    // And the mirror case: a bank-debit-only landscape never prices the card.
    await db.execute(sql`update payment_surcharge_rules set is_active = false where id = ${cardRuleId}`);
    await db.execute(sql`update payment_surcharge_rules set is_active = true where id = ${bankRuleId}`);
    assert.deepEqual(
      await resolveSurcharge(org.orgId, { provider: "stripe", amount: "100.0000", currency: "CAD", onDate }),
      { amount: "0", ruleId: null, feeIncomeAccountId: null },
    );
    await db.execute(sql`update payment_surcharge_rules set is_active = true where id = ${cardRuleId}`);

    // Provider-specific rules beat same-method globals; the other rail's
    // provider-specific rule still never leaks across.
    const stripeOnlyCardRuleId = randomUUID();
    const gcOnlyDebitRuleId = randomUUID();
    await db.execute(sql`
      insert into payment_surcharge_rules
        (id, org_id, name, calculation, percent, fixed_amount, fee_income_account_id, provider, payment_method, effective_from, created_by, updated_by)
      values
        (${stripeOnlyCardRuleId}, ${org.orgId}, 'Stripe card fee', 'percent', '4', null, ${org.accounts.revenue}, 'stripe', 'card', '2020-06-01', ${userId}, ${userId}),
        (${gcOnlyDebitRuleId}, ${org.orgId}, 'GC debit fee', 'fixed', null, '1.5000', ${org.accounts.revenue}, 'gocardless', 'bank_debit', '2020-06-01', ${userId}, ${userId})
    `);
    assert.equal(
      (await resolveSurcharge(org.orgId, { provider: "stripe", amount: "100.0000", currency: "CAD", onDate })).ruleId,
      stripeOnlyCardRuleId,
    );
    assert.equal(
      (await resolveSurcharge(org.orgId, { provider: "gocardless", amount: "100.0000", currency: "CAD", onDate })).amount,
      "1.5000",
    );

    // The provider-configured rule wins its tier — but only when its method
    // matches the checkout. A card-only configured rule is refused by name on
    // the bank-debit rail rather than silently falling back to the matching
    // debit rule: an explicit reference is never substituted.
    await assert.rejects(
      resolveSurcharge(org.orgId, {
        provider: "gocardless",
        amount: "100.0000",
        currency: "CAD",
        onDate,
        configuredRuleId: cardRuleId,
      }),
      (error: unknown) =>
        error instanceof PaymentAcceptanceError &&
        /Card fee.*bank_debit.*gocardless.*Company Settings → Payment Providers/.test(error.message),
      "a method-mismatched configured rule refuses instead of falling back",
    );
    assert.deepEqual(
      await resolveSurcharge(org.orgId, {
        provider: "stripe",
        amount: "100.0000",
        currency: "CAD",
        onDate,
        configuredRuleId: cardRuleId,
      }),
      { amount: "3.0000", ruleId: cardRuleId, feeIncomeAccountId: org.accounts.revenue },
      "configured rule beats the provider-specific candidate in its tier",
    );
    // The config wiring reaches real link creation too.
    await db.execute(
      sql`update psp_provider_configs set surcharge_rule_id = ${cardRuleId} where org_id = ${org.orgId} and provider = 'stripe'`,
    );
    const configuredLink = await createPaymentLink(org.orgId, userId, {
      documentId: await postedInvoice("INV-METHOD-CONFIG"),
      provider: "stripe",
    }, null);
    assert.equal(configuredLink.surchargeAmount, "3.0000");

    // One active surcharge window per identity is a storage invariant
    // (migration 0023): retire the stripe/card lane's incumbent first, then
    // a same-tier, same-window rival is rejected outright and resolution
    // stays deterministic on the sole surviving rule.
    await db.execute(
      sql`update psp_provider_configs set surcharge_rule_id = null where org_id = ${org.orgId} and provider = 'stripe'`,
    );
    await db.execute(
      sql`update payment_surcharge_rules set is_active = false where id = ${stripeOnlyCardRuleId}`,
    );
    const tieA = randomUUID();
    const tieB = randomUUID();
    await db.execute(sql`
      insert into payment_surcharge_rules
        (id, org_id, name, calculation, percent, fixed_amount, fee_income_account_id, provider, payment_method, effective_from, created_by, updated_by)
      values
        (${tieA}, ${org.orgId}, 'Tie A', 'percent', '6', null, ${org.accounts.revenue}, 'stripe', 'card', ${today}, ${userId}, ${userId})
    `);
    await assert.rejects(
      db.execute(sql`
        insert into payment_surcharge_rules
          (id, org_id, name, calculation, percent, fixed_amount, fee_income_account_id, provider, payment_method, effective_from, created_by, updated_by)
        values
          (${tieB}, ${org.orgId}, 'Tie B', 'percent', '7', null, ${org.accounts.revenue}, 'stripe', 'card', ${today}, ${userId}, ${userId})
      `),
      (error: unknown) => {
        // Drizzle wraps the driver error; the guard's identity lives on cause.
        const message = String((error as { cause?: { message?: string } })?.cause?.message ?? error);
        return /payment_surcharge_rules_no_active_overlap|exclusion/i.test(message);
      },
      "a same-window rival is refused by the storage guard",
    );
    const tieFirst = await resolveSurcharge(org.orgId, { provider: "stripe", amount: "100.0000", currency: "CAD", onDate });
    const tieSecond = await resolveSurcharge(org.orgId, { provider: "stripe", amount: "100.0000", currency: "CAD", onDate });
    assert.equal(tieFirst.ruleId, tieA, "resolution deterministically keeps the sole surviving rule");
    assert.equal(tieSecond.ruleId, tieFirst.ruleId);

    // Frozen quote evidence: the rule landscape moves hard after link
    // creation — every percentage jumps to 10%, a brand-new catch-all
    // all-method rule joins the pool — yet neither the stored quote nor the
    // pay page moves.
    const allMethodsRuleId = randomUUID();
    await db.execute(sql`
      insert into payment_surcharge_rules
        (id, org_id, name, calculation, percent, fixed_amount, fee_income_account_id, provider, payment_method, effective_from, created_by, updated_by)
      values (${allMethodsRuleId}, ${org.orgId}, 'Catch-all', 'percent', '25', null, ${org.accounts.revenue}, null, 'all', ${today}, ${userId}, ${userId})
    `);
    await db.execute(sql`update payment_surcharge_rules set percent = '10' where org_id = ${org.orgId} and calculation = 'percent'`);
    assert.equal(
      (await resolveSurcharge(org.orgId, { provider: "stripe", amount: "100.0000", currency: "CAD", onDate })).amount,
      "10.0000",
      "live resolution genuinely follows the churned landscape",
    );
    const frozenPage = await publicPaymentPage(stripeLink.token);
    assert.ok(frozenPage);
    assert.equal(frozenPage.surchargeAmount, "3.0000", "pay page must keep showing the quoted fee");
    assert.equal(frozenPage.totalAmount, "103.0000");
    const frozenLink = (await db.execute<{ surcharge_amount: string }>(sql`
      select surcharge_amount from payment_links where id = ${stripeLink.id}
    `)).rows[0]!;
    assert.equal(frozenLink.surcharge_amount, "3.0000", "the link keeps the fee quoted at creation");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("invalid acceptance references fail before checkout and at storage", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fx = await seedAcceptance(org, "INV-PAY-REFS");

    // PostgreSQL is the final authority for direct writers: neither a bank
    // reference to an income account nor a surcharge target to an expense
    // account can be stored, even when the caller bypasses the service.
    await assert.rejects(
      db.execute(sql`
        insert into psp_provider_configs
          (org_id, provider, display_name, is_enabled, acceptance_enabled,
           default_bank_account_id, created_by, updated_by)
        values (${org.orgId}, 'adyen', 'Bad bank', true, true,
                ${org.accounts.revenue}, ${fx.userId}, ${fx.userId})
      `),
    );
    await assert.rejects(
      db.execute(sql`
        insert into payment_surcharge_rules
          (org_id, name, calculation, percent, fee_income_account_id,
           provider, payment_method, effective_from, created_by, updated_by)
        values (${org.orgId}, 'Bad fee', 'percent', '3', ${org.accounts.cogs},
                'stripe', 'card', '2020-01-01', ${fx.userId}, ${fx.userId})
      `),
    );

    // Account state can change after a link is issued. Checkout revalidates
    // the stored link before the irreversible provider call and therefore
    // leaves every payment-side table untouched when its receipt bank is no
    // longer postable.
    const before = await db.execute<{ attempts: number; payments: number; journals: number; audits: number }>(sql`
      select
        (select count(*)::int from payment_attempts where org_id = ${org.orgId}) as attempts,
        (select count(*)::int from documents where org_id = ${org.orgId} and kind = 'customer_payment') as payments,
        (select count(*)::int from journal_entries where org_id = ${org.orgId} and source_document_id is not null) as journals,
        (select count(*)::int from audit_log where org_id = ${org.orgId}) as audits
    `);
    await db.execute(sql`
      update accounts set is_active = false
       where id = ${org.accounts.bank} and org_id = ${org.orgId}
    `);
    let providerCalls = 0;
    await assert.rejects(
      createCheckoutSession(fx.link.token, `https://app.test/pay/${fx.link.token}`, async () => {
        providerCalls += 1;
        return {
          status: 200,
          json: async () => ({ id: "cs_should_not_be_called", url: "https://checkout.test/no" }),
        };
      }),
      (error: unknown) => error instanceof PaymentAcceptanceError,
    );
    const after = await db.execute<{ attempts: number; payments: number; journals: number; audits: number }>(sql`
      select
        (select count(*)::int from payment_attempts where org_id = ${org.orgId}) as attempts,
        (select count(*)::int from documents where org_id = ${org.orgId} and kind = 'customer_payment') as payments,
        (select count(*)::int from journal_entries where org_id = ${org.orgId} and source_document_id is not null) as journals,
        (select count(*)::int from audit_log where org_id = ${org.orgId}) as audits
    `);
    assert.equal(providerCalls, 0);
    assert.deepEqual(after.rows[0], before.rows[0]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("surcharge quotes are provider-collectible minor units, never sub-cent dust", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Fee Dust Tester", "admin");
    await db.execute(sql`
      insert into payment_surcharge_rules
        (id, org_id, name, calculation, percent, fixed_amount, fee_income_account_id, provider, payment_method, effective_from, created_by, updated_by)
      values (${randomUUID()}, ${org.orgId}, 'Card fee', 'percent', '3', null, ${org.accounts.revenue}, null, 'card', '2020-01-01', ${userId}, ${userId})
    `);
    const today = new Date().toISOString().slice(0, 10);
    // 3% of $11.11 is $0.3333 exactly — no provider can collect a third of a
    // cent, so the quote must arrive minor-exact or every checkout for this
    // amount fails at the adapter boundary.
    const quote = await resolveSurcharge(org.orgId, {
      provider: "stripe",
      amount: "11.1100",
      currency: "CAD",
      onDate: today,
    });
    assert.equal(quote.amount, "0.3300");
    assert.equal(toMinorUnits(add("11.1100", quote.amount), "CAD"), "1144");
    // Zero-decimal currencies quantize to whole units: 3% of ¥1111 is ¥33.
    const yen = await resolveSurcharge(org.orgId, {
      provider: "stripe",
      amount: "1111.0000",
      currency: "JPY",
      onDate: today,
    });
    assert.equal(yen.amount, "33.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("hosted checkout refuses an expired payment link without calling the provider", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const fx = await seedAcceptance(org, "INV-LINK-EXPIRED");
    // The pay page flips an expired link on view, but a direct session POST
    // must enforce expiry itself: backdate past the link's expiry unseen.
    await db.execute(sql`
      update payment_links set expires_on = '2020-01-01'
       where id = ${fx.link.id} and org_id = ${org.orgId}
    `);
    let providerCalls = 0;
    const fetchFn = async () => {
      providerCalls++;
      return {
        status: 200,
        json: async () => ({ id: "cs_test_expired", url: "https://checkout.stripe.test/cs_test_expired" }),
      };
    };
    await assert.rejects(
      createCheckoutSession(fx.link.token, "https://app.test/pay/" + fx.link.token, fetchFn),
      (error: unknown) =>
        error instanceof PaymentAcceptanceError && /expired/i.test(error.message),
    );
    assert.equal(providerCalls, 0, "no provider session for an expired link");
    const state = (await db.execute<{ status: string; attempts: number }>(sql`
      select (select status from payment_links where id = ${fx.link.id} and org_id = ${org.orgId}) as status,
             (select count(*)::int from payment_attempts where org_id = ${org.orgId} and link_id = ${fx.link.id}) as attempts
    `)).rows[0]!;
    assert.deepEqual(state, { status: "expired", attempts: 0 });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
