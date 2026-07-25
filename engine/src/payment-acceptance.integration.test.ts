import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { sealJson } from "./secrets.ts";
import {
  createCheckoutSession,
  createPaymentLink,
  handleProviderWebhook,
} from "./payment-acceptance.ts";
import { postDocument } from "./posting.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * The full acceptance loop against a real org: link → checkout → signed
 * webhook → posted receipt auto-applied to the invoice, surcharge as a
 * fee-income leg, idempotent redelivery.
 */
test("payment link settles a signed webhook into an applied receipt with a surcharge leg", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = randomUUID();
    await db.execute(sql`
      insert into users (id, org_id, email, name, password_hash, role, is_active)
      values (${userId}, ${org.orgId}, ${`pay-${userId}@scratch.test`}, 'Pay Tester', 'x', 'admin', true)`);

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
    const attempt = (await db.execute(sql`
      select status, amount, surcharge_amount from payment_attempts where org_id = ${org.orgId} and external_ref = 'cs_test_123'
    `)) as unknown as { rows: { status: string; amount: string; surcharge_amount: string }[] };
    assert.equal(attempt.rows[0]!.status, "initiated");
    assert.equal(attempt.rows[0]!.amount, "100.0000");
    assert.equal(attempt.rows[0]!.surcharge_amount, "3.0000");

    // Signed webhook: checkout.session.completed for $103.
    const body = JSON.stringify({
      id: "evt_cs_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_test_123", client_reference_id: link.token, amount_total: 10300 } },
    });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", webhookSecret).update(`${t}.${body}`, "utf8").digest("hex");
    const result = await handleProviderWebhook("stripe", { "stripe-signature": `t=${t},v1=${v1}` }, body);
    assert.ok(result);
    assert.equal(result.status, "settled");
    assert.equal(result.orgId, org.orgId);

    // Receipt posted and fully applied: invoice clears.
    const invoice = (await db.execute(sql`
      select open_balance from documents where id = ${invoiceId}
    `)) as unknown as { rows: { open_balance: string }[] };
    assert.equal(invoice.rows[0]!.open_balance, "0.0000");

    const payment = (await db.execute(sql`
      select id, status, total from documents
       where org_id = ${org.orgId} and kind = 'customer_payment' and memo like '%INV-PAY-1%'
    `)) as unknown as { rows: { id: string; status: string; total: string }[] };
    assert.equal(payment.rows.length, 1);
    assert.equal(payment.rows[0]!.status, "posted");
    assert.equal(payment.rows[0]!.total, "103.0000");

    // Journal: DR bank 103 / CR AR 100 / CR fee income 3.
    const lines = (await db.execute(sql`
      select jl.account_id, jl.amount from journal_lines jl
        join journal_entries je on je.id = jl.entry_id
       where je.source_document_id = ${payment.rows[0]!.id} order by jl.line_number
    `)) as unknown as { rows: { account_id: string; amount: string }[] };
    assert.deepEqual(
      lines.rows.map((l) => [l.account_id === org.accounts.bank ? "bank" : l.account_id === org.accounts.ar ? "ar" : "fee", l.amount]),
      [["bank", "103.0000"], ["ar", "-100.0000"], ["fee", "-3.0000"]],
    );

    // Application row settles the invoice's AR open item.
    const apps = (await db.execute(sql`
      select count(*)::int as n from applications a
        join journal_lines jl on jl.id = a.to_line_id
        join journal_entries je on je.id = jl.entry_id
       where a.org_id = ${org.orgId} and a.unapplied_at is null and je.source_document_id = ${invoiceId}
    `)) as unknown as { rows: { n: number }[] };
    assert.equal(apps.rows[0]!.n, 1);

    // Link + attempt terminal states.
    const terminal = (await db.execute(sql`
      select (select status from payment_links where id = ${link.id}) as link_status,
             (select status from payment_attempts where org_id = ${org.orgId} and external_ref = 'cs_test_123') as attempt_status
    `)) as unknown as { rows: { link_status: string; attempt_status: string }[] };
    assert.equal(terminal.rows[0]!.link_status, "paid");
    assert.equal(terminal.rows[0]!.attempt_status, "succeeded");

    // Redelivery is a duplicate, never a second receipt.
    const replay = await handleProviderWebhook("stripe", { "stripe-signature": `t=${t},v1=${v1}` }, body);
    assert.equal(replay?.status, "duplicate");
    const paymentCount = (await db.execute(sql`
      select count(*)::int as n from documents where org_id = ${org.orgId} and kind = 'customer_payment'
    `)) as unknown as { rows: { n: number }[] };
    assert.equal(paymentCount.rows[0]!.n, 1);

    // A forged signature never resolves an org.
    const forged = await handleProviderWebhook("stripe", { "stripe-signature": `t=${t},v1=${"0".repeat(64)}` }, body);
    assert.equal(forged, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
