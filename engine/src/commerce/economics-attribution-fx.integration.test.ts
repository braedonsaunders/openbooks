import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { registerChannelAdapter } from "./adapters.ts";
import { upsertAccountMap } from "./account-maps.ts";
import { createChannel, retryChannel, markChannelActive } from "./channels.ts";
import { ingestChannelOrder } from "./orders.ts";
import { postChannelOrder } from "./order-posting.ts";
import { setPostingPolicy } from "./posting-policies.ts";
import { upsertChannelLocation } from "./locations.ts";
import { postDueDailySummariesForOrg } from "./daily-summary.ts";
import {
  getOrderEconomics,
  recomputeOrderEconomics,
  recordChannelAdSpend,
} from "./economics.ts";
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

async function setup(org: ScratchOrg, actor: string, mode: "per_order" | "daily_summary"): Promise<string> {
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
  await withBypass(() => setPostingPolicy(org.orgId, actor, { channelId, mode, effectiveFrom: org.date }));
  const maps: Array<[string, string, string]> = [
    ["gateway_clearing", "shopify_payments", org.accounts.bank],
    ["revenue", "", org.accounts.revenue],
    ["discount", "", org.accounts.revenue],
    ["shipping_income", "", org.accounts.revenue],
    ["gift_card_liability", "", org.accounts.bank],
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
  return channelId;
}

function summaryOrder(externalId: string, quantity: string, subtotalMinor: bigint, taxMinor: bigint): ChannelOrder {
  const total = subtotalMinor + taxMinor;
  return {
    externalId,
    number: `#${externalId}`,
    customerExternalId: null,
    customerName: null,
    customerEmail: null,
    customerAddress: null,
    tags: [],
    source: "web",
    shopCurrency: "CAD",
    presentmentCurrency: "CAD",
    subtotalMinor,
    taxMinor,
    shippingMinor: 0n,
    discountMinor: 0n,
    totalMinor: total,
    financialStatus: "paid",
    fulfilmentStatus: "unfulfilled",
    lines: [{
      sku: "TEE-RED-M", variantExternalId: null, title: "Red Tee — M", quantity,
      priceMinor: 2500n, discountMinor: 0n, discountCode: null,
      taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: taxMinor, ratePercent: "8.625" }],
      giftCard: false, promotionId: null,
    }],
    shippingLines: [],
    tenders: [{ gateway: "shopify_payments", amountMinor: total, giftCardExternalId: null, authorizationRef: null }],
    orderedAt: "2026-07-15T12:00:00Z",
    cancelledAt: null,
  };
}

function sumBy(rows: Array<{ component: string; amountMinor: bigint }>, component: string): bigint {
  return rows.filter((row) => row.component === component).reduce((sum, row) => sum + row.amountMinor, 0n);
}

