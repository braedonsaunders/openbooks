import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { sql } from "drizzle-orm";
import { db, env } from "./db.ts";
import { sealJson } from "./secrets.ts";
import {
  createCheckoutSession,
  createPaymentLink,
  handleProviderWebhook,
  PAYMENT_WEBHOOK_EVENT_FAILURE_LOG_EVENT,
  PAYMENT_WEBHOOK_ITEM_MALFORMED_LOG_EVENT,
  PaymentAcceptanceError,
  PaymentWebhookBatchError,
  publicPaymentPage,
  resolveSurcharge,
} from "./payment-acceptance.ts";
import { postDocument } from "./posting.ts";
import { createPaymentDocument } from "./payments.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const priorDataKey = env.OPENBOOKS_DATA_KEY;

before(() => {
  env.OPENBOOKS_DATA_KEY = "00".repeat(32);
});

after(() => {
  if (priorDataKey === undefined) delete env.OPENBOOKS_DATA_KEY;
  else env.OPENBOOKS_DATA_KEY = priorDataKey;
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
    `);
  }
  const invoiceId = randomUUID();
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
    values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'approved', ${memo},
            ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
            '100', '0', '100', ${userId})`);
  await db.execute(sql`
    insert into document_lines
      (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
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
  const link = await createPaymentLink(org.orgId, userId, { documentId: invoiceId, provider: "stripe" });
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
    const signItem = (item: Record<string, any>) => {
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
      `);
    }

    // Posted $100 invoice.
    const invoiceId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'approved', 'INV-PAY-1',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
              '100', '0', '100', ${userId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
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

    const link = await createPaymentLink(org.orgId, userId, { documentId: invoiceId, provider: "stripe" });
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
    const draft = await createPaymentDocument({
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
        values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'approved', ${documentNumber},
                ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
                '100', '0', '100', ${userId})`);
      await db.execute(sql`
        insert into document_lines
          (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
        values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
      await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });
      return invoiceId;
    };

    // Each rail resolves its own dimension: the card rule prices Stripe and
    // the bank-debit rule prices GoCardless.
    assert.deepEqual(
      await resolveSurcharge(org.orgId, { provider: "stripe", amount: "100.0000", onDate }),
      { amount: "3.0000", ruleId: cardRuleId, feeIncomeAccountId: org.accounts.revenue },
    );
    assert.deepEqual(
      await resolveSurcharge(org.orgId, { provider: "gocardless", amount: "100.0000", onDate }),
      { amount: "2.0000", ruleId: bankRuleId, feeIncomeAccountId: org.accounts.revenue },
    );

    // End-to-end: links freeze the method-correct quote at creation.
    const stripeLink = await createPaymentLink(org.orgId, userId, {
      documentId: await postedInvoice("INV-METHOD-STRIPE"),
      provider: "stripe",
    });
    const debitLink = await createPaymentLink(org.orgId, userId, {
      documentId: await postedInvoice("INV-METHOD-GC"),
      provider: "gocardless",
    });
    assert.equal(stripeLink.surchargeAmount, "3.0000");
    assert.equal(debitLink.surchargeAmount, "2.0000");

    // Card-only landscape: the bank debit gets no fee — never the card fee.
    await db.execute(sql`update payment_surcharge_rules set is_active = false where id = ${bankRuleId}`);
    assert.deepEqual(
      await resolveSurcharge(org.orgId, { provider: "gocardless", amount: "100.0000", onDate }),
      { amount: "0", ruleId: null, feeIncomeAccountId: null },
    );
    // And the mirror case: a bank-debit-only landscape never prices the card.
    await db.execute(sql`update payment_surcharge_rules set is_active = false where id = ${cardRuleId}`);
    await db.execute(sql`update payment_surcharge_rules set is_active = true where id = ${bankRuleId}`);
    assert.deepEqual(
      await resolveSurcharge(org.orgId, { provider: "stripe", amount: "100.0000", onDate }),
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
      (await resolveSurcharge(org.orgId, { provider: "stripe", amount: "100.0000", onDate })).ruleId,
      stripeOnlyCardRuleId,
    );
    assert.equal(
      (await resolveSurcharge(org.orgId, { provider: "gocardless", amount: "100.0000", onDate })).amount,
      "1.5000",
    );

    // The provider-configured rule wins its tier — but only when its method
    // matches the checkout. A card-only configured rule is excluded from the
    // bank-debit rail rather than overriding the matching debit rule.
    assert.equal(
      (await resolveSurcharge(org.orgId, {
        provider: "gocardless",
        amount: "100.0000",
        onDate,
        configuredRuleId: cardRuleId,
      })).amount,
      "1.5000",
    );
    assert.deepEqual(
      await resolveSurcharge(org.orgId, {
        provider: "stripe",
        amount: "100.0000",
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
    });
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
    const tieFirst = await resolveSurcharge(org.orgId, { provider: "stripe", amount: "100.0000", onDate });
    const tieSecond = await resolveSurcharge(org.orgId, { provider: "stripe", amount: "100.0000", onDate });
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
      (await resolveSurcharge(org.orgId, { provider: "stripe", amount: "100.0000", onDate })).amount,
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
