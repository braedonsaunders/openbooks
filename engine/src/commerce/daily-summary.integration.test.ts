import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { registerChannelAdapter } from "./adapters.ts";
import { upsertAccountMap } from "./account-maps.ts";
import { createChannel, retryChannel, markChannelActive } from "./channels.ts";
import { upsertChannelLocation } from "./locations.ts";
import { ingestChannelOrder, loadChannelOrder } from "./orders.ts";
import { postDueDailySummariesForOrg } from "./daily-summary.ts";
import { setPostingPolicy } from "./posting-policies.ts";
import type { ChannelOrder } from "./contracts.ts";
import { db, withBypass, withOrgContext } from "../platform/db.ts";
import { receiveInventory } from "../inventory/movements.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
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

function summaryOrder(externalId: string, overrides: Partial<ChannelOrder> = {}): ChannelOrder {
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
    subtotalMinor: 2500n,
    taxMinor: 216n,
    shippingMinor: 0n,
    discountMinor: 0n,
    totalMinor: 2716n,
    financialStatus: "paid",
    fulfilmentStatus: "unfulfilled",
    lines: [
      {
        sku: "TEE-RED-M", variantExternalId: null, title: "Red Tee — M", quantity: "1",
        priceMinor: 2500n, discountMinor: 0n, discountCode: null,
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 216n, ratePercent: "8.64" }],
        giftCard: false, promotionId: null,
      },
    ],
    shippingLines: [],
    tenders: [{ gateway: "shopify_payments", amountMinor: 2716n, giftCardExternalId: null, authorizationRef: null }],
    orderedAt: "2026-07-15T12:00:00Z",
    cancelledAt: null,
    ...overrides,
  };
}