test("a summary batch attributes per-order COGS by quantity, exact to the minor unit", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const channelId = await setup(org, actor, "daily_summary");
    // Two layers so the split has dust: 2 units at 2.00 plus 1 at 2.01.
    // Three units issue for 601; weights 1:2 give quotas 200.33/400.67, so
    // the second order takes the remainder: 200 and 401.
    await withBypass(() => receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "2", unitCost: "2",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    }));
    await withBypass(() => receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "1", unitCost: "2.01",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    }));
    const a = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, summaryOrder("4001", "1", 2500n, 216n)));
    const b = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, summaryOrder("4002", "2", 5000n, 431n)));
    const batch = await withBypass(() => postDueDailySummariesForOrg(org.orgId, actor));
    assert.equal(batch.posted, 2);
    // The batch marks every summarized order for restatement.
    const pending = (await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*)::text as count from channel_order_economics_pending where org_id = ${org.orgId}`))).rows[0]!;
    assert.equal(pending.count, "2");
    await withBypass(() => recomputeOrderEconomics(org.orgId, actor, a.id));
    await withBypass(() => recomputeOrderEconomics(org.orgId, actor, b.id));
    const economicsA = await withBypass(() => getOrderEconomics(org.orgId, a.id));
    const economicsB = await withBypass(() => getOrderEconomics(org.orgId, b.id));
    assert.equal(sumBy(economicsA.facts, "cogs"), -200n);
    assert.equal(sumBy(economicsB.facts, "cogs"), -401n);
    assert.equal(economicsA.cm1, 2300n);
    assert.equal(economicsB.cm1, 4599n);
    // Both shares name the summary cash sale — not a per-order document.
    const summaryDoc = (await withOrgContext(org.orgId, () => db.execute<{ posting_document_id: string }>(sql`
      select posting_document_id from channel_daily_summaries where org_id = ${org.orgId}`))).rows[0]!;
    for (const economics of [economicsA, economicsB]) {
      for (const fact of economics.facts.filter((row) => row.component === "cogs")) {
        assert.equal(fact.sourceRef, `posting:${summaryDoc.posting_document_id}`);
      }
      assert.equal(economics.mixedCurrency, false);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("foreign-currency label and ad spend convert at the business-date spot into the sums", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const channelId = await setup(org, actor, "per_order");
    await withBypass(() => receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    }));
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, summaryOrder("4003", "1", 2500n, 216n)));
    const outcome = await withBypass(() => postChannelOrder(org.orgId, actor, stored.id));
    assert.equal(outcome.status, "posted");
    // The carrier bills in USD and the ad platform reports in USD; the
    // order's day carries a USD→CAD spot of 1.3605.
    await withOrgContext(org.orgId, () => db.execute(sql`
      insert into fx_rates (id, org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${randomUUID()}, ${org.orgId}, 'USD', 'CAD', '2026-07-15', 'spot', '1.3605000000', 'test')`));
    const cashId = (await withOrgContext(org.orgId, () => db.execute<{ posting_document_id: string }>(sql`
      select posting_document_id from channel_orders where id = ${stored.id} and org_id = ${org.orgId}`))).rows[0]!;
    const shipmentId = (await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
      insert into documents (org_id, kind, document_number, document_date, currency, status, created_by, updated_by)
      values (${org.orgId}, 'shipment', ${`SHP-FX-${stored.id.slice(0, 8)}`}, ${org.date}, 'CAD', 'draft', ${actor}, ${actor})
      returning id`))).rows[0]!.id;
    await withOrgContext(org.orgId, () => db.execute(sql`
      insert into warehouses (org_id, stock_location_id, name, status, created_by, updated_by)
      values (${org.orgId}, ${org.stockLocationId}, 'Test Warehouse', 'active', ${actor}, ${actor})
      on conflict do nothing`));
    await withOrgContext(org.orgId, () => db.execute(sql`
      insert into fulfillment_documents (org_id, document_id, stage, warehouse_id, created_by, updated_by)
      values (${org.orgId}, ${shipmentId}, 'open', ${org.stockLocationId}, ${actor}, ${actor})
      on conflict do nothing`));
    const carrierAccountId = (await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
      insert into shipping_accounts (org_id, name, provider, mode, status, created_by, updated_by)
      values (${org.orgId}, 'Test Carrier', 'easypost', 'test', 'active', ${actor}, ${actor})
      on conflict do nothing
      returning id`))).rows[0]?.id
      ?? (await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
        select id from shipping_accounts where org_id = ${org.orgId} and name = 'Test Carrier'`))).rows[0]!.id;
    await withOrgContext(org.orgId, () => db.execute(sql`
      insert into shipment_labels
        (org_id, shipment_document_id, order_document_id, account_id, provider, provider_shipment_id,
         provider_rate_id, carrier, service, rate_minor, rate_currency, status, purchased_at, created_by, updated_by)
      values (${org.orgId}, ${shipmentId}, ${cashId.posting_document_id}, ${carrierAccountId},
        'easypost', 'shp-fx', 'rate-fx', 'USPS', 'Ground', '1000', 'USD',
        'purchased', now(), ${actor}, ${actor})`));
    await withBypass(() => recordChannelAdSpend(org.orgId, actor, {
      channelId,
      spendDate: "2026-07-15",
      amountMinor: 5000n,
      currency: "USD",
      source: "platform-export",
    }));
    await withBypass(() => recomputeOrderEconomics(org.orgId, actor, stored.id));
    const economics = await withBypass(() => getOrderEconomics(org.orgId, stored.id));
    // 1000 USD cents at 1.3605 → 1360.5 → 1361; 5000 → 6802.5 → 6803.
    assert.equal(sumBy(economics.facts, "shipping_label"), -1361n);
    assert.equal(sumBy(economics.facts, "ad_spend"), -6803n);
    assert.equal(economics.mixedCurrency, false);
    for (const fact of economics.facts.filter((row) => row.component === "shipping_label" || row.component === "ad_spend")) {
      assert.equal(fact.currency, "CAD");
      assert.ok(fact.sourceRef.includes("USD@"), `original currency kept as evidence, got ${fact.sourceRef}`);
    }
    // CM2 carries the converted label, CM3 the converted spend.
    assert.equal(economics.cm2, economics.cm1 - 1361n);
    assert.equal(economics.cm3, economics.cm2 - 6803n);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
