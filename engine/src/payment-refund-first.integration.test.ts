import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { sealJson } from "./secrets.ts";
import { handleProviderWebhook } from "./payment-acceptance.ts";
import { postDocument } from "./posting.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

function signedStripeBody(secret: string, event: unknown): { body: string; headers: Record<string, string> } {
  const body = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`, "utf8").digest("hex");
  return { body, headers: { "stripe-signature": `t=${t},v1=${v1}` } };
}

/**
 * A charge.refunded that beats its checkout.session.completed cannot resolve
 * (the intent is only persisted from the completed session). It must park as
 * a pending-clawback marker instead of dropping as unknown_attempt/200 —
 * otherwise the return is lost forever while the later settlement posts a
 * receipt with no reversal flag. When the succeeded event lands it settles
 * AND fires the clawback note; a redelivered refund then notes normally.
 */
test("a refund arriving before its success parks, settles, and notes exactly once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Clawback Tester", "admin");
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
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-CLAWBACK',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
              '100', '0', '100', ${userId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${org.orgId}, ${invoiceId}, 1, ${org.accounts.revenue}, '1', '100', '100', '0', '0')`);
    await db.execute(sql`update documents set status = 'approved', updated_at = now() where id = ${invoiceId} and org_id = ${org.orgId}`);
    await postDocument(invoiceId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } });

    const secret = `whsec_clawback_${randomUUID()}`;
    await db.execute(sql`
      insert into psp_provider_configs
        (org_id, provider, display_name, is_enabled, acceptance_enabled,
         default_bank_account_id, secrets, created_by, updated_by)
      values (${org.orgId}, 'stripe', 'Stripe', true, true,
              ${org.accounts.bank}, ${sealJson({ apiKey: "sk_test_clawback", webhookSecret: secret })}, ${userId}, ${userId})`);
    const linkId = randomUUID(), linkToken = `clawback-link-${randomUUID()}`;
    const sessionId = `cs_test_clawback_${randomUUID().slice(0, 8)}`;
    const intentId = `pi_clawback_${randomUUID().slice(0, 8)}`;
    await db.execute(sql`
      insert into payment_links
        (id, org_id, token, document_id, party_id, subsidiary_id, provider,
         bank_account_id, amount, surcharge_amount, currency, created_by, updated_by)
      values (${linkId}, ${org.orgId}, ${linkToken}, ${invoiceId}, ${org.customerId},
              ${org.subsidiaryId}, 'stripe', ${org.accounts.bank}, '100', '0', 'CAD',
              ${userId}, ${userId})`);
    await db.execute(sql`
      insert into payment_attempts (org_id, link_id, provider, external_ref, status, amount, surcharge_amount)
      values (${org.orgId}, ${linkId}, 'stripe', ${sessionId}, 'initiated', '100', '0')`);

    // The refund beats the settlement event: parked, not dropped.
    const refunded = signedStripeBody(secret, {
      id: `evt_refund_${randomUUID().slice(0, 8)}`,
      type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: intentId } },
    });
    const first = await handleProviderWebhook("stripe", refunded.headers, refunded.body);
    assert.equal(first?.status, "pending_clawback");
    const marker = (await db.execute<{ consumed_at: string | null }>(sql`
      select consumed_at from payment_pending_clawbacks
       where org_id = ${org.orgId} and provider = 'stripe' and intent_ref = ${intentId}`)).rows[0];
    assert.ok(marker, "refund-first parks a pending-clawback marker");
    assert.equal(marker.consumed_at, null);
    const untouched = (await db.execute<{ status: string; journal_entry_id: string | null }>(sql`
      select status, journal_entry_id from payment_attempts where org_id = ${org.orgId} and link_id = ${linkId}`)).rows[0]!;
    assert.equal(untouched.status, "initiated");

    // The real settlement lands late: books the receipt AND fires the note.
    const succeeded = signedStripeBody(secret, {
      id: `evt_succeeded_${randomUUID().slice(0, 8)}`,
      type: "checkout.session.completed",
      data: { object: { id: sessionId, client_reference_id: linkToken, payment_intent: intentId, amount_total: 10_000, currency: "cad", payment_status: "paid" } },
    });
    const second = await handleProviderWebhook("stripe", succeeded.headers, succeeded.body);
    assert.equal(second?.status, "settled");
    const receipts = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from documents where org_id = ${org.orgId} and kind = 'customer_payment'`));
    assert.equal(receipts.rows[0]!.n, 1);
    const attempt = (await db.execute<{ status: string; journal_entry_id: string | null }>(sql`
      select status, journal_entry_id from payment_attempts where org_id = ${org.orgId} and link_id = ${linkId}`)).rows[0]!;
    assert.equal(attempt.status, "succeeded");
    assert.ok(attempt.journal_entry_id);
    const consumed = (await db.execute<{ consumed_at: string | null; consumed_attempt_id: string | null }>(sql`
      select consumed_at, consumed_attempt_id from payment_pending_clawbacks
       where org_id = ${org.orgId} and provider = 'stripe' and intent_ref = ${intentId}`)).rows[0]!;
    assert.ok(consumed.consumed_at, "marker consumed by the settlement");
    const notes = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from audit_log
       where org_id = ${org.orgId} and table_name = 'payment_attempts'
         and changes->'after'->>'note' like '%before its settlement event%'`));
    assert.equal(notes.rows[0]!.n, 1, "exactly one clawback note from the parked refund");

    // The refund redelivery now resolves normally (no second marker, no second note).
    const redelivered = signedStripeBody(secret, {
      id: `evt_refund2_${randomUUID().slice(0, 8)}`,
      type: "charge.refunded",
      data: { object: { id: "ch_1", payment_intent: intentId } },
    });
    const third = await handleProviderWebhook("stripe", redelivered.headers, redelivered.body);
    assert.equal(third?.status, "refunded_noted");
    const markers = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from payment_pending_clawbacks
       where org_id = ${org.orgId} and provider = 'stripe' and intent_ref = ${intentId}`));
    assert.equal(markers.rows[0]!.n, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
