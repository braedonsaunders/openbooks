import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { registerChannelAdapter } from "./adapters.ts";
import { upsertAccountMap } from "./account-maps.ts";
import { createChannel, retryChannel, markChannelActive } from "./channels.ts";
import { upsertChannelLocation } from "./locations.ts";
import { ingestChannelOrder } from "./orders.ts";
import { postChannelOrder } from "./order-posting.ts";
import { setPostingPolicy } from "./posting-policies.ts";
import type { ChannelOrder } from "./contracts.ts";
import { matchPayoutLines } from "./payout-reconciliation.ts";
import { db, withBypass } from "../platform/db.ts";
import { receiveInventory } from "../inventory/movements.ts";
import {
  importSettlementBatch,
  parseShopifyPaymentsPayout,
  setSettlementLineDocument,
  markSettlementLineAdjustment,
} from "../payments/psp-settlement.ts";
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
  await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ banking: true, salesChannels: true })}::jsonb, true) where id = ${org.orgId}`);
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
  const extra: Array<[string, string, string]> = [
    ["clearing", "1015", "Shopify Clearing"],
    ["discount", "4020", "Sales Discounts"],
    ["shipping", "4030", "Shipping Income"],
    ["gift", "2310", "Gift Card Liability"],
  ];
  const accounts = {} as Record<string, string>;
  for (const [key, number, name] of extra) {
    const type = key === "clearing" ? "asset_bank" : key === "gift" ? "liability_current_other" : key === "discount" ? "expense" : "income";
    const id = (await db.execute<{ id: string }>(sql`
      insert into accounts (org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
      returning id`)).rows[0]!.id;
    accounts[key] = id;
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
    subtotalMinor: 5000n,
    taxMinor: 440n,
    shippingMinor: 600n,
    discountMinor: 0n,
    totalMinor: 6040n,
    financialStatus: "paid",
    fulfilmentStatus: "unfulfilled",
    lines: [
      {
        sku: "TEE-RED-M", variantExternalId: null, title: "Red Tee — M", quantity: "2",
        priceMinor: 2500n, discountMinor: 0n, discountCode: null,
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 380n, ratePercent: "8.625" }],
        giftCard: false, promotionId: null,
      },
    ],
    shippingLines: [
      {
        title: "Standard", amountMinor: 600n, discountMinor: 0n,
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 60n, ratePercent: "8.625" }],
      },
    ],
    tenders: [{ gateway: "shopify_payments", amountMinor: 6040n, giftCardExternalId: null, authorizationRef: "auth-1" }],
    orderedAt: "2026-07-15T12:00:00Z",
    cancelledAt: null,
    ...overrides,
  };
}

test("shopify payout lines link to channel orders, queue the rest with remedies", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const channelId = await setup(org, actor);
    const posted = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("3001")));
    const outcome = await withBypass(() => postChannelOrder(org.orgId, actor, posted.id));
    assert.equal(outcome.status, "posted");
    assert.ok(outcome.documentId);
    await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("3002")));

    const parsed = parseShopifyPaymentsPayout(
      { id: "shopify-payout-match-1", currency: "CAD", issuedAt: "2026-07-10" },
      [
        { id: "txn-a", type: "charge", amount: "100.00", fee: "2.90", currency: "CAD", sourceOrderId: "gid://shopify/Order/3001" },
        { id: "txn-b", type: "charge", amount: "50.00", currency: "CAD", sourceOrderId: "3002" },
        { id: "txn-c", type: "charge", amount: "10.00", currency: "CAD", sourceOrderId: "9999" },
        { id: "txn-d", type: "refund", amount: "20.00", currency: "CAD", sourceOrderId: "gid://shopify/Order/3001" },
      ],
    );
    const imported = await importSettlementBatch(org.orgId, actor, parsed, {
      bankAccountId: org.accounts.bank,
      feeAccountId: org.accounts.adjustment,
      clearingAccountId: org.accounts.clearing,
      subsidiaryId: org.subsidiaryId,
    }, null);

    const result = await matchPayoutLines(org.orgId, imported.batchId, actor, null);
    assert.equal(result.matched, 1, `expected one linked line, got ${JSON.stringify(result.lines)}`);
    assert.equal(result.notApplicable, 1, "the fee line never joins the queue");
    assert.equal(result.unmatched, 3);
    const matched = result.lines.find((line) => line.status === "matched");
    assert.ok(matched && matched.status === "matched");
    assert.equal(matched.documentId, outcome.documentId);
    assert.equal(matched.via, "channel_order");
    const reasons = new Map(
      result.lines.filter((line) => line.status === "unmatched").map((line) => [line.lineId, line]),
    );
    assert.equal(reasons.size, 3);
    for (const verdict of reasons.values()) {
      assert.ok(verdict.status === "unmatched" && verdict.remedy.length > 0, "every queued line names its remedy");
    }
    const byReason = new Map(
      [...reasons.values()].filter((v) => v.status === "unmatched").map((v) => [v.reason, v]),
    );
    assert.ok(byReason.has("order_unposted"), "the pending order waits for posting");
    assert.ok(byReason.has("order_unknown"), "the unknown order waits for ingestion");
    assert.ok(byReason.has("refund_unposted"), "the refund waits for its cash refund");

    const stored = (await db.execute<{ document_id: string | null }>(sql`
      select document_id from psp_settlement_lines
       where batch_id = ${imported.batchId} and org_id = ${org.orgId} and external_ref = 'txn-a'
    `)).rows[0];
    assert.equal(stored!.document_id, outcome.documentId);

    // A repeated provider reference converges onto the stored links instead
    // of conflicting with the operator's matching evidence.
    const repeated = await importSettlementBatch(org.orgId, actor, parsed, {
      bankAccountId: org.accounts.bank,
      feeAccountId: org.accounts.adjustment,
      clearingAccountId: org.accounts.clearing,
      subsidiaryId: org.subsidiaryId,
    }, null);
    assert.equal(repeated.created, false);
    assert.equal(repeated.batchId, imported.batchId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("manual link refuses unposted documents; adjustment reclass refoots the batch", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const channelId = await setup(org, actor);
    const posted = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("3101")));
    const outcome = await withBypass(() => postChannelOrder(org.orgId, actor, posted.id));
    assert.ok(outcome.documentId);
    const draftId = (await db.execute<{ id: string }>(sql`
      insert into documents (org_id, kind, status, document_number, document_date, currency, subtotal, tax_total, total)
      values (${org.orgId}, 'cash_sale', 'draft', 'DRAFT-1', '2026-07-10', 'CAD', '10', '0', '10')
      returning id`)).rows[0]!.id;

    const parsed = parseShopifyPaymentsPayout(
      { id: "shopify-payout-match-2", currency: "CAD", issuedAt: "2026-07-10" },
      [
        { id: "txn-x", type: "charge", amount: "10.00", currency: "CAD", sourceOrderId: "9999" },
        { id: "txn-y", type: "charge", amount: "5.00", currency: "CAD", sourceOrderId: "9998" },
      ],
    );
    const imported = await importSettlementBatch(org.orgId, actor, parsed, {
      bankAccountId: org.accounts.bank,
      feeAccountId: org.accounts.adjustment,
      clearingAccountId: org.accounts.clearing,
      subsidiaryId: org.subsidiaryId,
    }, null);
    const lineOf = async (ref: string) => (await db.execute<{ id: string }>(sql`
      select id from psp_settlement_lines
       where batch_id = ${imported.batchId} and org_id = ${org.orgId} and external_ref = ${ref}
    `)).rows[0]!.id;

    const lineX = await lineOf("txn-x");
    await assert.rejects(
      () => setSettlementLineDocument(org.orgId, imported.batchId, lineX, draftId, actor, null),
      /not posted; post it first/,
      "linking an unposted document refuses naming the remedy",
    );
    const linked = await setSettlementLineDocument(org.orgId, imported.batchId, lineX, outcome.documentId!, actor, null);
    assert.equal(linked.documentId, outcome.documentId);

    const before = (await db.execute<{ net_amount: string; adjustment_amount: string }>(sql`
      select net_amount::text, adjustment_amount::text from psp_settlement_batches
       where id = ${imported.batchId} and org_id = ${org.orgId}
    `)).rows[0]!;
    const marked = await markSettlementLineAdjustment(org.orgId, imported.batchId, await lineOf("txn-y"), actor, null);
    assert.equal(marked.kind, "adjustment");
    const after = (await db.execute<{ net_amount: string; adjustment_amount: string }>(sql`
      select net_amount::text, adjustment_amount::text from psp_settlement_batches
       where id = ${imported.batchId} and org_id = ${org.orgId}
    `)).rows[0]!;
    assert.notEqual(after.net_amount, before.net_amount, "the batch refoots after reclassification");
    assert.ok(Number(after.adjustment_amount) > Number(before.adjustment_amount));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
