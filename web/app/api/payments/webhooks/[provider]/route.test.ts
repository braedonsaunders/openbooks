import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { sql } from "drizzle-orm";
import { db, env } from "../../../../../../engine/src/db.ts";
import {
  ACCEPTANCE_ADAPTERS,
  handleProviderWebhook,
} from "../../../../../../engine/src/payment-acceptance.ts";
import { sealJson } from "../../../../../../engine/src/secrets.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../../../../../engine/src/test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
const priorDataKey = env.OPENBOOKS_DATA_KEY;

before(() => {
  env.OPENBOOKS_DATA_KEY = "00".repeat(32);
});

after(() => {
  if (priorDataKey === undefined) delete env.OPENBOOKS_DATA_KEY;
  else env.OPENBOOKS_DATA_KEY = priorDataKey;
});

test("GoCardless webhook verification distinguishes invalid signatures and preserves every actionable event", () => {
  const secret = "gc-batch-secret";
  const body = JSON.stringify({
    events: [
      {
        id: "EV-IGNORED",
        resource_type: "mandates",
        action: "created",
        links: { mandate: "MD-1" },
      },
      {
        id: "EV-CONFIRMED",
        resource_type: "payments",
        action: "confirmed",
        links: { payment: "PM-1", billing_request: "BRQ-1" },
      },
      {
        id: "EV-FAILED",
        resource_type: "payments",
        action: "failed",
        links: { payment: "PM-2", billing_request: "BRQ-2" },
      },
    ],
  });
  const signature = createHmac("sha256", secret).update(body, "utf8").digest("hex");

  const verified = ACCEPTANCE_ADAPTERS.gocardless.verifyWebhookDelivery(
    { "webhook-signature": signature },
    body,
    { webhookSecret: secret },
  );
  assert.equal(verified.signatureValid, true);
  assert.deepEqual(
    verified.events.map((event) => [event.externalRef, event.status]),
    [
      ["PM-1", "succeeded"],
      ["PM-2", "failed"],
    ],
  );

  const invalid = ACCEPTANCE_ADAPTERS.gocardless.verifyWebhookDelivery(
    { "webhook-signature": "0".repeat(64) },
    body,
    { webhookSecret: secret },
  );
  assert.equal(invalid.signatureValid, false);
  assert.deepEqual(invalid.events, []);
});

test("a valid webhook containing only unhandled events remains authenticated", () => {
  const secret = "gc-unhandled-secret";
  const body = JSON.stringify({
    events: [
      {
        id: "EV-MANDATE",
        resource_type: "mandates",
        action: "created",
        links: { mandate: "MD-1" },
      },
    ],
  });
  const signature = createHmac("sha256", secret).update(body, "utf8").digest("hex");

  const verified = ACCEPTANCE_ADAPTERS.gocardless.verifyWebhookDelivery(
    { "webhook-signature": signature },
    body,
    { webhookSecret: secret },
  );
  assert.equal(verified.signatureValid, true);
  assert.deepEqual(verified.events, []);
});

test("GoCardless ingestion dispatches every actionable event in one authenticated batch", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Webhook Tester", "admin");
    const invoiceId = randomUUID();
    const linkId = randomUUID();
    const secret = "gc-ingestion-secret";
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-GC-BATCH',
              ${org.subsidiaryId}, ${org.customerId}, ${org.date}, 'CAD', '1',
              '20', '0', '20', ${userId})
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
      values (${linkId}, ${org.orgId}, 'gc-batch-link', ${invoiceId}, ${org.customerId},
              ${org.subsidiaryId}, 'gocardless', ${org.accounts.bank}, '20', '0', 'CAD',
              ${userId}, ${userId})
    `);
    await db.execute(sql`
      insert into payment_attempts
        (org_id, link_id, provider, external_ref, status, amount, surcharge_amount)
      values (${org.orgId}, ${linkId}, 'gocardless', 'BRQ-1', 'initiated', '10', '0'),
             (${org.orgId}, ${linkId}, 'gocardless', 'BRQ-2', 'initiated', '10', '0')
    `);

    const body = JSON.stringify({
      events: [
        { resource_type: "mandates", action: "created", links: { mandate: "MD-1" } },
        { resource_type: "payments", action: "failed", links: { payment: "PM-1", billing_request: "BRQ-1" } },
        { resource_type: "payments", action: "failed", links: { payment: "PM-2", billing_request: "BRQ-2" } },
      ],
    });
    const signature = createHmac("sha256", secret).update(body, "utf8").digest("hex");
    const result = await handleProviderWebhook("gocardless", { "webhook-signature": signature }, body);

    assert.ok(result);
    assert.equal(result.signatureValid, true);
    assert.equal(result.status, "processed");
    assert.deepEqual(
      result.eventResults.map(({ externalRef, status }) => [externalRef, status]),
      [
        ["PM-1", "failed"],
        ["PM-2", "failed"],
      ],
    );
    const attempts = await db.execute<{ external_ref: string; status: string }>(sql`
      select external_ref, status from payment_attempts
       where org_id = ${org.orgId} and link_id = ${linkId}
       order by external_ref
    `);
    assert.deepEqual(
      attempts.rows.map(({ external_ref, status }) => [external_ref, status]),
      [
        ["PM-1", "failed"],
        ["PM-2", "failed"],
      ],
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
