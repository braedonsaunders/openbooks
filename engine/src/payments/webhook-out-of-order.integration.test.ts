import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import { handleProviderWebhook } from "./acceptance.ts";
import { postDocument } from "../ledger/posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function signedGcBody(secret: string, action: string, payment: string, billingRequest: string): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify({
    events: [{ resource_type: "payments", action, links: { payment, billing_request: billingRequest } }],
  });
  return { body, headers: { "webhook-signature": createHmac("sha256", secret).update(body, "utf8").digest("hex") } };
}

/**
 * Provider webhooks for one object can arrive out of order. A chargeback that
 * beats its settlement event claims the initiated attempt as refunded; when
 * the (real, amount-matched) succeeded event lands afterwards it must still
 * settle — collected money with no receipt, an open invoice, and a 200 to the
 * provider is a stranded collection. The clawback audit note stays for the
 * controller to reverse against if the funds were returned.
 */
test("a succeeded event arriving after its refund still settles instead of stranding", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Order Tester", "admin");
    await db.execute(sql`
      update orgs set settings = settings || '{"features":{"onlinePayments":true}}'::jsonb where id = ${org.orgId}`);
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
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-GC-ORDER',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
              '100', '0', '100', ${userId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
    await db.execute(sql`update documents set status = 'approved', updated_at = now() where id = ${invoiceId} and org_id = ${org.orgId}`);
    await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });

    const secret = `gc-order-${randomUUID()}`;
    await db.execute(sql`
      insert into psp_provider_configs
        (org_id, provider, display_name, is_enabled, acceptance_enabled,
         default_bank_account_id, secrets, created_by, updated_by)
      values (${org.orgId}, 'gocardless', 'GoCardless', true, true,
              ${org.accounts.bank}, ${sealJson({ webhookSecret: secret })}, ${userId}, ${userId})`);
    const linkId = randomUUID(), linkToken = `gc-order-link-${randomUUID()}`;
    await db.execute(sql`
      insert into payment_links
        (id, org_id, token, document_id, party_id, subsidiary_id, provider,
         bank_account_id, amount, surcharge_amount, currency, created_by, updated_by)
      values (${linkId}, ${org.orgId}, ${linkToken}, ${invoiceId}, ${org.customerId},
              ${org.subsidiaryId}, 'gocardless', ${org.accounts.bank}, '100', '0', 'CAD',
              ${userId}, ${userId})`);
    await db.execute(sql`
      insert into payment_attempts (org_id, link_id, provider, external_ref, status, amount, surcharge_amount)
      values (${org.orgId}, ${linkId}, 'gocardless', 'BRQ-ORDER-1', 'initiated', '100', '0')`);

    // The chargeback beats the settlement event.
    const refunded = signedGcBody(secret, "charged_back", "PM-ORDER-1", "BRQ-ORDER-1");
    const first = await handleProviderWebhook("gocardless", refunded.headers, refunded.body);
    assert.equal(first?.status, "refunded_noted");
    const stranded = (await db.execute<{ status: string; journal_entry_id: string | null }>(sql`
      select status, journal_entry_id from payment_attempts where org_id = ${org.orgId} and link_id = ${linkId}`)).rows[0]!;
    assert.equal(stranded.status, "refunded");
    assert.equal(stranded.journal_entry_id, null);

    // The real settlement event lands late: it must book the receipt (the
    // clawback note above stays for the controller), not dedupe away.
    const confirmed = signedGcBody(secret, "confirmed", "PM-ORDER-1", "BRQ-ORDER-1");
    const second = await handleProviderWebhook("gocardless", confirmed.headers, confirmed.body);
    assert.equal(second?.status, "settled");

    const receipts = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from documents where org_id = ${org.orgId} and kind = 'customer_payment'`));
    assert.equal(receipts.rows[0]!.n, 1);
    const invoice = (await db.execute<{ open_balance: string }>(sql`
      select open_balance from documents where id = ${invoiceId}`));
    assert.equal(invoice.rows[0]!.open_balance, "0.0000");
    const attempt = (await db.execute<{ status: string; journal_entry_id: string | null }>(sql`
      select status, journal_entry_id from payment_attempts where org_id = ${org.orgId} and link_id = ${linkId}`)).rows[0]!;
    assert.equal(attempt.status, "succeeded");
    assert.ok(attempt.journal_entry_id);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
