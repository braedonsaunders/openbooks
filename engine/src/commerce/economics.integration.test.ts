import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { registerChannelAdapter } from "./adapters.ts";
import { upsertAccountMap } from "./account-maps.ts";
import { createChannel, retryChannel, markChannelActive } from "./channels.ts";
import { ingestChannelEvent, ingestChannelOrder } from "./orders.ts";
import { postChannelOrder } from "./order-posting.ts";
import { setPostingPolicy } from "./posting-policies.ts";
import { upsertChannelLocation } from "./locations.ts";
import {
  getChannelMarginSummary,
  getOrderEconomics,
  recomputeOrderEconomics,
  recomputePendingOrderEconomics,
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

async function setup(org: ScratchOrg, actor: string): Promise<string> {
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
  const ids: Record<string, string> = {};
  for (const [key, number, name, type] of extra) {
    ids[key] = (await db.execute<{ id: string }>(sql`
      insert into accounts (org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
      returning id`)).rows[0]!.id;
  }
  const maps: Array<[string, string, string]> = [
    ["gateway_clearing", "shopify_payments", ids["clearing"]!],
    ["revenue", "", org.accounts.revenue],
    ["discount", "", ids["discount"]!],
    ["shipping_income", "", ids["shipping"]!],
    ["gift_card_liability", "", ids["gift"]!],
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
  await db.execute(sql`update items set code = 'MUG-WHITE' where id = ${org.items.movingAvg} and org_id = ${org.orgId}`);
  await withBypass(() => receiveInventory(org.orgId, actor, {
    itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2",
    subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
  }));
  await withBypass(() => receiveInventory(org.orgId, actor, {
    itemId: org.items.movingAvg, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "3",
    subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
  }));
  return channelId;
}

/**
 * Two stocked lines, one discounted, plus a shipping line: merchandise 6200
 * with a 500 discount, shipping 600, tax 586, total 6886. COGS is 700 at the
 * received layer costs (2 at 2.00 plus 1 at 3.00).
 */
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
    presentmentCurrency: "USD",
    subtotalMinor: 6200n,
    taxMinor: 586n,
    shippingMinor: 600n,
    discountMinor: 500n,
    totalMinor: 6886n,
    financialStatus: "paid",
    fulfilmentStatus: "unfulfilled",
    lines: [
      {
        sku: "TEE-RED-M", variantExternalId: null, title: "Red Tee — M", quantity: "2",
        priceMinor: 2500n, discountMinor: 500n, discountCode: "SAVE10",
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 431n, ratePercent: "8.625" }],
        giftCard: false, promotionId: null,
      },
      {
        sku: "MUG-WHITE", variantExternalId: null, title: "White Mug", quantity: "1",
        priceMinor: 1200n, discountMinor: 0n, discountCode: null,
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 103n, ratePercent: "8.625" }],
        giftCard: false, promotionId: null,
      },
    ],
    shippingLines: [
      {
        title: "Standard", amountMinor: 600n, discountMinor: 0n,
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 52n, ratePercent: "8.625" }],
      },
    ],
    tenders: [{ gateway: "shopify_payments", amountMinor: 6886n, giftCardExternalId: null, authorizationRef: "auth-1" }],
    orderedAt: "2026-07-15T12:00:00Z",
    cancelledAt: null,
  };
}

async function postPaidOrder(org: ScratchOrg, actor: string, channelId: string, externalId: string): Promise<string> {
  const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder(externalId)));
  const outcome = await withBypass(() => postChannelOrder(org.orgId, actor, stored.id));
  assert.equal(outcome.status, "posted");
  return stored.id;
}

function sumBy(rows: Array<{ component: string; amountMinor: bigint }>, component: string): bigint {
  return rows.filter((row) => row.component === component).reduce((sum, row) => sum + row.amountMinor, 0n);
}

