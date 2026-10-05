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
import { postChannelFulfilment, requestChannelFulfilmentPush } from "./fulfilments.ts";
import type { ChannelFulfilment } from "./orders.ts";
import type { ChannelOrder } from "./contracts.ts";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { receiveInventory } from "../inventory/movements.ts";
import { sealJson } from "../platform/secrets.ts";
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

async function setup(org: ScratchOrg, actor: string, fulfilsOrders: boolean): Promise<Fixture> {
  await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ salesChannels: true })}::jsonb, true) where id = ${org.orgId}`);
  const created = await withBypass(() => createChannel(org.orgId, actor, {
    kind: "shopify",
    name: "Test Shop",
    currency: "CAD",
    externalAccount: "test.myshopify.com",
    subsidiaryId: org.subsidiaryId,
    settings: {},
  }));
  const channelId = created.channel.id;
  await withBypass(() => retryChannel(org.orgId, actor, channelId, "test"));
  await withBypass(() => markChannelActive(org.orgId, actor, channelId));
  const { setPostingPolicy } = await import("./posting-policies.ts");
  await withBypass(() => setPostingPolicy(org.orgId, actor, {
    channelId,
    mode: "per_order",
    createPromotionOnMatchMiss: true,
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
    externalLocationId: "wh-3pl",
    externalName: "3PL warehouse",
    stockLocationId: org.stockLocationId,
    fulfilsOrders,
  }));
  await db.execute(sql`update items set code = 'TEE-RED-M' where id = ${org.items.fifo} and org_id = ${org.orgId}`);
  await withBypass(() => receiveInventory(org.orgId, actor, {
    itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2",
    subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
  }));
  // A sealed fake token: the push test swaps the network, never the secret.
  const sealed = sealJson({ accessToken: "fake-token" }, { orgId: org.orgId, purpose: "sales_channel.secrets" });
  await db.execute(sql`update sales_channels set secrets = ${sealed} where org_id = ${org.orgId} and id = ${channelId}`);
  return { org, actor, channelId };
}

function paidOrder(externalId: string): ChannelOrder {
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
    subtotalMinor: 5000n,
    taxMinor: 431n,
    shippingMinor: 0n,
    discountMinor: 0n,
    totalMinor: 5431n,
    financialStatus: "paid",
    fulfilmentStatus: "unfulfilled",
    lines: [{
      sku: "TEE-RED-M", variantExternalId: null, title: "Red Tee — M", quantity: "2",
      priceMinor: 2500n, discountMinor: 0n, discountCode: null,
      taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 431n, ratePercent: "8.625" }],
      giftCard: false, promotionId: null,
    }],
    shippingLines: [],
    tenders: [{ gateway: "shopify_payments", amountMinor: 5431n, giftCardExternalId: null, authorizationRef: "auth-1" }],
    orderedAt: "2026-07-15T12:00:00Z",
    cancelledAt: null,
  };
}

function inboundFulfilment(orderExternalId: string, externalId: string, overrides: Partial<ChannelFulfilment> = {}): ChannelFulfilment {
  return {
    externalId,
    orderExternalId,
    locationExternalId: "wh-3pl",
    status: "success",
    cancelled: false,
    trackingNumber: "TRK-1",
    trackingUrl: null,
    carrierName: "UPS",
    lines: [{ lineExternalId: "11", sku: "TEE-RED-M", variantExternalId: null, quantity: "2" }],
    fulfilledAt: "2026-07-16T10:00:00Z",
    ...overrides,
  };
}

async function issueCount(orgId: string, itemId: string): Promise<string> {
  const row = (await withOrgContext(orgId, () => db.execute<{ count: string }>(sql`
    select count(*)::text as count from inventory_movements
     where org_id = ${orgId} and item_id = ${itemId} and kind = 'issue' and status = 'posted'`))).rows[0]!;
  return row.count;
}

async function onHand(orgId: string, itemId: string, locationId: string): Promise<string> {
  const row = (await withOrgContext(orgId, () => db.execute<{ quantity: string }>(sql`
    select coalesce(sum(quantity), 0)::text as quantity from inventory_movements
     where org_id = ${orgId} and item_id = ${itemId} and stock_location_id = ${locationId}`))).rows[0]!;
  return row.quantity;
}

test("inbound fulfilment issues stock and records COGS when the sale posted without issue", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, false);
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("2001")));
    assert.equal((await withBypass(() => postChannelOrder(org.orgId, actor, stored.id))).status, "posted");
    // The storefront fulfils: the sale posted revenue but moved no stock.
    assert.equal(await issueCount(org.orgId, org.items.fifo), "0");
    const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "2001", {
      kind: "fulfilment",
      externalId: "fulfilment:F1",
      fulfilment: inboundFulfilment("2001", "F1"),
      occurredAt: "2026-07-16T10:00:00Z",
    }));
    assert.equal((await withBypass(() => postChannelFulfilment(org.orgId, actor, event.eventId))).status, "posted");
    assert.equal(await issueCount(org.orgId, org.items.fifo), "1");
    const issue = (await withOrgContext(org.orgId, () => db.execute<{ quantity: string; total_value: string; unit_cost: string; entry: string | null }>(sql`
      select quantity::text as quantity, total_value::text as total_value, unit_cost::text as unit_cost, journal_entry_id as entry
        from inventory_movements
       where org_id = ${org.orgId} and item_id = ${org.items.fifo} and kind = 'issue' and status = 'posted'`))).rows[0]!;
    assert.equal(issue.quantity, "-2.0000");
    // COGS at the layer cost: the units left at 2.00, and the issue carries
    // its journal entry — the sale's revenue finally has its cost.
    assert.equal(issue.total_value, "-4.0000");
    assert.equal(issue.unit_cost, "2.0000");
    assert.ok(issue.entry);
    assert.equal(await onHand(org.orgId, org.items.fifo, org.stockLocationId), "8.0000");
    // A replay never issues twice: the idempotency key holds.
    assert.equal((await withBypass(() => postChannelFulfilment(org.orgId, actor, event.eventId))).status, "posted");
    assert.equal(await issueCount(org.orgId, org.items.fifo), "1");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("inbound fulfilment behind an issued sale is tracking-only", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, true);
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("2002")));
    assert.equal((await withBypass(() => postChannelOrder(org.orgId, actor, stored.id))).status, "posted");
    // OpenBooks fulfilled: the sale already relieved the stock.
    assert.equal(await issueCount(org.orgId, org.items.fifo), "1");
    const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "2002", {
      kind: "fulfilment",
      externalId: "fulfilment:F2",
      fulfilment: inboundFulfilment("2002", "F2"),
      occurredAt: "2026-07-16T10:00:00Z",
    }));
    assert.equal((await withBypass(() => postChannelFulfilment(org.orgId, actor, event.eventId))).status, "posted");
    assert.equal(await issueCount(org.orgId, org.items.fifo), "1");
    assert.equal(await onHand(org.orgId, org.items.fifo, org.stockLocationId), "8.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an unmapped fulfilment location parks with its remedy", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, false);
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("2003")));
    assert.equal((await withBypass(() => postChannelOrder(org.orgId, actor, stored.id))).status, "posted");
    const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "2003", {
      kind: "fulfilment",
      externalId: "fulfilment:F3",
      fulfilment: inboundFulfilment("2003", "F3", { locationExternalId: "wh-nope" }),
      occurredAt: "2026-07-16T10:00:00Z",
    }));
    const outcome = await withBypass(() => postChannelFulfilment(org.orgId, actor, event.eventId));
    assert.equal(outcome.status, "exception");
    assert.equal(outcome.code, "unmapped_fulfilment_location");
    const parked = (await withOrgContext(org.orgId, () => db.execute<{ reason: string; remedy: string }>(sql`
      select exception_reason as reason, exception_remedy as remedy from channel_order_events
       where id = ${event.eventId} and org_id = ${org.orgId}`))).rows[0]!;
    assert.match(parked.reason, /wh-nope/);
    assert.match(parked.remedy, /Map the storefront location/);
    assert.equal(await issueCount(org.orgId, org.items.fifo), "0");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("partial fulfilments split one sale line across events with linkage", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, false);
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("2006")));
    assert.equal((await withBypass(() => postChannelOrder(org.orgId, actor, stored.id))).status, "posted");
    assert.equal(await issueCount(org.orgId, org.items.fifo), "0");
    const first = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "2006", {
      kind: "fulfilment",
      externalId: "fulfilment:F6a",
      fulfilment: inboundFulfilment("2006", "F6a", {
        lines: [{ lineExternalId: "11", sku: "TEE-RED-M", variantExternalId: null, quantity: "1" }],
      }),
      occurredAt: "2026-07-16T10:00:00Z",
    }));
    assert.equal((await withBypass(() => postChannelFulfilment(org.orgId, actor, first.eventId))).status, "posted");
    assert.equal(await onHand(org.orgId, org.items.fifo, org.stockLocationId), "9.0000");
    const second = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "2006", {
      kind: "fulfilment",
      externalId: "fulfilment:F6b",
      fulfilment: inboundFulfilment("2006", "F6b", {
        lines: [{ lineExternalId: "11", sku: "TEE-RED-M", variantExternalId: null, quantity: "1" }],
      }),
      occurredAt: "2026-07-17T10:00:00Z",
    }));
    assert.equal((await withBypass(() => postChannelFulfilment(org.orgId, actor, second.eventId))).status, "posted");
    // Exactly the ordered total moved, across two linked issues.
    assert.equal(await issueCount(org.orgId, org.items.fifo), "2");
    assert.equal(await onHand(org.orgId, org.items.fifo, org.stockLocationId), "8.0000");
    const saleLine = (await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
      select dl.id from document_lines dl
       join documents d on d.id = dl.document_id and d.org_id = dl.org_id
       join channel_orders o on o.posting_document_id = d.id and o.org_id = d.org_id
      where o.org_id = ${org.orgId} and o.external_id = '2006' and dl.item_id = ${org.items.fifo}`))).rows[0]!;
    const linked = (await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*)::text as count from inventory_movements
       where org_id = ${org.orgId} and item_id = ${org.items.fifo} and kind = 'issue' and status = 'posted'
         and document_line_id = ${saleLine.id}`))).rows[0]!;
    assert.equal(linked.count, "2");
    // A third unit would over-ship: it still leaves the shelf (stock truth),
    // unlinked, with the overage named in its memo.
    const third = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "2006", {
      kind: "fulfilment",
      externalId: "fulfilment:F6c",
      fulfilment: inboundFulfilment("2006", "F6c", {
        lines: [{ lineExternalId: "11", sku: "TEE-RED-M", variantExternalId: null, quantity: "1" }],
      }),
      occurredAt: "2026-07-18T10:00:00Z",
    }));
    assert.equal((await withBypass(() => postChannelFulfilment(org.orgId, actor, third.eventId))).status, "posted");
    assert.equal(await onHand(org.orgId, org.items.fifo, org.stockLocationId), "7.0000");
    const bare = (await withOrgContext(org.orgId, () => db.execute<{ memo: string | null }>(sql`
      select memo from inventory_movements
       where org_id = ${org.orgId} and item_id = ${org.items.fifo} and kind = 'issue' and status = 'posted'
         and document_line_id is null`))).rows;
    assert.equal(bare.length, 1);
    assert.match(bare[0]!.memo ?? "", /above the ordered quantity/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a cancelled fulfilment reverses its issue", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, false);
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("2004")));
    assert.equal((await withBypass(() => postChannelOrder(org.orgId, actor, stored.id))).status, "posted");
    const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "2004", {
      kind: "fulfilment",
      externalId: "fulfilment:F4",
      fulfilment: inboundFulfilment("2004", "F4"),
      occurredAt: "2026-07-16T10:00:00Z",
    }));
    assert.equal((await withBypass(() => postChannelFulfilment(org.orgId, actor, event.eventId))).status, "posted");
    assert.equal(await onHand(org.orgId, org.items.fifo, org.stockLocationId), "8.0000");
    const cancel = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "2004", {
      kind: "fulfilment",
      externalId: "fulfilment-cancel:F4",
      fulfilment: inboundFulfilment("2004", "F4", { status: "cancelled", cancelled: true }),
      occurredAt: "2026-07-17T10:00:00Z",
    }));
    assert.equal((await withBypass(() => postChannelFulfilment(org.orgId, actor, cancel.eventId))).status, "posted");
    assert.equal(await onHand(org.orgId, org.items.fifo, org.stockLocationId), "10.0000");
    const reversal = (await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
      select r.id from inventory_movements r
       join inventory_movements m on m.id = r.reverses_movement_id
       where r.org_id = ${org.orgId} and m.item_id = ${org.items.fifo} and m.kind = 'issue'`))).rows;
    assert.equal(reversal.length, 1);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

