import assert from "node:assert/strict";
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
import {
  approveExceptionSuggestion,
  rejectExceptionSuggestion,
  suggestExceptionFix,
} from "./exception-assistance.ts";
import { CommerceError } from "./errors.ts";
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
  verifyWebhook: () => ({ eventId: "assistance-test", topic: "test" }),
  testConnection: async () => ({ ok: true, detail: "test" }),
  handleEvent: async () => ({ action: "ignored", resultRef: {} }),
  workspaceTabs: () => [],
});

interface Fixture {
  org: ScratchOrg;
  actor: string;
  channelId: string;
  ghostItemId: string;
  clearingId: string;
}

async function setup(): Promise<Fixture> {
  const org = await withBypass(() => createScratchOrg());
  const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
  await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ salesChannels: true, storedValue: true, promotions: true })}::jsonb, true) where id = ${org.orgId}`);
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
  const clearingId = (await db.execute<{ id: string }>(sql`
    insert into accounts (org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${org.orgId}, '1015', 'Shopify Clearing', 'asset_bank', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
    returning id`)).rows[0]!.id;
  const discountId = (await db.execute<{ id: string }>(sql`
    insert into accounts (org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${org.orgId}, '4020', 'Sales Discounts', 'expense', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
    returning id`)).rows[0]!.id;
  const shippingId = (await db.execute<{ id: string }>(sql`
    insert into accounts (org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${org.orgId}, '4030', 'Shipping Income', 'income', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
    returning id`)).rows[0]!.id;
  const giftId = (await db.execute<{ id: string }>(sql`
    insert into accounts (org_id, number, name, type, is_summary, is_active, eliminate, reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${org.orgId}, '2310', 'Gift Card Liability', 'liability_current_other', false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)
    returning id`)).rows[0]!.id;
  for (const [role, key, accountId] of [
    ["gateway_clearing", "shopify_payments", clearingId],
    ["revenue", "", org.accounts.revenue],
    ["discount", "", discountId],
    ["shipping_income", "", shippingId],
    ["gift_card_liability", "", giftId],
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
  // The ghost SKU differs from the item code by a separator only, so posting
  // parks while the deterministic suggestion still finds the item.
  await db.execute(sql`update items set code = 'NOPE 404', name = 'Ghost Tee Shirt' where id = ${org.items.fifo} and org_id = ${org.orgId}`);
  await withBypass(() => receiveInventory(org.orgId, actor, {
    itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2",
    subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
  }));
  return { org, actor, channelId, ghostItemId: org.items.fifo, clearingId };
}

function ghostOrder(externalId: string, overrides: Partial<ChannelOrder> = {}): ChannelOrder {
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
    subtotalMinor: 2500n,
    taxMinor: 268n,
    shippingMinor: 600n,
    discountMinor: 0n,
    totalMinor: 3368n,
    financialStatus: "paid",
    fulfilmentStatus: "unfulfilled",
    lines: [
      {
        sku: "NOPE-404", variantExternalId: "999001", title: "Ghost Tee", quantity: "1",
        priceMinor: 2500n, discountMinor: 0n, discountCode: null,
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 216n, ratePercent: "8.625" }],
        giftCard: false, promotionId: null,
      },
    ],
    shippingLines: [
      {
        title: "Standard", amountMinor: 600n, discountMinor: 0n,
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 52n, ratePercent: "8.625" }],
      },
    ],
    tenders: [{ gateway: "shopify_payments", amountMinor: 3368n, giftCardExternalId: null, authorizationRef: "auth-1" }],
    orderedAt: "2026-07-15T12:00:00Z",
    cancelledAt: null,
    ...overrides,
  };
}

async function parkGhost(fixture: Fixture, externalId: string, overrides: Partial<ChannelOrder> = {}): Promise<string> {
  const stored = await withBypass(() => ingestChannelOrder(fixture.org.orgId, fixture.actor, fixture.channelId, ghostOrder(externalId, overrides)));
  const outcome = await withBypass(() => postChannelOrder(fixture.org.orgId, fixture.actor, stored.id));
  assert.equal(outcome.status, "exception");
  assert.equal(outcome.code, "unmapped_item");
  return stored.id;
}

test("unmapped SKU suggests deterministically; approval links the variant and posts", { skip: !DB }, async () => {
  const fixture = await setup();
  try {
    const orderId = await parkGhost(fixture, "9001");
    const first = await withBypass(() => suggestExceptionFix(fixture.org.orgId, orderId));
    const second = await withBypass(() => suggestExceptionFix(fixture.org.orgId, orderId));
    assert.deepEqual(first, second);
    assert.equal(first.code, "unmapped_item");
    assert.ok(first.candidates.length > 0);
    const top = first.candidates[0]!;
    assert.equal(top.kind, "link_variant");
    assert.equal(top.action.type, "link_variant");
    if (top.action.type !== "link_variant") throw new Error("unreachable");
    assert.equal(top.action.itemId, fixture.ghostItemId);
    assert.ok(top.evidence.length > 0);
    assert.equal(first.modelRanked, false);
    assert.ok(first.explanation.includes("#9001"));

    const approved = await withBypass(() => approveExceptionSuggestion(fixture.org.orgId, fixture.actor, orderId, { rank: 0, applyToSimilar: false }));
    assert.equal(approved.replay.replayed, 1);
    assert.equal(approved.replay.posted, 1);
    const link = await withBypass(() => db.execute<{ native_id: string }>(sql`
      select native_id from external_links
       where org_id = ${fixture.org.orgId} and provider = 'shopify' and object_type = 'variant' and external_id = '999001'`));
    assert.equal(link.rows[0]?.native_id, fixture.ghostItemId);
    const status = (await withOrgContext(fixture.org.orgId, () => db.execute<{ posting_status: string }>(sql`
      select posting_status from channel_orders where id = ${orderId} and org_id = ${fixture.org.orgId}`))).rows[0]!;
    assert.equal(status.posting_status, "posted");
  } finally {
    await dropScratchOrg(fixture.org.orgId);
  }
});

test("approving with apply-to-similar replays every order blocked by the same variant", { skip: !DB }, async () => {
  const fixture = await setup();
  try {
    const firstId = await parkGhost(fixture, "9101");
    await parkGhost(fixture, "9102");
    const suggestion = await withBypass(() => suggestExceptionFix(fixture.org.orgId, firstId));
    assert.equal(suggestion.similarCount, 2);
    const approved = await withBypass(() => approveExceptionSuggestion(fixture.org.orgId, fixture.actor, firstId, { rank: 0, applyToSimilar: true }));
    assert.equal(approved.replay.replayed, 2);
    assert.equal(approved.replay.posted, 2);
  } finally {
    await dropScratchOrg(fixture.org.orgId);
  }
});

test("unknown gateway suggests the clearing account; approval maps it effective on the order date", { skip: !DB }, async () => {
  const fixture = await setup();
  try {
    const stored = await withBypass(() => ingestChannelOrder(fixture.org.orgId, fixture.actor, fixture.channelId, {
      ...ghostOrder("9201"),
      lines: [{
        sku: "NOPE 404", variantExternalId: null, title: "Ghost Tee Shirt", quantity: "1",
        priceMinor: 2500n, discountMinor: 0n, discountCode: null,
        taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 216n, ratePercent: "8.625" }],
        giftCard: false, promotionId: null,
      }],
      tenders: [{ gateway: "walley_pay", amountMinor: 3368n, giftCardExternalId: null, authorizationRef: "auth-9" }],
    }));
    const outcome = await withBypass(() => postChannelOrder(fixture.org.orgId, fixture.actor, stored.id));
    assert.equal(outcome.status, "exception");
    assert.equal(outcome.code, "unmapped_account");
    const suggestion = await withBypass(() => suggestExceptionFix(fixture.org.orgId, stored.id));
    assert.equal(suggestion.code, "unmapped_account");
    const top = suggestion.candidates[0]!;
    assert.equal(top.kind, "map_account");
    assert.equal(top.action.type, "map_account");
    if (top.action.type !== "map_account") throw new Error("unreachable");
    assert.equal(top.action.role, "gateway_clearing");
    assert.equal(top.action.key, "walley_pay");
    assert.equal(top.action.accountId, fixture.clearingId);
    const approved = await withBypass(() => approveExceptionSuggestion(fixture.org.orgId, fixture.actor, stored.id, { rank: 0, applyToSimilar: false }));
    assert.equal(approved.replay.posted, 1);
  } finally {
    await dropScratchOrg(fixture.org.orgId);
  }
});

test("rejection keeps the order parked and audits the reason", { skip: !DB }, async () => {
  const fixture = await setup();
  try {
    const orderId = await parkGhost(fixture, "9301");
    await withBypass(() => rejectExceptionSuggestion(fixture.org.orgId, fixture.actor, orderId, "Wrong item: the buyer ordered the blue variant."));
    const status = (await withOrgContext(fixture.org.orgId, () => db.execute<{ posting_status: string }>(sql`
      select posting_status from channel_orders where id = ${orderId} and org_id = ${fixture.org.orgId}`))).rows[0]!;
    assert.equal(status.posting_status, "exception");
    const audit = (await withOrgContext(fixture.org.orgId, () => db.execute<{ reason: string }>(sql`
      select changes->>'reason' as reason from audit_log
       where org_id = ${fixture.org.orgId} and table_name = 'channel_orders' and row_id = ${orderId}
       order by at desc limit 1`))).rows[0]!;
    assert.equal(audit.reason, "Wrong item: the buyer ordered the blue variant.");
    await assert.rejects(
      withBypass(() => rejectExceptionSuggestion(fixture.org.orgId, fixture.actor, orderId, "   ")),
      (error: unknown) => error instanceof CommerceError && error.code === "exception_assistance_reason_missing",
    );
  } finally {
    await dropScratchOrg(fixture.org.orgId);
  }
});

test("totals that disagree get a manual fix only; approval refuses with the remedy", { skip: !DB }, async () => {
  const fixture = await setup();
  try {
    const stored = await withBypass(() => ingestChannelOrder(fixture.org.orgId, fixture.actor, fixture.channelId, {
      ...ghostOrder("9401"),
      totalMinor: 9999n,
    }));
    const outcome = await withBypass(() => postChannelOrder(fixture.org.orgId, fixture.actor, stored.id));
    assert.equal(outcome.status, "exception");
    assert.equal(outcome.code, "tax_mismatch");
    const suggestion = await withBypass(() => suggestExceptionFix(fixture.org.orgId, stored.id));
    assert.equal(suggestion.candidates[0]?.kind, "manual");
    await assert.rejects(
      withBypass(() => approveExceptionSuggestion(fixture.org.orgId, fixture.actor, stored.id, { rank: 0, applyToSimilar: false })),
      (error: unknown) => error instanceof CommerceError && error.code === "exception_assistance_manual_only",
    );
  } finally {
    await dropScratchOrg(fixture.org.orgId);
  }
});
