import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import {
  createPaymentLink,
  listPaymentLinks,
  voidPaymentLink,
} from "./acceptance.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

/**
 * Payment-link reads and writes lock the invoice and recheck the caller
 * scope inside the transaction: an unlocked route precheck can authorize an
 * A invoice while a concurrent A→B rehome lands before the sealed tokens
 * are unsealed (GET) or a fresh B link is minted (POST), or a B link is
 * voided (DELETE). Out-of-scope answers exactly like missing.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;
const priorDataKey = process.env.OPENBOOKS_DATA_KEY;

before(() => {
  process.env.OPENBOOKS_DATA_KEY = "00".repeat(32);
});

after(() => {
  if (priorDataKey === undefined) delete process.env.OPENBOOKS_DATA_KEY;
  else process.env.OPENBOOKS_DATA_KEY = priorDataKey;
});

async function linkCount(orgId: string, invoiceId: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from payment_links where org_id = ${orgId} and document_id = ${invoiceId}`)).rows[0]!.n;
}

async function linkStatus(orgId: string, linkId: string): Promise<string> {
  return (await db.execute<{ status: string }>(sql`
    select status from payment_links where org_id = ${orgId} and id = ${linkId}`)).rows[0]!.status;
}

test("payment links refuse an out-of-scope invoice on list, mint, and void", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Pay Scope Tester", "admin");
    await db.execute(sql`
      update orgs set settings = settings || '{"features":{"onlinePayments":true}}'::jsonb
       where id = ${org.orgId}`);
    const hidden = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${hidden}, ${org.orgId}, ${org.subsidiaryId}, 'Hidden entity', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into party_subsidiaries (id, org_id, party_id, subsidiary_id)
      values (${randomUUID()}, ${org.orgId}, ${org.customerId}, ${hidden})`);
    const invoiceId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-SCOPE-1',
              ${hidden}, ${org.customerId}, ${org.date}, 'CAD', '1',
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
              ${sealJson({ apiKey: "sk_test_scope", webhookSecret: "whsec_scope" })}, ${userId}, ${userId})`);
    const scopeA = new Set([org.subsidiaryId]);
    await assert.rejects(
      listPaymentLinks(org.orgId, invoiceId, scopeA),
      (error: unknown) => error instanceof ScopeNotFoundError,
      "listing links of an out-of-scope invoice refuses",
    );
    await assert.rejects(
      createPaymentLink(org.orgId, userId, { documentId: invoiceId, provider: "stripe" }, scopeA),
      (error: unknown) => error instanceof ScopeNotFoundError,
      "minting a link on an out-of-scope invoice refuses",
    );
    assert.equal(await linkCount(org.orgId, invoiceId), 0, "a refused mint writes no link");
    const link = await createPaymentLink(org.orgId, userId, { documentId: invoiceId, provider: "stripe" }, null);
    assert.equal(await linkCount(org.orgId, invoiceId), 1);
    const listed = await listPaymentLinks(org.orgId, invoiceId, null);
    assert.equal(listed.length, 1);
    await assert.rejects(
      voidPaymentLink(org.orgId, userId, link.id, scopeA),
      (error: unknown) => error instanceof ScopeNotFoundError,
      "voiding a link on an out-of-scope invoice refuses",
    );
    assert.equal(await linkStatus(org.orgId, link.id), "active", "a refused void leaves the link active");
    await voidPaymentLink(org.orgId, userId, link.id, null);
    assert.equal(await linkStatus(org.orgId, link.id), "void");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