function fakeShopifyTransport(calls: Array<{ query: string; variables: unknown }>): typeof fetch {
  return (async (url: unknown, init: unknown) => {
    const body = JSON.parse(String((init as { body: string }).body)) as { query: string; variables: unknown };
    calls.push({ query: body.query, variables: body.variables });
    const data = body.query.includes("ChannelFulfillmentOrders")
      ? {
          order: {
            fulfillmentOrders: {
              edges: [{
                node: {
                  id: "gid://shopify/FulfillmentOrder/900",
                  status: "OPEN",
                  lineItems: {
                    edges: [{
                      node: {
                        id: "gid://shopify/FulfillmentOrderLineItem/1",
                        quantity: 2,
                        lineItem: { id: "gid://shopify/LineItem/11", sku: "TEE-RED-M" },
                      },
                    }],
                  },
                },
              }],
            },
          },
        }
      : {
          fulfillmentCreate: {
            fulfillment: { id: "gid://shopify/Fulfillment/700", status: "SUCCESS" },
            userErrors: [],
          },
        };
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

test("a manual push fulfils the order at Shopify with a fake server", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, true);
    void channelId;
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("2005")));
    assert.equal((await withBypass(() => postChannelOrder(org.orgId, actor, stored.id))).status, "posted");
    const calls: Array<{ query: string; variables: unknown }> = [];
    const outcome = await withBypass(() => requestChannelFulfilmentPush(
      org.orgId, actor, { orderId: stored.id }, { shopifyTransport: fakeShopifyTransport(calls) },
    ));
    assert.equal(outcome.status, "posted");
    assert.ok(outcome.eventId);
    const create = calls.find((call) => call.query.includes("ChannelFulfillmentCreate"));
    assert.ok(create, "the push sends the fulfilment mutation");
    const fulfillment = (create!.variables as { fulfillment: Record<string, unknown> }).fulfillment;
    const lineGroups = fulfillment.lineItemsByFulfillmentOrder as Array<{
      fulfillmentOrderId: string;
      fulfillmentOrderLineItems: Array<{ id: string; quantity: number }>;
    }>;
    assert.equal(lineGroups.length, 1);
    assert.equal(lineGroups[0]!.fulfillmentOrderId, "gid://shopify/FulfillmentOrder/900");
    assert.deepEqual(lineGroups[0]!.fulfillmentOrderLineItems, [{ id: "gid://shopify/FulfillmentOrderLineItem/1", quantity: 2 }]);
    assert.equal(fulfillment.notifyCustomer, false);
    const link = (await withOrgContext(org.orgId, () => db.execute<{ external_id: string }>(sql`
      select external_id from external_links
       where org_id = ${org.orgId} and provider = 'shopify' and object_type = 'fulfillment'`))).rows;
    assert.equal(link.length, 1);
    assert.equal(link[0]!.external_id, "gid://shopify/Fulfillment/700");
    // A replay observes the link instead of pushing twice.
    const before = calls.length;
    const replay = await withBypass(() => requestChannelFulfilmentPush(
      org.orgId, actor, { orderId: stored.id }, { shopifyTransport: fakeShopifyTransport(calls) },
    ));
    assert.equal(replay.status, "posted");
    assert.equal(calls.length, before);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