async function settlePayout(
  org: ScratchOrg,
  actor: string,
  externalRef: string,
  orderExternalId: string,
  feeMinor: bigint,
): Promise<void> {
  const feeText = `${feeMinor < 0n ? "-" : ""}${(feeMinor < 0n ? -feeMinor : feeMinor) / 100n}.${String((feeMinor < 0n ? -feeMinor : feeMinor) % 100n).padStart(2, "0")}`;
  const batchId = (await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
    insert into psp_settlement_batches
      (org_id, provider, external_ref, status, currency, gross_amount, fee_amount, refund_amount,
       dispute_amount, net_amount, fx_amount, settlement_date, subsidiary_id, line_count, created_by, updated_by)
    values (${org.orgId}, 'shopify_payments', ${externalRef}, 'draft', 'CAD', '68.86', ${feeText}, '0',
      '0', '68.86', '0', '2026-07-16', ${org.subsidiaryId}, 2, ${actor}, ${actor})
    returning id`))).rows[0]!.id;
  await withOrgContext(org.orgId, () => db.execute(sql`
    insert into psp_settlement_lines (org_id, batch_id, line_number, kind, external_ref, description, amount, currency, meta, created_by, updated_by)
    values (${org.orgId}, ${batchId}, 1, 'charge', 'txn-1', ${`charge for order ${orderExternalId}`}, '68.86', 'CAD',
      ${JSON.stringify({ shopifyType: "charge", sourceOrderId: orderExternalId })}::jsonb, ${actor}, ${actor}),
      (${org.orgId}, ${batchId}, 2, 'fee', 'txn-1_fee', 'Shopify Payments transaction fee', ${feeText}, 'CAD',
      ${JSON.stringify({ shopifyType: "charge_fee" })}::jsonb, ${actor}, ${actor})`));
}

async function buyLabel(
  org: ScratchOrg,
  actor: string,
  orderId: string,
  rateMinor: bigint,
): Promise<void> {
  const doc = (await withOrgContext(org.orgId, () => db.execute<{ posting_document_id: string }>(sql`
    select posting_document_id from channel_orders where id = ${orderId} and org_id = ${org.orgId}`))).rows[0]!;
  // A shipment document behind the label: the label references the shipment
  // for fulfilment and the cash sale for margin, exactly like a bought label.
  const shipmentId = (await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
    insert into documents (org_id, kind, document_number, document_date, currency, status, created_by, updated_by)
    values (${org.orgId}, 'shipment', ${`SHP-${orderId.slice(0, 8)}`}, ${org.date}, 'CAD', 'draft', ${actor}, ${actor})
    returning id`))).rows[0]!.id;
  // A relabeled order reuses the same warehouse and shipment staging row;
  // both conflicts are expected on repeat buys and benign.
  await withOrgContext(org.orgId, () => db.execute(sql`
    insert into warehouses (org_id, stock_location_id, name, status, created_by, updated_by)
    values (${org.orgId}, ${org.stockLocationId}, 'Test Warehouse', 'active', ${actor}, ${actor})
    on conflict do nothing`));
  await withOrgContext(org.orgId, () => db.execute(sql`
    insert into fulfillment_documents (org_id, document_id, stage, warehouse_id, created_by, updated_by)
    values (${org.orgId}, ${shipmentId}, 'open', ${org.stockLocationId}, ${actor}, ${actor})
    on conflict do nothing`));
  // Repeat buys reuse the same test carrier account; the conflict is
  // expected and benign, so the first row wins.
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
    values (${org.orgId}, ${shipmentId}, ${doc.posting_document_id}, ${carrierAccountId},
      'easypost', 'shp-1', 'rate-1', 'USPS', 'Ground', ${rateMinor.toString()}, 'CAD',
      'purchased', now(), ${actor}, ${actor})`));
}

test("posting stores revenue, discount and actual-issue COGS facts", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const channelId = await setup(org, actor);
    // The post trigger recomputes: no manual call between posting and reading.
    const orderId = await postPaidOrder(org, actor, channelId, "2001");
    const economics = await withBypass(() => getOrderEconomics(org.orgId, orderId));
    assert.equal(sumBy(economics.facts, "net_revenue"), 6800n);
    assert.equal(sumBy(economics.facts, "discount"), -500n);
    // Actual FIFO layer costs: 2 units at 2.00 plus 1 at 3.00.
    assert.equal(sumBy(economics.facts, "cogs"), -700n);
    // CM1 is revenue minus COGS: 6300 − 700.
    assert.equal(economics.cm1, 5600n);
    assert.equal(economics.currency, "CAD");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("label cost and settled fees split exactly across lines by value", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const channelId = await setup(org, actor);
    const orderId = await postPaidOrder(org, actor, channelId, "2002");
    await buyLabel(org, actor, orderId, 450n);
    await settlePayout(org, actor, "payout-1", "2002", 200n);
    await withBypass(() => recomputeOrderEconomics(org.orgId, actor, orderId));
    const economics = await withBypass(() => getOrderEconomics(org.orgId, orderId));
    // Every allocated part sums back to its source total, to the minor unit.
    assert.equal(sumBy(economics.facts, "shipping_label"), -450n);
    assert.equal(sumBy(economics.facts, "processor_fee"), -200n);
    assert.equal(economics.facts.filter((row) => row.component === "processor_fee" && row.estimated).length, 0);
    // CM2 is CM1 minus fulfilment and payment fees: 5600 − 450 − 200.
    assert.equal(economics.cm2, 4950n);
    // The margin ratio is derived from stored sums, never a stored fact.
    assert.equal(economics.marginPct, "78.5714");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a late label cost restates the order and keeps history", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const channelId = await setup(org, actor);
    const orderId = await postPaidOrder(org, actor, channelId, "2003");
    await buyLabel(org, actor, orderId, 450n);
    await withBypass(() => recomputeOrderEconomics(org.orgId, actor, orderId));
    // The carrier corrects the label cost after the first restatement.
    await withOrgContext(org.orgId, () => db.execute(sql`
      update shipment_labels set rate_minor = 550 where org_id = ${org.orgId} and status = 'purchased'`));
    // The label writer marks the order; the scan drain recomputes and clears.
    // A retried delivery of the same mark collides on (org, order); the
    // conflict is expected and benign, so the first mark wins.
    await withOrgContext(org.orgId, () => db.execute(sql`
      insert into channel_order_economics_pending (org_id, order_id, reason)
      values (${org.orgId}, ${orderId}, 'shipping label purchased')
      on conflict (org_id, order_id) do nothing`));
    const drained = await withBypass(() => recomputePendingOrderEconomics(org.orgId, actor, 10));
    assert.equal(drained.orders, 1);
    const economics = await withBypass(() => getOrderEconomics(org.orgId, orderId));
    assert.equal(sumBy(economics.facts, "shipping_label"), -550n);
    const history = (await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*)::text as count from channel_order_economics
       where org_id = ${org.orgId} and order_id = ${orderId} and not is_current`))).rows[0]!;
    // The superseded 450 allocation survives beside the current 550 one.
    assert.ok(Number(history.count) >= 3);
    const retired = (await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*)::text as count from channel_order_economics_pending
       where org_id = ${org.orgId} and order_id = ${orderId}`))).rows[0]!;
    assert.equal(retired.count, "0");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a fee estimate gives way to settled fees without double counting", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const channelId = await setup(org, actor);
    // The first order settles, establishing the channel's realized fee rate.
    const firstId = await postPaidOrder(org, actor, channelId, "2004");
    await settlePayout(org, actor, "payout-2", "2004", 200n);
    await withBypass(() => recomputeOrderEconomics(org.orgId, actor, firstId));
    // The second order has no payout yet, so its fee is an estimate.
    const secondId = await postPaidOrder(org, actor, channelId, "2005");
    const estimated = await withBypass(() => getOrderEconomics(org.orgId, secondId));
    const estimateRows = estimated.facts.filter((row) => row.component === "processor_fee");
    assert.ok(estimateRows.length > 0);
    assert.ok(estimateRows.every((row) => row.estimated));
    // Settling the second order retires the estimate: one fee story, told once.
    await settlePayout(org, actor, "payout-3", "2005", 200n);
    await withBypass(() => recomputeOrderEconomics(org.orgId, actor, secondId));
    const settled = await withBypass(() => getOrderEconomics(org.orgId, secondId));
    assert.equal(sumBy(settled.facts, "processor_fee"), -200n);
    assert.equal(settled.facts.filter((row) => row.component === "processor_fee" && row.estimated).length, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("imported daily ad spend allocates to CM3 and shows in the summary", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const channelId = await setup(org, actor);
    const orderId = await postPaidOrder(org, actor, channelId, "2007");
    // A day's export from the ad platform lands against the order's day.
    const { spendId } = await withBypass(() => recordChannelAdSpend(org.orgId, actor, {
      channelId,
      spendDate: "2026-07-15",
      amountMinor: 68000n,
      currency: "CAD",
      source: "platform-export",
    }));
    assert.ok(typeof spendId === "string" && spendId.length > 0);
    await withBypass(() => recomputeOrderEconomics(org.orgId, actor, orderId));
    const economics = await withBypass(() => getOrderEconomics(org.orgId, orderId));
    assert.equal(sumBy(economics.facts, "ad_spend"), -68000n);
    assert.equal(economics.cm3, economics.cm2 - 68000n);
    // The fixture order predates the trailing month, so the summary reads the full window.
    const summary = await withBypass(() => getChannelMarginSummary(org.orgId, 90));
    assert.equal(summary.length, 1);
    assert.equal(summary[0]!.orders, 1);
    assert.equal(summary[0]!.revenueMinor, 6300n);
    assert.equal(summary[0]!.adSpendMinor, 68000n);
    // Re-importing the same source replaces its figure instead of doubling it.
    await withBypass(() => recordChannelAdSpend(org.orgId, actor, {
      channelId,
      spendDate: "2026-07-15",
      amountMinor: 34000n,
      currency: "CAD",
      source: "platform-export",
    }));
    await withBypass(() => recomputeOrderEconomics(org.orgId, actor, orderId));
    const reimported = await withBypass(() => getOrderEconomics(org.orgId, orderId));
    assert.equal(sumBy(reimported.facts, "ad_spend"), -34000n);
    // A spend that is not a calendar day refuses with its remedy.
    await assert.rejects(
      withBypass(() => recordChannelAdSpend(org.orgId, actor, {
        channelId,
        spendDate: "15-07-2026",
        amountMinor: 100n,
        currency: "CAD",
        source: "platform-export",
      })),
      /calendar day/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a fulfilment event refreshes economics before posting", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const channelId = await setup(org, actor);
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("2006")));
    await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "2006", {
      kind: "fulfilment",
      externalId: "ful-1",
      occurredAt: "2026-07-15T14:00:00Z",
    }));
    const economics = await withBypass(() => getOrderEconomics(org.orgId, stored.id));
    assert.equal(sumBy(economics.facts, "net_revenue"), 6800n);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
