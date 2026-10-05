import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { registerChannelAdapter } from "./adapters.ts";
import { upsertAccountMap } from "./account-maps.ts";
import { createChannel, retryChannel, markChannelActive } from "./channels.ts";
import { upsertChannelLocation } from "./locations.ts";
import { ingestChannelEvent, ingestChannelOrder } from "./orders.ts";
import { postChannelOrder } from "./order-posting.ts";
import { postChannelCancellation } from "./cancellations.ts";
import type { ChannelOrder } from "./contracts.ts";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { receiveInventory } from "../inventory/movements.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

registerChannelAdapter({
  kind: "shopify",
  describeSettings: () => z.object({}).strict(),
  verifyWebhook: () => ({ eventId: "test", topic: "test" }),
  testConnection: async () => ({ ok: true, detail: "test" }),
  handleEvent: async () => ({ action: "ignored", resultRef: {} }),
  workspaceTabs: () => [],
});

interface Fixture {
  org: ScratchOrg;
  actor: string;
  channelId: string;
}

/**
 * A 3PL shelf: the single mapped location does not fulfil, so paid orders
 * post governed — cash at once plus a draft sales order behind it.
 */
async function setup(org: ScratchOrg, actor: string): Promise<Fixture> {
  await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ salesChannels: true })}::jsonb, true) where id = ${org.orgId}`);
  const created = await withBypass(() => createChannel(org.orgId, actor, {
    kind: "shopify",
    name: "Test Shop",
    currency: "CAD",
    externalAccount: "test.myshopify.com",
    settings: {},
  }));
  const channelId = created.channel.id;
  await withBypass(() => retryChannel(org.orgId, actor, channelId, "test"));
  await withBypass(() => markChannelActive(org.orgId, actor, channelId));
  const { setPostingPolicy } = await import("./posting-policies.ts");
  await withBypass(() => setPostingPolicy(org.orgId, actor, {
    channelId,
    mode: "per_order",
    effectiveFrom: org.date,
  }));
  for (const [role, key, accountId] of [
    ["gateway_clearing", "shopify_payments", org.accounts.bank],
    ["revenue", "", org.accounts.revenue],
    ["discount", "", org.accounts.revenue],
    ["shipping_income", "", org.accounts.revenue],
    ["gift_card_liability", "", org.accounts.bank],
    ["rounding", "", org.accounts.revenue],
    ["sales_tax_liability", "NY", org.accounts.taxOutput],
  ] as Array<[string, string, string]>) {
    await withBypass(() => upsertAccountMap(org.orgId, actor, { channelId, role, key, accountId, effectiveFrom: org.date }));
  }
  await withBypass(() => upsertChannelLocation(org.orgId, actor, {
    channelId,
    externalLocationId: "3pl-1",
    externalName: "3PL Shelf",
    stockLocationId: org.stockLocationId,
    fulfilsOrders: false,
  }));
  await db.execute(sql`update items set code = 'TEE-RED-M' where id = ${org.items.fifo} and org_id = ${org.orgId}`);
  await withBypass(() => receiveInventory(org.orgId, actor, {
    itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2",
    subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
  }));
  return { org, actor, channelId };
}

function paidOrder(externalId: string, overrides: Partial<ChannelOrder> = {}): ChannelOrder {
  return {
    externalId,
    number: `#${externalId}`,
    customerExternalId: "cust-1",
    customerName: "Bob Norman",
    customerEmail: "bob@example.com",
    customerAddress: null,
    tags: [],
    source: "web",
    shopCurrency: "CAD",
    presentmentCurrency: "CAD",
    subtotalMinor: 2500n,
    taxMinor: 216n,
    shippingMinor: 0n,
    discountMinor: 0n,
    totalMinor: 2716n,
    financialStatus: "paid",
    fulfilmentStatus: "unfulfilled",
    lines: [{
      sku: "TEE-RED-M", variantExternalId: null, title: "Red Tee — M", quantity: "1",
      priceMinor: 2500n, discountMinor: 0n, discountCode: null,
      taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 216n, ratePercent: "8.625" }],
      giftCard: false, promotionId: null,
    }],
    shippingLines: [],
    tenders: [{ gateway: "shopify_payments", amountMinor: 2716n, giftCardExternalId: null, authorizationRef: "auth-1" }],
    orderedAt: "2026-07-15T12:00:00Z",
    cancelledAt: null,
    ...overrides,
  };
}

async function governingDraft(orgId: string, externalId: string): Promise<{ id: string; status: string } | null> {
  const row = (await withOrgContext(orgId, () => db.execute<{ id: string; status: string }>(sql`
    select id, status from documents
     where org_id = ${orgId} and kind = 'sales_order'
       and external_ref = ${`channel-sales-order:${externalId}`}`))).rows[0];
  return row ?? null;
}

async function closeAudit(orgId: string, documentId: string): Promise<{ outcome: string; actor: string | null } | null> {
  const row = (await withOrgContext(orgId, () => db.execute<{ changes: { outcome: string }; actor_id: string | null }>(sql`
    select changes, actor_id from audit_log
     where org_id = ${orgId} and table_name = 'documents' and row_id = ${documentId}
       and action = 'update' and changes->>'event' = 'governing_order_closed'
     order by at desc, id desc limit 1`))).rows[0];
  return row ? { outcome: row.changes.outcome, actor: row.actor_id } : null;
}

test("a fulfilled and settled order closes its governing draft with audit", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor);
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("3001")));
    assert.equal((await withBypass(() => postChannelOrder(org.orgId, actor, stored.id))).status, "posted");
    // The governed sale leaves its draft behind while the 3PL still holds
    // the units: cash posted, draft open.
    const draft = await governingDraft(org.orgId, "3001");
    assert.ok(draft);
    assert.equal(draft.status, "draft");
    // The storefront reports fulfilment on the next order update; the draft
    // closes on that update with the cash untouched.
    await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("3001", { fulfilmentStatus: "fulfilled" })));
    const closed = await governingDraft(org.orgId, "3001");
    assert.ok(closed);
    assert.equal(closed.status, "voided");
    const audit = await closeAudit(org.orgId, closed.id);
    assert.ok(audit);
    assert.equal(audit.outcome, "fulfilled_settled");
    assert.equal(audit.actor, actor);
    const cash = (await withOrgContext(org.orgId, () => db.execute<{ posting_status: string }>(sql`
      select posting_status from channel_orders where id = ${stored.id} and org_id = ${org.orgId}`))).rows[0]!;
    assert.equal(cash.posting_status, "posted");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a cancelled order closes its governing draft while the money waits for its refund", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor);
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("3002")));
    assert.equal((await withBypass(() => postChannelOrder(org.orgId, actor, stored.id))).status, "posted");
    const draft = await governingDraft(org.orgId, "3002");
    assert.ok(draft);
    assert.equal(draft.status, "draft");
    const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "3002", {
      kind: "cancellation",
      externalId: "cancel:3002",
      cancellationReason: "buyer remorse",
      occurredAt: "2026-07-16T09:00:00Z",
    }));
    // Paid, so the money waits for the refund — but nothing will ever
    // fulfil, so the draft still closes now.
    const outcome = await withBypass(() => postChannelCancellation(org.orgId, actor, event.eventId));
    assert.equal(outcome.status, "pending");
    const closed = await governingDraft(org.orgId, "3002");
    assert.ok(closed);
    assert.equal(closed.status, "voided");
    const audit = await closeAudit(org.orgId, closed.id);
    assert.ok(audit);
    assert.equal(audit.outcome, "cancelled");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
