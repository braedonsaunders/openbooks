import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { registerChannelAdapter } from "./adapters.ts";
import { upsertAccountMap } from "./account-maps.ts";
import { createChannel, retryChannel, markChannelActive } from "./channels.ts";
import { linkExternal } from "./external-links.ts";
import { upsertChannelLocation } from "./locations.ts";
import { ingestChannelOrder } from "./orders.ts";
import { postChannelOrder } from "./order-posting.ts";
import { listChannelExceptions, replayChannelExceptions } from "./exceptions.ts";
import { setPostingPolicy } from "./posting-policies.ts";
import { CommerceError } from "./errors.ts";
import type { ChannelOrder } from "./contracts.ts";
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
  accounts: { clearing: string; discount: string; shipping: string; gift: string };
}

/** Exact 4dp-decimal to integer units without float math. */
function units4(amount: string): bigint {
  const negative = amount.startsWith("-");
  const digits = negative ? amount.slice(1) : amount;
  const [whole, frac = ""] = digits.split(".");
  return BigInt(`${negative ? "-" : ""}${whole}${(frac + "0000").slice(0, 4)}`);
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
  ];
  const accounts = {} as Fixture["accounts"];
  for (const [key, number, name] of extra) {
    const type = key === "clearing" ? "asset_bank" : key === "gift" ? "liability_current_other" : key === "discount" ? "expense" : "income";
    const id = (await db.execute<{ id: string }>(sql`
      insert into accounts (org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
      returning id`)).rows[0]!.id;
    accounts[key as keyof Fixture["accounts"]] = id;
  }
  const maps: Array<[string, string, string]> = [
    ["gateway_clearing", "shopify_payments", accounts.clearing],
    ["revenue", "", org.accounts.revenue],
    ["discount", "", accounts.discount],
    ["shipping_income", "", accounts.shipping],
    ["gift_card_liability", "", accounts.gift],
    ["sales_tax_liability", "NY", org.accounts.taxOutput],
    ["sales_tax_liability", "CA", org.accounts.taxOutput],
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

async function journalLegs(orgId: string, documentId: string): Promise<Array<{ account_id: string; amount: string }>> {
  const doc = (await withOrgContext(orgId, () => db.execute<{ posted_entry_id: string }>(sql`
    select posted_entry_id from documents where id = ${documentId} and org_id = ${orgId}`))).rows[0]!;
  const rows = (await withOrgContext(orgId, () => db.execute<{ account_id: string; amount: string }>(sql`
    select l.account_id, l.amount::text as amount from journal_lines l
     join journal_entries e on e.id = l.entry_id
     where l.org_id = ${orgId} and l.entry_id = ${doc.posted_entry_id}
       and e.status in ('posted', 'reversed')`))).rows;
  return rows;
}

test("paid order posts one balanced cash sale with gateway tenders, tax and COGS", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId, accounts } = await setup(org, actor, "per_order");
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("1001")));
    assert.equal(stored.postingStatus, "pending");
    assert.equal(stored.presentmentCurrency, "USD");
    const outcome = await withBypass(() => postChannelOrder(org.orgId, actor, stored.id));
    assert.equal(outcome.status, "posted");
    assert.ok(outcome.documentId);
    const doc = (await withOrgContext(org.orgId, () => db.execute<{ kind: string; status: string; total: string; subtotal: string; tax_total: string; party_id: string | null; source_channel_id: string | null }>(sql`
      select kind, status, total::text as total, subtotal::text as subtotal, tax_total::text as tax_total,
             party_id, source_channel_id from documents where id = ${outcome.documentId} and org_id = ${org.orgId}`))).rows[0]!;
    assert.equal(doc.kind, "cash_sale");
    assert.equal(doc.status, "posted");
    assert.equal(doc.total, "68.8600");
    assert.equal(doc.subtotal, "63.0000");
    assert.equal(doc.tax_total, "5.8600");
    assert.ok(doc.party_id);
    assert.equal(doc.source_channel_id, channelId);
    const legs = await journalLegs(org.orgId, outcome.documentId!);
    const sum = legs.reduce((total, leg) => total + units4(leg.amount), 0n);
    assert.equal(sum, 0n);
    // Both item lines credit the same revenue account, so legs sum per account.
    const byAccount = new Map<string, bigint>();
    for (const leg of legs) {
      byAccount.set(leg.account_id, (byAccount.get(leg.account_id) ?? 0n) + units4(leg.amount));
    }
    assert.equal(byAccount.get(accounts.clearing), 688600n);
    assert.equal(byAccount.get(org.accounts.revenue), -620000n);
    assert.equal(byAccount.get(accounts.discount), 50000n);
    assert.equal(byAccount.get(org.accounts.taxOutput), -58600n);
    // The inventory issue posts its own entry: 2 units at 2.00 plus 1 at
    // 3.00 of cost of sales against the scratch org's postings.
    const cogs = (await withOrgContext(org.orgId, () => db.execute<{ total: string }>(sql`
      select coalesce(sum(l.amount), 0)::text as total from journal_lines l
       join journal_entries e on e.id = l.entry_id
       where l.org_id = ${org.orgId} and l.account_id = ${org.accounts.cogs}
         and e.status in ('posted', 'reversed')`))).rows[0]!;
    assert.equal(units4(cogs.total), 70000n);
    // The discount code became a promotion and the line carries it.
    const promoLine = (await withOrgContext(org.orgId, () => db.execute<{ promotion_id: string | null }>(sql`
      select promotion_id from document_lines where document_id = ${outcome.documentId} and org_id = ${org.orgId} and amount < 0 limit 1`))).rows[0]!;
    assert.ok(promoLine.promotion_id);
    const promo = (await withOrgContext(org.orgId, () => db.execute<{ code: string; status: string }>(sql`
      select code, status from promotions where id = ${promoLine.promotion_id} and org_id = ${org.orgId}`))).rows[0]!;
    assert.equal(promo.code, "SAVE10");
    assert.equal(promo.status, "active");
    // An inactive linked customer cannot silently become a second native party.
    await db.execute(sql`update parties set is_active=false where org_id=${org.orgId} and id=${doc.party_id}`);
    const count = async () => (await db.execute<{n:number}>(sql`select count(*)::int as n from parties where org_id=${org.orgId}`)).rows[0]!.n;
    const before = await count();
    await assert.rejects(withBypass(() => ingestChannelOrder(org.orgId,actor,channelId,paidOrder('1001-conflict'))),
      (error:unknown) => error instanceof CommerceError && error.code==='external_link_conflict'
        && error.message.includes('cust-1') && error.remedy.includes('unlink it first'));
    assert.equal(await count(),before,'a refused customer mapping rolls back the new party');
    assert.equal((await db.execute(sql`select id from channel_orders where org_id=${org.orgId} and external_id='1001-conflict'`)).rows.length,0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("discount lines net the taxable base by the discounted line's tax code without moving tax", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId, accounts } = await setup(org, actor, "per_order");
    // 100.00 tee less 20.00 taxed 10% on 80.00; 10.00 shipping less 5.00 taxed on 5.00.
    const order = paidOrder("1010", {
      subtotalMinor: 10000n, taxMinor: 850n, shippingMinor: 1000n, discountMinor: 2500n, totalMinor: 9350n,
      lines: [{
        sku: "TEE-RED-M", variantExternalId: null, title: "Red Tee — M", quantity: "1",
        priceMinor: 10000n, discountMinor: 2000n, discountCode: "SAVE20",
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 800n, ratePercent: "10" }],
        giftCard: false, promotionId: null,
      }],
      shippingLines: [{
        title: "Standard", amountMinor: 1000n, discountMinor: 500n,
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 50n, ratePercent: "10" }],
      }],
      tenders: [{ gateway: "shopify_payments", amountMinor: 9350n, giftCardExternalId: null, authorizationRef: null }],
    });
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, order));
    const outcome = await withBypass(() => postChannelOrder(org.orgId, actor, stored.id));
    assert.equal(outcome.status, "posted");
    const components = (await withOrgContext(org.orgId, () => db.execute<{
      line_amount: string; tax_code_id: string; taxable_amount: string; tax_amount: string;
    }>(sql`
      select dl.amount::text as line_amount, c.tax_code_id, c.taxable_amount::text as taxable_amount,
             c.tax_amount::text as tax_amount
        from document_lines dl
        join document_line_tax_components c on c.document_line_id = dl.id and c.org_id = dl.org_id
       where dl.org_id = ${org.orgId} and dl.document_id = ${outcome.documentId}
       order by dl.line_number`))).rows;
    // Every line, discounts included, carries the one jurisdiction code.
    assert.deepEqual(
      components.map((c) => [units4(c.line_amount), units4(c.taxable_amount), units4(c.tax_amount)]),
      [[1000000n, 1000000n, 80000n], [-200000n, -200000n, 0n], [100000n, 100000n, 5000n], [-50000n, -50000n, 0n]],
    );
    assert.equal(new Set(components.map((c) => c.tax_code_id)).size, 1);
    // The taxable base a return reads for the code is the discounted 85.00.
    assert.equal(components.reduce((sum, c) => sum + units4(c.taxable_amount), 0n), 850000n);
    // The journal is the storefront's: tax liability 8.50, discounts 25.00.
    const byAccount = new Map<string, bigint>();
    for (const leg of await journalLegs(org.orgId, outcome.documentId!)) {
      byAccount.set(leg.account_id, (byAccount.get(leg.account_id) ?? 0n) + units4(leg.amount));
    }
    assert.equal(byAccount.get(org.accounts.taxOutput), -85000n);
    assert.equal(byAccount.get(accounts.discount), 250000n);
    assert.equal(byAccount.get(accounts.clearing), 935000n);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("replaying a posted order is a no-op", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, "per_order");
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, paidOrder("1002")));
    const first = await withBypass(() => postChannelOrder(org.orgId, actor, stored.id));
    assert.equal(first.status, "posted");
    const second = await withBypass(() => postChannelOrder(org.orgId, actor, stored.id));
    assert.equal(second.status, "posted");
    assert.equal(second.documentId, first.documentId);
    const count = (await withOrgContext(org.orgId, () => db.execute<{ count: string }>(sql`
      select count(*)::text as count from documents
       where org_id = ${org.orgId} and external_source = 'shopify' and external_ref = '1002'`))).rows[0]!;
    assert.equal(count.count, "1");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("unmapped SKU parks with remedy; mapping it replays and posts", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, "per_order");
    const broken: ChannelOrder = {
      ...paidOrder("1003"),
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
    const parked = await withBypass(() => postChannelOrder(org.orgId, actor, stored.id));
    assert.equal(parked.status, "exception");
    assert.equal(parked.code, "unmapped_item");
    const queued = await withBypass(() => listChannelExceptions(org.orgId, channelId, "unmapped_item"));
    assert.equal(queued.length, 1);
    assert.match(queued[0]!.reason, /NOPE-404/);
    assert.match(queued[0]!.reason, /Ghost Tee/);
    assert.match(queued[0]!.remedy, /Match the storefront variant/);
    // The operator creates the missing item for the SKU, then replays the queue.
    await db.execute(sql`update items set code = 'NOPE-404' where id = ${org.items.standard} and org_id = ${org.orgId}`);
    await withBypass(() => receiveInventory(org.orgId, actor, {
      itemId: org.items.standard, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2",
      subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
    }));
    const replayed = await withBypass(() => replayChannelExceptions(org.orgId, actor, channelId, "unmapped_item"));
    assert.equal(replayed.replayed, 1);
    assert.equal(replayed.posted, 1);
    assert.equal(replayed.parked, 0);
    const queuedAfter = await withBypass(() => listChannelExceptions(org.orgId, channelId, "unmapped_item"));
    assert.equal(queuedAfter.length, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("gift card tender redeems stored value", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, "per_order");
    const program = await withBypass(() => createProgram({
      orgId: org.orgId, name: "Test gift cards", kind: "gift_card", currency: "CAD",
      liabilityAccountId: org.accounts.taxOutput, actorId: actor,
    }));
    const issued = await withBypass(() => issueStoredValue({
      orgId: org.orgId, allowedSubsidiaryIds: null, programId: program.id, amountMinor: units4("50"), currency: "CAD",
      debitAccountId: org.accounts.bank, idempotencyKey: `test-gc-1004`, postingDate: org.date, actorId: actor,
    }));
    await withBypass(() => linkExternal(org.orgId, actor, {
      channelId, provider: "shopify", externalAccount: "test.myshopify.com",
      objectType: "gift_card", externalId: "gc-777",
      nativeTable: "stored_value_accounts", nativeId: issued.accountId,
    }, "salesChannels"));
    const order: ChannelOrder = {
      ...paidOrder("1004"),
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
    const outcome = await withBypass(() => postChannelOrder(org.orgId, actor, stored.id));
    assert.equal(outcome.status, "posted");
    const card = (await withOrgContext(org.orgId, () => db.execute<{ balance_minor: string }>(sql`
      select balance_minor from stored_value_accounts where id = ${issued.accountId} and org_id = ${org.orgId}`))).rows[0]!;
    assert.equal(card.balance_minor, "400000");
    const entry = (await withOrgContext(org.orgId, () => db.execute<{ kind: string; document_id: string | null }>(sql`
      select kind, document_id from stored_value_entries
       where account_id = ${issued.accountId} and org_id = ${org.orgId} and kind = 'redeem'`))).rows[0]!;
    assert.equal(entry.kind, "redeem");
    assert.equal(entry.document_id, outcome.documentId);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("marketplace-collected tax posts no merchant liability", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
    const { channelId } = await setup(org, actor, "per_order");
    const facilitatorClearing = (await db.execute<{ id: string }>(sql`
      insert into accounts (org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
      values (${org.orgId}, '1155', 'Marketplace Clearing', 'asset_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
      returning id`)).rows[0]!.id;
    await db.execute(sql`
      insert into marketplace_facilitators (org_id, name, clearing_account_id, collection_mode, states, is_active, created_by, updated_by)
      values (${org.orgId}, 'marketplace', ${facilitatorClearing}, 'net', '{}', true, ${actor}, ${actor})`);
    const order: ChannelOrder = {
      ...paidOrder("1005"),
      lines: [{
        sku: "MUG-WHITE", variantExternalId: null, title: "White Mug", quantity: "1",
        priceMinor: 1200n, discountMinor: 0n, discountCode: null,
        taxLines: [
          { jurisdiction: "NY", collectedBy: "merchant", amountMinor: 100n, ratePercent: "8.333" },
          { jurisdiction: "CA", collectedBy: "marketplace", amountMinor: 200n, ratePercent: "7.25" },
        ],
        giftCard: false, promotionId: null,
      }],
      subtotalMinor: 1200n,
      taxMinor: 300n,
      shippingMinor: 0n,
      shippingLines: [],
      discountMinor: 0n,
      totalMinor: 1500n,
      tenders: [{ gateway: "shopify_payments", amountMinor: 1500n, giftCardExternalId: null, authorizationRef: null }],
    };
    const stored = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelId, order));
    const outcome = await withBypass(() => postChannelOrder(org.orgId, actor, stored.id));
    assert.equal(outcome.status, "posted");
    // The merchant books 13.00: the 2.00 the facilitator kept never lands.
    const doc = (await withOrgContext(org.orgId, () => db.execute<{ total: string; tax_total: string }>(sql`
      select total::text as total, tax_total::text as tax_total from documents where id = ${outcome.documentId} and org_id = ${org.orgId}`))).rows[0]!;
    assert.equal(doc.total, "13.0000");
    assert.equal(doc.tax_total, "1.0000");
    const legs = await journalLegs(org.orgId, outcome.documentId!);
    const taxLegs = legs.filter((leg) => leg.account_id === org.accounts.taxOutput);
    assert.equal(taxLegs.length, 1);
    assert.equal(taxLegs[0]!.amount, "-1.0000");
    const facilitatorLegs = legs.filter((leg) => leg.account_id === facilitatorClearing);
    assert.equal(facilitatorLegs.length, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
