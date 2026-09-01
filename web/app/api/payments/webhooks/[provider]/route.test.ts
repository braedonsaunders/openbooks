import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { sql } from "drizzle-orm";
import { db, env } from "../../../../../../engine/src/db.ts";
import {
  ACCEPTANCE_ADAPTERS,
  PAYMENT_WEBHOOK_ITEM_MALFORMED_LOG_EVENT,
} from "../../../../../../engine/src/payment-acceptance.ts";
import { sealJson } from "../../../../../../engine/src/secrets.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../../../../../../engine/src/test-fixtures.ts";
import { POST } from "./route.ts";

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

test("the route acknowledges a signed adyen delivery after isolating its malformed item", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const originalConsoleError = console.error;
  const malformedLogs: string[] = [];
  try {
    const userId = await createScratchUser(org.orgId, "Adyen Route Tester", "admin");
    const webhookSecret = Buffer.alloc(32, 19).toString("base64");
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
    const arrayItem = {
      pspReference: "PSP-ROUTE-ARRAY",
      originalReference: "",
      merchantAccountCode: "TestMerchant",
      merchantReference: "tok_route_array",
      amount: { value: 10300, currency: "CAD" },
      eventCode: ["IGNORED", "AUTHORISATION"],
      success: ["false", "true"],
    };
    const malformed = {
      pspReference: "PSP-ROUTE-BAD",
      originalReference: "",
      merchantAccountCode: "TestMerchant",
      merchantReference: "tok_route_bad",
      amount: { value: "103.5", currency: "CAD" },
      eventCode: "AUTHORISATION",
      success: "TRUE",
    };
    const sibling = {
      pspReference: "PSP-ROUTE-GOOD",
      originalReference: "",
      merchantAccountCode: "TestMerchant",
      merchantReference: "tok_route_good",
      amount: { value: 10300, currency: "CAD" },
      eventCode: "AUTHORISATION",
      success: "true",
    };
    signItem(arrayItem);
    signItem(malformed);
    signItem(sibling);
    const body = JSON.stringify({
      notificationItems: [
        { NotificationRequestItem: arrayItem },
        { NotificationRequestItem: malformed },
        { NotificationRequestItem: sibling },
      ],
    });

    console.error = (...args: unknown[]) => {
      malformedLogs.push(args.map(String).join(" "));
    };
    let response;
    try {
      response = await POST(
        new Request("http://localhost/api/payments/webhooks/adyen", { method: "POST", body }),
        { params: Promise.resolve({ provider: "adyen" }) },
      );
    } finally {
      console.error = originalConsoleError;
    }

    // The delivery stays a structured acknowledgement, and normalized array
    // fields preserve the provider's event order alongside the valid sibling.
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      received: true,
      status: "processed",
      events: [
        { externalRef: "PSP-ROUTE-ARRAY", status: "unknown_attempt" },
        { externalRef: "PSP-ROUTE-GOOD", status: "unknown_attempt" },
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
    assert.equal(emitted[0]!.externalRef, "PSP-ROUTE-BAD");
  } finally {
    console.error = originalConsoleError;
    await dropScratchOrg(org.orgId);
  }
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

test("the route returns 500 after isolating a poison event and committing its later sibling", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Webhook Tester", "admin");
    const invoiceId = randomUUID();
    const linkId = randomUUID();
    const secret = "gc-ingestion-secret";
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, currency, fx_rate, subtotal, tax_total, total,
         open_balance, created_by)
      values (${invoiceId}, ${org.orgId}, 'customer_invoice', 'draft', 'INV-GC-BATCH',
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
        { resource_type: "payments", action: "confirmed", links: { payment: "PM-1", billing_request: "BRQ-1" } },
        { resource_type: "payments", action: "failed", links: { payment: "PM-2", billing_request: "BRQ-2" } },
      ],
    });
    const signature = createHmac("sha256", secret).update(body, "utf8").digest("hex");
    const response = await POST(
      new Request("http://localhost/api/payments/webhooks/gocardless", {
        method: "POST",
        headers: { "webhook-signature": signature },
        body,
      }),
      { params: Promise.resolve({ provider: "gocardless" }) },
    );

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      received: true,
      status: "processing_failed",
      events: [
        { externalRef: "PM-1", status: "processing_failed" },
        { externalRef: "PM-2", status: "failed" },
      ],
    });
    const attempts = await db.execute<{
      external_ref: string;
      status: string;
      event_payload: Record<string, unknown> | null;
    }>(sql`
      select external_ref, status, event_payload from payment_attempts
       where org_id = ${org.orgId} and link_id = ${linkId}
       order by external_ref
    `);
    assert.deepEqual(attempts.rows, [
      { external_ref: "BRQ-1", status: "initiated", event_payload: null },
      {
        external_ref: "PM-2",
        status: "failed",
        event_payload: { webhook: true, status: "failed" },
      },
    ]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
