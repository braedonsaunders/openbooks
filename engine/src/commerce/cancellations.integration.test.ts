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
import { postChannelRefund } from "./refunds.ts";
import type { ChannelOrder, ChannelRefund } from "./contracts.ts";
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
    unpaidCreatesSalesOrder: true,
    effectiveFrom: org.date,
  }));
  const extra = new Map<string, string>();
  for (const [key, number, name] of [
    ["discount", "4020", "Sales Discounts"],
    ["shipping", "4030", "Shipping Income"],
    ["gift", "2310", "Gift Card Liability"],
  ] as Array<[string, string, string]>) {
    const type = key === "discount" ? "expense" : key === "gift" ? "liability_current_other" : "income";
    const id = (await db.execute<{ id: string }>(sql`
      insert into accounts (org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
      returning id`)).rows[0]!.id;
    extra.set(key, id);
  }
  for (const [role, key, accountId] of [
    ["gateway_clearing", "shopify_payments", org.accounts.bank],
    ["revenue", "", org.accounts.revenue],
    ["discount", "", extra.get("discount")!],
    ["shipping_income", "", extra.get("shipping")!],
    ["gift_card_liability", "", extra.get("gift")!],
    ["rounding", "", extra.get("discount")!],
    ["sales_tax_liability", "NY", org.accounts.taxOutput],
  ] as Array<[string, string, string]>) {
    await withBypass(() => upsertAccountMap(org.orgId, actor, { channelId, role, key, accountId, effectiveFrom: org.date }));
  }
  await withBypass(() => upsertChannelLocation(org.orgId, actor, {
    channelId,
    externalLocationId: "wh-1",
    externalName: "Warehouse",
    stockLocationId: org.stockLocationId,
    fulfilsOrders: true,
  }));
  await db.execute(sql`update items set code = 'TEE-RED-M' where id = ${org.items.fifo} and org_id = ${org.orgId}`);
  await withBypass(() => receiveInventory(org.orgId, actor, {
    itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2",
    subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
  }));
  return { org, actor, channelId };
}

function unpaidOrder(externalId: string): ChannelOrder {
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
    financialStatus: "unpaid",
    fulfilmentStatus: "unfulfilled",
    lines: [{
      sku: "TEE-RED-M", variantExternalId: null, title: "Red Tee — M", quantity: "1",
      priceMinor: 2500n, discountMinor: 0n, discountCode: null,
      taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 216n, ratePercent: "8.625" }],
      giftCard: false, promotionId: null,
    }],
    shippingLines: [],
    tenders: [],
    orderedAt: "2026-07-15T12:00:00Z",
    cancelledAt: null,
  };
}

function paidOrder(externalId: string): ChannelOrder {
  return {
    ...unpaidOrder(externalId),
    financialStatus: "paid",
    tenders: [{ gateway: "shopify_payments", amountMinor: 2716n, giftCardExternalId: null, authorizationRef: "auth-9" }],
  };
}

function fullRefund(orderExternalId: string, refundId: string): ChannelRefund {
  return {
    externalId: refundId,
    orderExternalId,
    reason: "cancelled with refund",
    restock: false,
    totalMinor: 2716n,
    lines: [{ lineExternalId: null, sku: "TEE-RED-M", variantExternalId: null, quantity: "1", amountMinor: 2500n, taxMinor: null, restock: false }],
    shippingMinor: 0n,
    tenders: [{ gateway: "shopify_payments", amountMinor: 2716n }],
    refundedAt: "2026-07-16T09:00:00Z",
  };
}

test("an unpaid cancellation voids its sales order", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor);
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, unpaidOrder("3001")));
    const sale = await withBypass(() => postChannelOrder(org.orgId, actor, stored.id));
    if (sale.status !== "posted") {
      const parked = (await withOrgContext(org.orgId, () => db.execute<{ code: string | null; reason: string | null }>(sql`
        select exception_code as code, exception_reason as reason from channel_orders
         where id = ${stored.id} and org_id = ${org.orgId}`))).rows[0];
      assert.fail(`order parked as ${parked?.code}: ${parked?.reason}`);
    }
    assert.ok(sale.documentId);
    const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "3001", {
      kind: "cancellation",
      externalId: "cancel:3001",
      occurredAt: "2026-07-16T09:00:00Z",
    }));
    const outcome = await withBypass(() => postChannelCancellation(org.orgId, actor, event.eventId));
    assert.equal(outcome.status, "posted");
    const doc = (await withOrgContext(org.orgId, () => db.execute<{ kind: string; status: string }>(sql`
      select kind, status from documents where id = ${sale.documentId} and org_id = ${org.orgId}`))).rows[0]!;
    assert.equal(doc.kind, "sales_order");
    assert.equal(doc.status, "voided");
    // A replay closes on the voided order instead of voiding twice.
    assert.equal((await withBypass(() => postChannelCancellation(org.orgId, actor, event.eventId))).status, "posted");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a paid cancellation waits for its refund and never double-posts", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor);
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("3002")));
    assert.equal((await withBypass(() => postChannelOrder(org.orgId, actor, stored.id))).status, "posted");
    const cancel = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "3002", {
      kind: "cancellation",
      externalId: "cancel:3002",
      occurredAt: "2026-07-16T09:00:00Z",
    }));
    // The money has moved: the cancellation waits for the refund.
    assert.equal((await withBypass(() => postChannelCancellation(org.orgId, actor, cancel.eventId))).status, "pending");
    const refund = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "3002", {
      kind: "refund",
      externalId: "r-3002",
      refund: fullRefund("3002", "r-3002"),
      occurredAt: "2026-07-16T10:00:00Z",
    }));
    assert.equal((await withBypass(() => postChannelRefund(org.orgId, actor, refund.eventId))).status, "posted");
    // The refund retires the cancellation: exactly one cash refund exists.
    assert.equal((await withBypass(() => postChannelCancellation(org.orgId, actor, cancel.eventId))).status, "ignored");
    const refunds = (await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*)::text as count from documents
       where org_id = ${org.orgId} and kind = 'cash_refund' and status = 'posted'
         and custom->>'channelOrderId' = ${stored.id}`))).rows[0]!;
    assert.equal(refunds.count, "1");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a cancelled pending order never posts", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor);
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, unpaidOrder("3003")));
    const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "3003", {
      kind: "cancellation",
      externalId: "cancel:3003",
      occurredAt: "2026-07-16T09:00:00Z",
    }));
    assert.equal((await withBypass(() => postChannelCancellation(org.orgId, actor, event.eventId))).status, "posted");
    const order = (await withOrgContext(org.orgId, () => db.execute<{ posting_status: string }>(sql`
      select posting_status from channel_orders where id = ${stored.id} and org_id = ${org.orgId}`))).rows[0]!;
    assert.equal(order.posting_status, "excluded");
    assert.equal((await withBypass(() => postChannelOrder(org.orgId, actor, stored.id))).status, "excluded");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