test("three orders post as one summary cash sale with exact aggregated totals", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || '{"salesChannels": true, "cashSales": true, "inventory": true}'::jsonb, true) where id = ${org.orgId}`);
    const created = await withBypass(() => createChannel(org.orgId, actor, {
      kind: "shopify", name: "Test Shop", currency: "CAD", externalAccount: "test.myshopify.com", settings: {},
    }));
    const channelId = created.channel.id;
    await withBypass(() => retryChannel(org.orgId, actor, channelId, "test"));
    await withBypass(() => markChannelActive(org.orgId, actor, channelId));
    await withBypass(() => setPostingPolicy(org.orgId, actor, { channelId, mode: "daily_summary", effectiveFrom: org.date }));
    const clearing = (await db.execute<{ id: string }>(sql`
      insert into accounts (org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${org.orgId}, '1015', 'Shopify Clearing', 'asset_bank', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
      returning id`)).rows[0]!.id;
    const maps: Array<[string, string, string]> = [
      ["gateway_clearing", "shopify_payments", clearing],
      ["revenue", "", org.accounts.revenue],
      ["discount", "", org.accounts.revenue],
      ["shipping_income", "", org.accounts.revenue],
      ["gift_card_liability", "", org.accounts.taxOutput],
      ["sales_tax_liability", "NY", org.accounts.taxOutput],
    ];
    for (const [role, key, accountId] of maps) {
      await withBypass(() => upsertAccountMap(org.orgId, actor, { channelId, role, key, accountId, effectiveFrom: org.date }));
    }
    await withBypass(() => upsertChannelLocation(org.orgId, actor, {
      channelId, externalLocationId: "wh-1", externalName: "Warehouse",
      stockLocationId: org.stockLocationId, fulfilsOrders: true,
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

    const muggy: ChannelOrder = {
      ...summaryOrder("2002"),
      lines: [{
        sku: "MUG-WHITE", variantExternalId: null, title: "White Mug", quantity: "2",
        priceMinor: 1200n, discountMinor: 0n, discountCode: null,
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 207n, ratePercent: "8.625" }],
        giftCard: false, promotionId: null,
      }],
      subtotalMinor: 2400n,
      taxMinor: 207n,
      totalMinor: 2607n,
      tenders: [{ gateway: "shopify_payments", amountMinor: 2607n, giftCardExternalId: null, authorizationRef: null }],
    };
    const shipped: ChannelOrder = {
      ...summaryOrder("2003"),
      shippingLines: [{
        title: "Standard", amountMinor: 600n, discountMinor: 0n,
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 52n, ratePercent: "8.667" }],
      }],
      shippingMinor: 600n,
      taxMinor: 268n,
      totalMinor: 3368n,
      tenders: [{ gateway: "shopify_payments", amountMinor: 3368n, giftCardExternalId: null, authorizationRef: null }],
    };
    const today = new Date().toISOString().slice(0, 10);
    const sameDay: ChannelOrder = { ...summaryOrder("2004"), orderedAt: `${today}T12:00:00Z` };
    const a = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, summaryOrder("2001")));
    const b = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, muggy));
    const c = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, shipped));
    const d = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, sameDay));

    const outcome = await withBypass(() => postDueDailySummariesForOrg(org.orgId, actor));
    assert.equal(outcome.posted, 3);

    const summary = (await withOrgContext(org.orgId, () => db.execute<{
      id: string; status: string; order_count: number; subtotal_minor: string;
      tax_minor: string; shipping_minor: string; total_minor: string; posting_document_id: string | null;
    }>(sql`
      select id, status, order_count, subtotal_minor, tax_minor, shipping_minor, total_minor, posting_document_id
        from channel_daily_summaries where org_id = ${org.orgId} and channel_id = ${channelId}`))).rows;
    assert.equal(summary.length, 1);
    assert.equal(summary[0]!.status, "posted");
    assert.equal(summary[0]!.order_count, 3);
    assert.equal(summary[0]!.subtotal_minor, "7400");
    assert.equal(summary[0]!.tax_minor, "691");
    assert.equal(summary[0]!.shipping_minor, "600");
    assert.equal(summary[0]!.total_minor, "8691");
    assert.ok(summary[0]!.posting_document_id);

    // One cash sale: aggregated product lines, shipping, and one tender.
    const doc = (await withOrgContext(org.orgId, () => db.execute<{ kind: string; status: string; total: string; tax_total: string }>(sql`
      select kind, status, total::text as total, tax_total::text as tax_total
        from documents where id = ${summary[0]!.posting_document_id} and org_id = ${org.orgId}`))).rows[0]!;
    assert.equal(doc.kind, "cash_sale");
    assert.equal(doc.status, "posted");
    assert.equal(doc.total, "86.9100");
    assert.equal(doc.tax_total, "6.9100");
    const docLines = (await withOrgContext(org.orgId, () => db.execute<{ description: string; amount: string; quantity: string }>(sql`
      select description, amount::text as amount, quantity::text as quantity from document_lines
       where document_id = ${summary[0]!.posting_document_id} and org_id = ${org.orgId} order by line_number`))).rows;
    const tee = docLines.find((line) => line.description === "Red Tee — M")!;
    assert.equal(tee.amount, "50.0000");
    assert.equal(Number(tee.quantity), 2);
    const mug = docLines.find((line) => line.description === "White Mug")!;
    assert.equal(mug.amount, "24.0000");
    const ship = docLines.find((line) => line.description === "Standard")!;
    assert.equal(ship.amount, "6.0000");

    // Every summarized order links to the batch; today's order waits for its cut-off.
    for (const id of [a.id, b.id, c.id]) {
      const row = await withBypass(() => loadChannelOrder(org.orgId, id));
      assert.equal(row!.postingStatus, "summarized");
      assert.equal(row!.summaryId, summary[0]!.id);
      assert.equal(row!.postingDocumentId, null);
    }
    const waiting = await withBypass(() => loadChannelOrder(org.orgId, d.id));
    assert.equal(waiting!.postingStatus, "pending");
    await db.execute(sql`update sales_channel_posting_policies set effective_to='2026-07-31'
      where org_id=${org.orgId} and channel_id=${channelId}`);
    const refused = await withBypass(() => postDueDailySummariesForOrg(org.orgId,actor));
    assert.equal(refused.parked,1);
    const exception = await withBypass(() => loadChannelOrder(org.orgId,d.id));
    assert.equal(exception!.postingStatus,'exception');
    assert.equal(exception!.exceptionCode,'channel_policy_missing');
    assert.match(exception!.exceptionReason!,/Test Shop.*no posting policy/);
    assert.match(exception!.exceptionRemedy!,/Channels → Settings → Posting/);
    const audit = (await db.execute<{changes:{before:{posting_status:string};after:{posting_status:string}}}>(sql`
      select changes from audit_log where org_id=${org.orgId} and table_name='channel_orders'
       and row_id=${d.id} order by at desc,id desc limit 1`)).rows[0]!;
    assert.equal(audit.changes.before.posting_status,'pending');
    assert.equal(audit.changes.after.posting_status,'exception');
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
