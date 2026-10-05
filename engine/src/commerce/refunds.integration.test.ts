import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { registerChannelAdapter } from "./adapters.ts";
import { upsertAccountMap } from "./account-maps.ts";
import { createChannel, retryChannel, markChannelActive } from "./channels.ts";
import { linkExternal } from "./external-links.ts";
import { upsertChannelLocation } from "./locations.ts";
import { ingestChannelEvent, ingestChannelOrder } from "./orders.ts";
import { postChannelOrder } from "./order-posting.ts";
import { postChannelRefund } from "./refunds.ts";
import { CommerceError } from "./errors.ts";
import { postDueDailySummariesForOrg } from "./daily-summary.ts";
import { setPostingPolicy } from "./posting-policies.ts";
import type { ChannelOrder, ChannelRefund } from "./contracts.ts";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { receiveInventory } from "../inventory/movements.ts";
import { createProgram, issueStoredValue } from "../stored-value/accounts.ts";
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
  accounts: { clearing: string; discount: string; shipping: string; gift: string; rounding: string };
}

async function setup(org: ScratchOrg, actor: string, mode: "per_order" | "daily_summary"): Promise<Fixture> {
  await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ salesChannels: true, cashSales: true, storedValue: true, promotions: true })}::jsonb, true) where id = ${org.orgId}`);
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
    mode,
    createPromotionOnMatchMiss: true,
    effectiveFrom: org.date,
  }));
  const extra: Array<[string, string, string]> = [
    ["clearing", "1015", "Shopify Clearing"],
    ["discount", "4020", "Sales Discounts"],
    ["shipping", "4030", "Shipping Income"],
    ["gift", "2310", "Gift Card Liability"],
    ["rounding", "4040", "Rounding"],
  ];
  const accounts = {} as Fixture["accounts"];
  for (const [key, number, name] of extra) {
    const type = key === "clearing" ? "asset_bank" : key === "gift" ? "liability_current_other" : key === "discount" || key === "rounding" ? "expense" : "income";
    const id = (await db.execute<{ id: string }>(sql`
      insert into accounts (org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
      returning id`)).rows[0]!.id;
    accounts[key as keyof Fixture["accounts"]] = id;
  }
  const maps: Array<[string, string, string]> = [
    ["gateway_clearing", "shopify_payments", accounts.clearing],
    ["gateway_clearing", "gift_card", accounts.clearing],
    ["revenue", "", org.accounts.revenue],
    ["discount", "", accounts.discount],
    ["shipping_income", "", accounts.shipping],
    ["gift_card_liability", "", accounts.gift],
    ["rounding", "", accounts.rounding],
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
  return { org, actor, channelId, accounts };
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
    ...overrides,
  };
}

function fullRefund(orderExternalId: string, refundId: string, overrides: Partial<ChannelRefund> = {}): ChannelRefund {
  return {
    externalId: refundId,
    orderExternalId,
    reason: "damaged in transit",
    restock: true,
    totalMinor: 6886n,
    lines: [
      { lineExternalId: "1", sku: "TEE-RED-M", variantExternalId: null, quantity: "2", amountMinor: 4500n, taxMinor: null, restock: true },
      { lineExternalId: "2", sku: "MUG-WHITE", variantExternalId: null, quantity: "1", amountMinor: 1200n, taxMinor: null, restock: true },
    ],
    shippingMinor: 600n,
    tenders: [{ gateway: "shopify_payments", amountMinor: 6886n }],
    refundedAt: "2026-07-16T09:00:00Z",
    ...overrides,
  };
}

async function journalSum(orgId: string, documentId: string): Promise<bigint> {
  const legs = (await withOrgContext(orgId, () => db.execute<{ amount: string }>(sql`
    select l.amount::text as amount from journal_lines l
     join journal_entries e on e.id = l.entry_id
     where l.org_id = ${orgId} and l.entry_id = (
       select posted_entry_id from documents where id = ${documentId} and org_id = ${orgId})
       and e.status in ('posted','reversed')`))).rows;
  return legs.reduce((sum, leg) => {
    const [whole, frac = ""] = leg.amount.split(".");
    return sum + BigInt(`${whole}${(frac + "0000").slice(0, 4)}`);
  }, 0n);
}

async function stockPosition(orgId: string, itemId: string, locationId: string): Promise<{ quantity: string; value: string }> {
  const row = (await withOrgContext(orgId, () => db.execute<{ quantity: string; value: string }>(sql`
    select coalesce(sum(quantity), 0)::text as quantity, coalesce(sum(total_value), 0)::text as value
      from inventory_movements
     where org_id = ${orgId} and item_id = ${itemId} and stock_location_id = ${locationId}`))).rows[0]!;
  return { quantity: row.quantity, value: row.value };
}

test("full refund posts a balanced cash refund and restocks at original cost", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId, accounts } = await setup(org, actor, "per_order");
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("1001")));
    const sale = await withBypass(() => postChannelOrder(org.orgId, actor, stored.id));
    assert.equal(sale.status, "posted");
    // The price moves after the sale: cheaper units arrive before the refund.
    // The restock must restore the cost the units LEFT at, not today's cost.
    await withBypass(() => receiveInventory(org.orgId, actor, {
      itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "5", unitCost: "5",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    }));
    const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "1001", {
      kind: "refund",
      externalId: "r-9001",
      refund: fullRefund("1001", "r-9001"),
      occurredAt: "2026-07-16T09:00:00Z",
    }));
    const outcome = await withBypass(() => postChannelRefund(org.orgId, actor, event.eventId));
    assert.equal(outcome.status, "posted");
    assert.ok(outcome.documentId);
    const doc = (await withOrgContext(org.orgId, () => db.execute<{ kind: string; status: string; total: string; tax_total: string }>(sql`
      select kind, status, total::text as total, tax_total::text as tax_total
        from documents where id = ${outcome.documentId} and org_id = ${org.orgId}`))).rows[0]!;
    assert.equal(doc.kind, "cash_refund");
    assert.equal(doc.status, "posted");
    assert.equal(doc.total, "68.8600");
    assert.equal(doc.tax_total, "5.8600");
    assert.equal(await journalSum(org.orgId, outcome.documentId!), 0n);
    // The discount reversal carries the tee's tax code at zero tax, so the
    // refunded taxable base nets to the 63.00 the sale taxed, not 68.00.
    const components = (await withOrgContext(org.orgId, () => db.execute<{ amount: string; taxable: string; tax: string }>(sql`
      select dl.amount::text as amount, c.taxable_amount::text as taxable, c.tax_amount::text as tax
        from document_lines dl
        join document_line_tax_components c on c.document_line_id = dl.id and c.org_id = dl.org_id
       where dl.org_id = ${org.orgId} and dl.document_id = ${outcome.documentId}`))).rows;
    assert.deepEqual(
      components.filter((c) => c.amount.startsWith("-")).map((c) => [c.taxable, c.tax]),
      [["-5.0000", "0.0000"]],
    );
    assert.equal(components.reduce((sum, c) => {
      const negative = c.taxable.startsWith("-");
      const [whole, frac = ""] = c.taxable.replace("-", "").split(".");
      const units = BigInt(`${whole}${(frac + "0000").slice(0, 4)}`);
      return sum + (negative ? -units : units);
    }, 0n), 630000n);
    // The payout credits the gateway clearing the sale debited.
    const clearing = (await withOrgContext(org.orgId, () => db.execute<{ amount: string }>(sql`
      select l.amount::text as amount from journal_lines l
       join journal_entries e on e.id = l.entry_id
       where l.org_id = ${org.orgId} and l.account_id = ${accounts.clearing}
         and l.entry_id = (select posted_entry_id from documents where id = ${outcome.documentId} and org_id = ${org.orgId})
         and e.status in ('posted','reversed')`))).rows;
    assert.equal(clearing.length, 1);
    assert.equal(clearing[0]!.amount, "-68.8600");
    // Both units are back on the shelf: 10 received, 2 sold, 2 returned.
    const tee = await stockPosition(org.orgId, org.items.fifo, org.stockLocationId);
    assert.equal(Number(tee.quantity), 15);
    // …at the original 2.00: 20.00 − 4.00 + 25.00 + 4.00, never 10.00.
    assert.equal(tee.value, "45.0000");
    const mug = await stockPosition(org.orgId, org.items.movingAvg, org.stockLocationId);
    assert.equal(Number(mug.quantity), 10);
    assert.equal(mug.value, "30.0000");
    // Every restocked line names its source issue movement.
    const evidence = (await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*)::text as count from document_lines
       where document_id = ${outcome.documentId} and org_id = ${org.orgId}
         and custom ? 'inventoryReturn'`))).rows[0]!;
    assert.equal(evidence.count, "2");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a second full refund refuses as over-refund by name", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, "per_order");
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("1002")));
    const sale = await withBypass(() => postChannelOrder(org.orgId, actor, stored.id));
    assert.equal(sale.status, "posted");
    const first = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "1002", {
      kind: "refund",
      externalId: "r-9002",
      refund: fullRefund("1002", "r-9002"),
      occurredAt: "2026-07-16T09:00:00Z",
    }));
    assert.equal((await withBypass(() => postChannelRefund(org.orgId, actor, first.eventId))).status, "posted");
    const second = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "1002", {
      kind: "refund",
      externalId: "r-9003",
      refund: fullRefund("1002", "r-9003"),
      occurredAt: "2026-07-17T09:00:00Z",
    }));
    const outcome = await withBypass(() => postChannelRefund(org.orgId, actor, second.eventId));
    assert.equal(outcome.status, "exception");
    assert.equal(outcome.code, "over_refund");
    const parked = (await withOrgContext(org.orgId, () => db.execute<{ code: string; reason: string; remedy: string }>(sql`
      select exception_code as code, exception_reason as reason, exception_remedy as remedy
        from channel_order_events where id = ${second.eventId} and org_id = ${org.orgId}`))).rows[0]!;
    assert.equal(parked.code, "over_refund");
    assert.match(parked.reason, /already returned/);
    assert.match(parked.remedy, /manual cash refund/);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("replaying a posted refund is a no-op", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, "per_order");
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("1003")));
    assert.equal((await withBypass(() => postChannelOrder(org.orgId, actor, stored.id))).status, "posted");
    const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "1003", {
      kind: "refund",
      externalId: "r-9004",
      refund: fullRefund("1003", "r-9004"),
      occurredAt: "2026-07-16T09:00:00Z",
    }));
    const first = await withBypass(() => postChannelRefund(org.orgId, actor, event.eventId));
    assert.equal(first.status, "posted");
    const second = await withBypass(() => postChannelRefund(org.orgId, actor, event.eventId));
    assert.equal(second.status, "posted");
    assert.equal(second.documentId, first.documentId);
    const count = (await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*)::text as count from documents
       where org_id = ${org.orgId} and external_source = 'shopify' and external_ref = 'r-9004'`))).rows[0]!;
    assert.equal(count.count, "1");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a refund behind an unposted order parks until the sale posts", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, "per_order");
    const broken: ChannelOrder = {
      ...paidOrder("1004"),
      lines: [{
        sku: "NOPE-404", variantExternalId: null, title: "Ghost Tee", quantity: "1",
        priceMinor: 2500n, discountMinor: 0n, discountCode: null,
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 216n, ratePercent: "8.625" }],
        giftCard: false, promotionId: null,
      }],
      subtotalMinor: 2500n,
      taxMinor: 216n,
      shippingMinor: 0n,
      shippingLines: [],
      discountMinor: 0n,
      totalMinor: 2716n,
      tenders: [{ gateway: "shopify_payments", amountMinor: 2716n, giftCardExternalId: null, authorizationRef: null }],
    };
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, broken));
    const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "1004", {
      kind: "refund",
      externalId: "r-9005",
      refund: {
        externalId: "r-9005",
        orderExternalId: "1004",
        reason: "changed mind",
        restock: false,
        totalMinor: 2716n,
        lines: [{ lineExternalId: null, sku: "NOPE-404", variantExternalId: null, quantity: "1", amountMinor: 2500n, taxMinor: null, restock: false }],
        shippingMinor: 0n,
        tenders: [{ gateway: "shopify_payments", amountMinor: 2716n }],
        refundedAt: "2026-07-16T09:00:00Z",
      },
      occurredAt: "2026-07-16T09:00:00Z",
    }));
    const outcome = await withBypass(() => postChannelRefund(org.orgId, actor, event.eventId));
    assert.equal(outcome.status, "exception");
    assert.equal(outcome.code, "refund_unposted_order");
    void stored;
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("gift card tender pays back onto the same stored-value card", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId, accounts } = await setup(org, actor, "per_order");
    void accounts;
    const program = await withBypass(() => createProgram({
      orgId: org.orgId, name: "Test gift cards", kind: "gift_card", currency: "CAD",
      liabilityAccountId: org.accounts.taxOutput, actorId: actor,
    }));
    const issued = await withBypass(() => issueStoredValue({
      orgId: org.orgId, programId: program.id, amountMinor: 500000n, currency: "CAD",
      debitAccountId: org.accounts.bank, idempotencyKey: `test-gc-refund-1005`, postingDate: org.date, actorId: actor,
    }));
    await withBypass(() => linkExternal(org.orgId, actor, {
      channelId, provider: "shopify", externalAccount: "test.myshopify.com",
      objectType: "gift_card", externalId: "gc-777",
      nativeTable: "stored_value_accounts", nativeId: issued.accountId,
    }, "salesChannels"));
    const order: ChannelOrder = {
      ...paidOrder("1005"),
      lines: [{
        sku: "MUG-WHITE", variantExternalId: null, title: "White Mug", quantity: "1",
        priceMinor: 1200n, discountMinor: 0n, discountCode: null,
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 103n, ratePercent: "8.625" }],
        giftCard: false, promotionId: null,
      }],
      subtotalMinor: 1200n,
      taxMinor: 103n,
      shippingMinor: 0n,
      shippingLines: [],
      discountMinor: 0n,
      totalMinor: 1303n,
      tenders: [
        { gateway: "gift_card", amountMinor: 1000n, giftCardExternalId: "gc-777", authorizationRef: null },
        { gateway: "shopify_payments", amountMinor: 303n, giftCardExternalId: null, authorizationRef: null },
      ],
    };
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, order));
    assert.equal((await withBypass(() => postChannelOrder(org.orgId, actor, stored.id))).status, "posted");
    const before = (await withOrgContext(org.orgId, () => db.execute<{ balance_minor: string }>(sql`
      select balance_minor from stored_value_accounts where id = ${issued.accountId} and org_id = ${org.orgId}`))).rows[0]!;
    const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "1005", {
      kind: "refund",
      externalId: "r-9006",
      refund: {
        externalId: "r-9006",
        orderExternalId: "1005",
        reason: "changed mind",
        restock: false,
        totalMinor: 1303n,
        lines: [{ lineExternalId: null, sku: "MUG-WHITE", variantExternalId: null, quantity: "1", amountMinor: 1200n, taxMinor: null, restock: false }],
        shippingMinor: 0n,
        tenders: [
          { gateway: "gift_card", amountMinor: 1000n },
          { gateway: "shopify_payments", amountMinor: 303n },
        ],
        refundedAt: "2026-07-16T09:00:00Z",
      },
      occurredAt: "2026-07-16T09:00:00Z",
    }));
    const outcome = await withBypass(() => postChannelRefund(org.orgId, actor, event.eventId));
    assert.equal(outcome.status, "posted");
    const after = (await withOrgContext(org.orgId, () => db.execute<{ balance_minor: string }>(sql`
      select balance_minor from stored_value_accounts where id = ${issued.accountId} and org_id = ${org.orgId}`))).rows[0]!;
    assert.ok(BigInt(after.balance_minor) - BigInt(before.balance_minor) > 0n);
    assert.equal(after.balance_minor, "500000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a mixed kit restocks its stocked components and settles the service line in money", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, "per_order");
    // A gift set: one stocked unit plus a commercial-only service line that
    // never touches the shelf (and carries no costing profile).
    const kitId = randomUUID();
    await db.execute(sql`
      insert into items (id, org_id, kind, name, show_on_timesheet, is_active, custom, create_plans_on, revenue_allocation, income_account_id)
      values (${kitId}, ${org.orgId}, 'kit', 'Gift Set', false, true, '{}'::jsonb, 'billing', 'normal', ${org.accounts.revenue})`);
    await db.execute(sql`update items set code = 'KIT-MIXED' where id = ${kitId} and org_id = ${org.orgId}`);
    // The kit line itself carries a profile like any stocked line, even
    // though only its components ever move.
    await db.execute(sql`
      insert into item_inventory_profiles
        (id, org_id, item_id, costing_method, tracking, asset_account_id, cogs_account_id, adjustment_account_id,
         variance_account_id, received_not_billed_account_id, standard_cost, base_unit, unit_conversions)
      values (${randomUUID()}, ${org.orgId}, ${kitId}, 'fifo', 'none', ${org.accounts.invAsset}, ${org.accounts.cogs},
        ${org.accounts.adjustment}, ${org.accounts.adjustment}, ${org.accounts.clearing}, null, 'ea', '{}'::jsonb)`);
    for (const [componentId, sortOrder] of [[org.items.fifo, 0], [org.items.service, 1]] as const) {
      await db.execute(sql`
        insert into bom_components (id, org_id, assembly_item_id, component_item_id, quantity_per, sort_order)
        values (${randomUUID()}, ${org.orgId}, ${kitId}, ${componentId}, '1', ${sortOrder})`);
    }
    const order: ChannelOrder = {
      ...paidOrder("2001"),
      lines: [{
        sku: "KIT-MIXED", variantExternalId: null, title: "Gift Set", quantity: "1",
        priceMinor: 2500n, discountMinor: 0n, discountCode: null,
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 216n, ratePercent: "8.625" }],
        giftCard: false, promotionId: null,
      }],
      shippingLines: [],
      subtotalMinor: 2500n,
      taxMinor: 216n,
      shippingMinor: 0n,
      discountMinor: 0n,
      totalMinor: 2716n,
      tenders: [{ gateway: "shopify_payments", amountMinor: 2716n, giftCardExternalId: null, authorizationRef: "auth-kit-1" }],
    };
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, order));
    assert.equal((await withBypass(() => postChannelOrder(org.orgId, actor, stored.id))).status, "posted");
    // The sale moved the stocked unit and nothing else.
    const sold = await stockPosition(org.orgId, org.items.fifo, org.stockLocationId);
    assert.equal(Number(sold.quantity), 9);
    const serviceMoves = (await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*)::text as count from inventory_movements
       where org_id = ${org.orgId} and item_id = ${org.items.service}`))).rows[0]!;
    assert.equal(serviceMoves.count, "0");
    const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "2001", {
      kind: "refund",
      externalId: "r-kit-1",
      refund: {
        externalId: "r-kit-1",
        orderExternalId: "2001",
        reason: "changed mind",
        restock: true,
        totalMinor: 2716n,
        lines: [{ lineExternalId: "1", sku: "KIT-MIXED", variantExternalId: null, quantity: "1", amountMinor: 2500n, taxMinor: null, restock: true }],
        shippingMinor: 0n,
        tenders: [{ gateway: "shopify_payments", amountMinor: 2716n }],
        refundedAt: "2026-07-16T09:00:00Z",
      },
      occurredAt: "2026-07-16T09:00:00Z",
    }));
    const outcome = await withBypass(() => postChannelRefund(org.orgId, actor, event.eventId));
    assert.equal(outcome.status, "posted");
    assert.ok(outcome.documentId);
    assert.equal(await journalSum(org.orgId, outcome.documentId!), 0n);
    // The stocked unit is back at its original cost; the service line moved
    // money only and still has no movement behind it.
    const tee = await stockPosition(org.orgId, org.items.fifo, org.stockLocationId);
    assert.equal(Number(tee.quantity), 10);
    assert.equal(tee.value, "20.0000");
    const after = (await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*)::text as count from inventory_movements
       where org_id = ${org.orgId} and item_id = ${org.items.service}`))).rows[0]!;
    assert.equal(after.count, "0");
    const evidence = (await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*)::text as count from document_lines
       where document_id = ${outcome.documentId} and org_id = ${org.orgId}
         and custom ? 'inventoryReturn'`))).rows[0]!;
    assert.equal(evidence.count, "1");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("summary mode folds the day's refund into the batch", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, "daily_summary");
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("1006")));
    const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "1006", {
      kind: "refund",
      externalId: "r-9007",
      refund: fullRefund("1006", "r-9007"),
      occurredAt: "2026-07-16T09:00:00Z",
    }));
    // The sale has not had its cut-off: the refund waits, never parks.
    assert.equal((await withBypass(() => postChannelRefund(org.orgId, actor, event.eventId))).status, "pending");
    const outcome = await withBypass(() => postDueDailySummariesForOrg(org.orgId, actor));
    // One summarized order plus one batched refund event.
    assert.equal(outcome.posted, 2);
    const refunded = (await withOrgContext(org.orgId, () => db.execute<{ posting_status: string; posting_document_id: string | null }>(sql`
      select posting_status, posting_document_id from channel_order_events
       where id = ${event.eventId} and org_id = ${org.orgId}`))).rows[0]!;
    assert.equal(refunded.posting_status, "posted");
    assert.ok(refunded.posting_document_id);
    const doc = (await withOrgContext(org.orgId, () => db.execute<{ kind: string; status: string; total: string }>(sql`
      select kind, status, total::text as total from documents
       where id = ${refunded.posting_document_id} and org_id = ${org.orgId}`))).rows[0]!;
    assert.equal(doc.kind, "cash_refund");
    assert.equal(doc.status, "posted");
    assert.equal(doc.total, "68.8600");
    assert.equal(await journalSum(org.orgId, refunded.posting_document_id!), 0n);
    void stored;
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("channel cash postings refuse while Cash sales is off", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, "per_order");
    // Sales Channels runs but Cash sales stays off: posting a cash sale or
    // refund would strand a document its own surface refuses, so both refuse
    // naming the toggle that unblocks them.
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,cashSales}', 'false'::jsonb, true) where id = ${org.orgId}`);
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("1010")));
    await assert.rejects(
      withBypass(() => postChannelOrder(org.orgId, actor, stored.id)),
      (error: unknown) => error instanceof CommerceError && /Cash sales is turned off/.test(error.message),
      "a paid channel order must not post a cash sale its surface hides",
    );
    const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelId, "1010", {
      kind: "refund",
      externalId: "r-9010",
      refund: fullRefund("1010", "r-9010"),
      occurredAt: "2026-07-16T09:00:00Z",
    }));
    await assert.rejects(
      withBypass(() => postChannelRefund(org.orgId, actor, event.eventId)),
      (error: unknown) => error instanceof CommerceError && /Cash sales is turned off/.test(error.message),
      "a channel refund must not post a cash refund its surface hides",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
