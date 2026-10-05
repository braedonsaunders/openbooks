import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { channelAdapter } from "../adapters.ts";
import { upsertAccountMap } from "../account-maps.ts";
import { createChannel, retryChannel, markChannelActive } from "../channels.ts";
import { upsertChannelLocation } from "../locations.ts";
import { setPostingPolicy } from "../posting-policies.ts";
import { CommerceError } from "../errors.ts";
import { ensureShopifyAdapterRegistered } from "./adapter.ts";
import { db, withBypass } from "../../platform/db.ts";
import { receiveInventory } from "../../inventory/movements.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

ensureShopifyAdapterRegistered();

async function setupShop(org: ScratchOrg, actor: string): Promise<string> {
  await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ salesChannels: true, storedValue: true, promotions: true })}::jsonb, true) where id = ${org.orgId}`);
  const created = await withBypass(() => createChannel(org.orgId, actor, {
    kind: "shopify",
    name: "Test Shop",
    currency: "CAD",
    externalAccount: "test.myshopify.com",
    secrets: { accessToken: "shpat_test", mode: "token" },
    webhookSecret: "whsec_test",
    settings: {},
  }));
  const channelId = created.channel.id;
  await withBypass(() => retryChannel(org.orgId, actor, channelId, "test"));
  await withBypass(() => markChannelActive(org.orgId, actor, channelId));
  await withBypass(() => setPostingPolicy(org.orgId, actor, {
    channelId,
    mode: "per_order",
    createPromotionOnMatchMiss: true,
    effectiveFrom: org.date,
  }));
  const extra: Array<[string, string, string, string]> = [
    ["clearing", "1015", "Shopify Clearing", "asset_bank"],
    ["discount", "4020", "Sales Discounts", "expense"],
    ["shipping", "4030", "Shipping Income", "income"],
    ["gift", "2310", "Gift Card Liability", "liability_current_other"],
  ];
  const accounts: Record<string, string> = {};
  for (const [key, number, name, type] of extra) {
    accounts[key] = (await db.execute<{ id: string }>(sql`
      insert into accounts (org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
      returning id`)).rows[0]!.id;
  }
  const maps: Array<[string, string, string]> = [
    ["gateway_clearing", "shopify_payments", accounts.clearing!],
    ["revenue", "", org.accounts.revenue],
    ["discount", "", accounts.discount!],
    ["shipping_income", "", accounts.shipping!],
    ["gift_card_liability", "", accounts.gift!],
    ["sales_tax_liability", "NY", org.accounts.taxOutput],
  ];
  for (const [role, key, accountId] of maps) {
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
  return channelId;
}

/** Documented Shopify REST order shape: 2 × 25.00 + 6.00 shipping + 4.83 NY tax = 60.83 CAD, paid. */
function shopifyOrder(): Record<string, unknown> {
  return {
    id: 7001,
    name: "#7001",
    email: "bob@example.com",
    currency: "CAD",
    financial_status: "paid",
    fulfillment_status: null,
    subtotal_price: "50.00",
    total_discounts: "0.00",
    total_tax: "4.83",
    total_price: "60.83",
    created_at: "2026-07-15T12:00:00Z",
    customer: { id: 9001, first_name: "Bob", last_name: "Norman", email: "bob@example.com" },
    line_items: [
      {
        title: "Red Tee — M", sku: "TEE-RED-M", variant_id: 8001, quantity: 2, price: "25.00",
        discount_allocations: [],
        tax_lines: [{ title: "NY", price: "4.31", rate: 0.08625 }],
      },
    ],
    shipping_lines: [
      { title: "Standard", price: "6.00", discounted_price: "6.00", tax_lines: [{ title: "NY", price: "0.52", rate: 0.08625 }] },
    ],
    payment_gateway_names: ["shopify_payments"],
    discount_codes: [],
    tags: "",
    source_name: "web",
  };
}

function delivery(orgId: string, channelId: string, topic: string, body: unknown) {
  return {
    eventId: `evt-${topic}-${Date.now()}`,
    topic,
    channelId,
    orgId,
    rawBody: Buffer.from(JSON.stringify(body), "utf8"),
    headers: { "x-shopify-shop-domain": "test.myshopify.com" },
  };
}

test(
  "orders/create through the adapter posts one cash sale and redelivery is a no-op",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actor = await withBypass(() => createScratchUser(org.orgId, "shopify routing", "shopify_routing"));
      const channelId = await setupShop(org, actor);
      const adapter = channelAdapter("shopify");
      const first = await adapter.handleEvent(delivery(org.orgId, channelId, "orders/create", shopifyOrder()));
      assert.equal(first.action, "processed");
      const ref = first.resultRef as { postingStatus?: string; documentId?: string | null };
      assert.equal(ref.postingStatus, "posted");
      assert.ok(ref.documentId, "paid order posts its cash sale immediately");
      const rows = (await db.execute<{ id: string; posting_status: string; posting_document_id: string | null }>(sql`
        select id, posting_status, posting_document_id from channel_orders
         where org_id = ${org.orgId} and channel_id = ${channelId} and external_id = '7001'`)).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.posting_status, "posted");
      assert.equal(rows[0]!.posting_document_id, ref.documentId);
      const repeat = await adapter.handleEvent(delivery(org.orgId, channelId, "orders/create", shopifyOrder()));
      assert.equal((repeat.resultRef as { documentId?: string }).documentId, ref.documentId);
      const again = (await db.execute<{ count: string }>(sql`
        select count(*)::text as count from channel_orders
         where org_id = ${org.orgId} and channel_id = ${channelId} and external_id = '7001'`)).rows[0]!.count;
      assert.equal(again, "1");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "refunds for an unknown order refuse by name and payouts stay deferred",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const actor = await withBypass(() => createScratchUser(org.orgId, "shopify routing", "shopify_routing"));
      const channelId = await setupShop(org, actor);
      const adapter = channelAdapter("shopify");
      await assert.rejects(
        () => adapter.handleEvent(delivery(org.orgId, channelId, "refunds/create", {
          id: 8101, order_id: 4242, created_at: "2026-07-16T12:00:00Z", note: null,
          refund_line_items: [], transactions: [{ gateway: "shopify_payments", amount: "60.83" }],
        })),
        (error: unknown) => error instanceof CommerceError && error.code === "channel_order_unknown",
        "a refund without its order refuses instead of parking nowhere",
      );
      const payout = await adapter.handleEvent(delivery(org.orgId, channelId, "shopify_payments/payouts", { id: "p1" }));
      assert.equal(payout.action, "ignored");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
