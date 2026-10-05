import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { registerChannelAdapter } from "./adapters.ts";
import { upsertAccountMap } from "./account-maps.ts";
import { createChannel, retryChannel, markChannelActive } from "./channels.ts";
import { linkExternal } from "./external-links.ts";
import { upsertChannelLocation } from "./locations.ts";
import { ingestChannelOrder } from "./orders.ts";
import { postChannelOrder } from "./order-posting.ts";
import { setPostingPolicy } from "./posting-policies.ts";
import type { ChannelOrder } from "./contracts.ts";
import { approvePayoutSuggestion, suggestPayoutLineFix } from "./exception-assistance.ts";
import { db, withBypass } from "../platform/db.ts";
import { receiveInventory } from "../inventory/movements.ts";
import {
  importSettlementBatch,
  parseShopifyPaymentsPayout,
  setSettlementLineDocument,
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

/**
 * Two-entity payout scope. One org holds two legal entities: the home entity
 * (the scratch root) and a second operating subsidiary. A caller restricted
 * to the home entity must never observe the other entity's settlement lines,
 * documents, amounts or references through payout discovery or approval —
 * each reads as missing — while an explicitly unrestricted caller keeps the
 * established cross-entity behavior.
 */

function paidOrder(externalId: string, overrides: Partial<ChannelOrder> = {}): ChannelOrder {
  return {
    externalId,
    number: `#${externalId}`,
    customerExternalId: "cust-1",
    customerName: "Ada Osei",
    customerEmail: "ada@example.com",
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

const smallerOrder = (externalId: string): ChannelOrder => paidOrder(externalId, {
  subtotalMinor: 2000n,
  taxMinor: 230n,
  shippingMinor: 300n,
  totalMinor: 2530n,
  lines: [{
    sku: "TEE-RED-M",
    variantExternalId: null,
    title: "Red Tee — M",
    quantity: "1",
    priceMinor: 2000n,
    discountMinor: 0n,
    discountCode: null,
    taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 170n, ratePercent: "8.625" }],
    giftCard: false,
    promotionId: null,
  }],
  tenders: [{ gateway: "shopify_payments", amountMinor: 2530n, giftCardExternalId: null, authorizationRef: "auth-2" }],
  shippingLines: [
    {
      title: "Standard", amountMinor: 300n, discountMinor: 0n,
      taxLines: [{ jurisdiction: "NY", collectedBy: "merchant", amountMinor: 60n, ratePercent: "8.625" }],
    },
  ],
});

async function seed(org: ScratchOrg, actor: string): Promise<{
  subB: string;
  channelA: string;
  channelB: string;
  docA: { id: string; number: string; total: string };
  docB: { id: string; number: string; total: string };
  batchA: string;
  batchB: string;
  batchShop: string;
  lines: Record<string, string>;
}> {
  // Paid channel orders post cash sales, so the seed enables that gate the
  // same way the product requires before posting them.
  await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ banking: true, salesChannels: true, cashSales: true })}::jsonb, true) where id = ${org.orgId}`);
  const subB = randomUUID();
  await db.execute(sql`insert into subsidiaries(id, org_id, parent_id, name, base_currency, country)
    values (${subB}, ${org.orgId}, ${org.subsidiaryId}, 'Western Entity', 'CAD', 'CA')`);

  await db.execute(sql`update items set code = 'TEE-RED-M' where id = ${org.items.fifo} and org_id = ${org.orgId}`);
  await withBypass(() => receiveInventory(org.orgId, actor, {
    itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2",
    subsidiaryId: org.subsidiaryId, offsetAccountId: org.accounts.clearing, date: org.date,
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

  const mkChannel = async (subsidiaryId: string, name: string, domain: string, locationId: string): Promise<string> => {
    const created = await withBypass(() => createChannel(org.orgId, actor, {
      kind: "shopify",
      name,
      currency: "CAD",
      externalAccount: domain,
      settings: {},
      subsidiaryId,
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
      externalLocationId: locationId,
      externalName: "Warehouse",
      stockLocationId: org.stockLocationId,
      fulfilsOrders: true,
    }));
    return channelId;
  };

  const channelA = await mkChannel(org.subsidiaryId, "Home Shop", "home.myshopify.com", "wh-home");
  const channelB = await mkChannel(subB, "Western Shop", "western.myshopify.com", "wh-western");

  const postedA = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelA, paidOrder("8801")));
  const outcomeA = await withBypass(() => postChannelOrder(org.orgId, actor, postedA.id));
  assert.equal(outcomeA.status, "posted");
  // The storefront customer buys from both entities, so the shared party is
  // granted the second entity before its order posts there. Stock is
  // entity-owned the same way, so the second entity holds its own units.
  await db.execute(sql`insert into party_subsidiaries (org_id, party_id, subsidiary_id)
    select ${org.orgId}, p.id, ${subB} from parties p
     where p.org_id = ${org.orgId} and p.kind = 'customer' and lower(p.email) = 'ada@example.com'`);
  await withBypass(() => receiveInventory(org.orgId, actor, {
    itemId: org.items.fifo, stockLocationId: org.stockLocationId, quantity: "10", unitCost: "2",
    subsidiaryId: subB, offsetAccountId: org.accounts.clearing, date: org.date,
  }));
  const postedB = await withBypass(() => ingestChannelOrder(org.orgId, actor, channelB, smallerOrder("8802")));
  const outcomeB = await withBypass(() => postChannelOrder(org.orgId, actor, postedB.id));
  assert.equal(outcomeB.status, "posted");

  const docOf = async (id: string): Promise<{ id: string; number: string; total: string }> => (await db.execute<{ id: string; number: string; total: string }>(sql`
    select id, document_number as number, total::text as total from documents where org_id = ${org.orgId} and id = ${id}`)).rows[0]!;
  const docA = await docOf(outcomeA.documentId!);
  const docB = await docOf(outcomeB.documentId!);
  assert.notEqual(docA.number, docB.number, "the two entities post distinct receipt numbers");

  const draftB = (await db.execute<{ id: string }>(sql`
    insert into documents (org_id, kind, status, document_number, subsidiary_id, document_date, currency, subtotal, tax_total, total)
    values (${org.orgId}, 'cash_sale', 'draft', 'CS-DRAFT-W1', ${subB}, ${org.date}, 'CAD', '5', '0', '5')
    returning id`)).rows[0]!.id;

  await withBypass(() => linkExternal(org.orgId, actor, {
    provider: "stripe", externalAccount: "acct_1", objectType: "payout",
    externalId: "txn-mix-1", nativeTable: "documents", nativeId: docA.id,
  }, "salesChannels"));
  await withBypass(() => linkExternal(org.orgId, actor, {
    provider: "stripe", externalAccount: "acct_1", objectType: "order",
    externalId: "order-hidden-1", nativeTable: "documents", nativeId: docB.id,
  }, "salesChannels"));
  // One native record carries one external identity per account, so the
  // companion hidden claims arrive through the second account.
  await withBypass(() => linkExternal(org.orgId, actor, {
    provider: "stripe", externalAccount: "acct_1", objectType: "payout",
    externalId: "txn-hidden-2", nativeTable: "documents", nativeId: docB.id,
  }, "salesChannels"));
  await withBypass(() => linkExternal(org.orgId, actor, {
    provider: "stripe", externalAccount: "acct_2", objectType: "payout",
    externalId: "txn-hidden-3", nativeTable: "documents", nativeId: docB.id,
  }, "salesChannels"));
  await withBypass(() => linkExternal(org.orgId, actor, {
    provider: "stripe", externalAccount: "acct_2", objectType: "order",
    externalId: "order-hidden-B", nativeTable: "documents", nativeId: docB.id,
  }, "salesChannels"));
  await withBypass(() => linkExternal(org.orgId, actor, {
    provider: "stripe", externalAccount: "acct_1", objectType: "payout",
    externalId: "txn-draft-B", nativeTable: "documents", nativeId: draftB,
  }, "salesChannels"));

  const settlementAccounts = {
    bankAccountId: org.accounts.bank,
    feeAccountId: org.accounts.adjustment,
    clearingAccountId: org.accounts.clearing,
  };
  const batchA = (await importSettlementBatch(org.orgId, actor, {
    provider: "stripe",
    externalRef: "po_scope_A",
    settlementDate: "2026-07-10",
    currency: "CAD",
    lines: [
      { kind: "charge", amount: "60.40", externalRef: "txn-mix-1", currency: "CAD", meta: { sourceOrderId: "order-hidden-1" } },
      { kind: "charge", amount: docB.total, externalRef: "txn-hidden-2", currency: "CAD", meta: {} },
      { kind: "charge", amount: "10.00", externalRef: "txn-hidden-3", currency: "CAD", meta: {} },
      { kind: "charge", amount: "5.00", externalRef: "txn-draft-B", currency: "CAD", meta: {} },
      { kind: "charge", amount: "7.00", externalRef: "txn-plain-5", currency: "CAD", meta: {} },
    ],
  }, { ...settlementAccounts, subsidiaryId: org.subsidiaryId }, null)).batchId;
  const batchB = (await importSettlementBatch(org.orgId, actor, {
    provider: "stripe",
    externalRef: "po_scope_B",
    settlementDate: "2026-07-10",
    currency: "CAD",
    lines: [
      { kind: "charge", amount: docB.total, externalRef: "txn-hidden-B", currency: "CAD", meta: { sourceOrderId: "order-hidden-B" } },
    ],
  }, { ...settlementAccounts, subsidiaryId: subB }, null)).batchId;

  const shopParsed = parseShopifyPaymentsPayout(
    { id: "shopify-payout-scope-1", currency: "CAD", issuedAt: "2026-07-10" },
    [
      { id: "txn-shop-A", type: "charge", amount: "60.40", currency: "CAD", sourceOrderId: "gid://shopify/Order/8801" },
      { id: "txn-shop-B", type: "charge", amount: docB.total, currency: "CAD", sourceOrderId: "8802" },
    ],
  );
  const batchShop = (await importSettlementBatch(org.orgId, actor, shopParsed, {
    ...settlementAccounts, subsidiaryId: org.subsidiaryId,
  }, null)).batchId;

  const lineOf = async (batchId: string, ref: string): Promise<string> => (await db.execute<{ id: string }>(sql`
    select id from psp_settlement_lines where batch_id = ${batchId} and org_id = ${org.orgId} and external_ref = ${ref}`)).rows[0]!.id;
  const lines: Record<string, string> = {
    mix: await lineOf(batchA, "txn-mix-1"),
    hiddenOnly: await lineOf(batchA, "txn-hidden-2"),
    hiddenCompanion: await lineOf(batchA, "txn-hidden-3"),
    hiddenDraft: await lineOf(batchA, "txn-draft-B"),
    plain: await lineOf(batchA, "txn-plain-5"),
    otherEntity: await lineOf(batchB, "txn-hidden-B"),
    shopVisible: await lineOf(batchShop, "txn-shop-A"),
    shopHidden: await lineOf(batchShop, "txn-shop-B"),
  };
  // A stored manual link from the home payout to the other entity's receipt:
  // the writer permits an explicit operator link; discovery must not propose
  // from it, and a restricted caller must not read through it.
  await setSettlementLineDocument(org.orgId, batchA, lines.plain!, docB.id, actor, null);
  return { subB, channelA, channelB, docA, docB, batchA, batchB, batchShop, lines };
}

const homeScope = (org: ScratchOrg): ReadonlySet<string> => new Set([org.subsidiaryId]);

test("a restricted caller reads another entity's settlement line as missing", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { docB, lines } = await seed(org, actor);
    await assert.rejects(
      () => suggestPayoutLineFix(org.orgId, lines.otherEntity!, homeScope(org)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /does not belong to this organization/);
        assert.ok(!error.message.includes(docB.number), "the refusal names no receipt number");
        return true;
      },
      "the other entity's line refuses as missing",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("discovery proposes only the caller's entity and names no hidden receipt", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { docA, docB, lines } = await seed(org, actor);
    const scope = homeScope(org);
    const mixed = await suggestPayoutLineFix(org.orgId, lines.mix!, scope);
    assert.equal(mixed.code, "single_candidate", `one entity cannot borrow another's receipt: ${mixed.code}`);
    assert.equal(mixed.candidates.length, 1);
    const [only] = mixed.candidates;
    assert.ok(only!.action.type === "link_document" && only!.action.documentId === docA.id);
    for (const text of [mixed.explanation, ...only!.evidence]) {
      assert.ok(!text.includes(docB.number), `hidden receipt number leaks: ${text}`);
      assert.ok(!text.includes(docB.total), `hidden receipt total leaks: ${text}`);
    }
    const hidden = await suggestPayoutLineFix(org.orgId, lines.hiddenOnly!, scope);
    assert.equal(hidden.code, "no_candidate");
    assert.equal(hidden.similarCount, 2, "both hidden-claim lines in this payout wait on the same cause");
    for (const text of [hidden.explanation, ...hidden.candidates.flatMap((candidate) => candidate.evidence)]) {
      assert.ok(!text.includes(docB.number), `hidden receipt number leaks: ${text}`);
      assert.ok(!text.includes(docB.total), `hidden receipt total leaks: ${text}`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a document of a visible but different entity is not a candidate", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { subB, docB, lines } = await seed(org, actor);
    const both = new Set([org.subsidiaryId, subB]);
    const hidden = await suggestPayoutLineFix(org.orgId, lines.hiddenOnly!, both);
    assert.equal(hidden.code, "no_candidate", "visibility alone does not make another entity's receipt a proposal");
    for (const text of [hidden.explanation, ...hidden.candidates.flatMap((candidate) => candidate.evidence)]) {
      assert.ok(!text.includes(docB.number), `other-entity receipt number leaks: ${text}`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("unposted and already-linked hidden receipts stay unnamed", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { docB, lines } = await seed(org, actor);
    const scope = homeScope(org);
    const draft = await suggestPayoutLineFix(org.orgId, lines.hiddenDraft!, scope);
    assert.notEqual(draft.code, "candidates_unposted", "a hidden draft is never named as the thing to post");
    for (const text of [draft.explanation, ...draft.candidates.flatMap((candidate) => candidate.evidence)]) {
      assert.ok(!text.includes("CS-DRAFT-W1"), `hidden draft number leaks: ${text}`);
    }
    const linked = await suggestPayoutLineFix(org.orgId, lines.plain!, scope);
    assert.notEqual(linked.code, "already_linked", "a stored link the caller may not see is never confirmed");
    for (const text of [linked.explanation, ...linked.candidates.flatMap((candidate) => candidate.evidence)]) {
      assert.ok(!text.includes(docB.number), `hidden linked receipt number leaks: ${text}`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("channel-order discovery stays inside the caller's entity", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { docA, docB, lines } = await seed(org, actor);
    const scope = homeScope(org);
    const visible = await suggestPayoutLineFix(org.orgId, lines.shopVisible!, scope);
    assert.equal(visible.code, "single_candidate");
    assert.ok(visible.candidates[0]!.action.type === "link_document" && visible.candidates[0]!.action.documentId === docA.id);
    const hidden = await suggestPayoutLineFix(org.orgId, lines.shopHidden!, scope);
    assert.equal(hidden.code, "no_candidate", "the other entity's channel order proposes nothing");
    for (const text of [hidden.explanation, ...hidden.candidates.flatMap((candidate) => candidate.evidence)]) {
      assert.ok(!text.includes(docB.number), `hidden order receipt number leaks: ${text}`);
      assert.ok(!text.includes("#8802"), `hidden channel order number leaks: ${text}`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("approval discovers under the caller's scope and preserves the audited link", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { docA, lines } = await seed(org, actor);
    const scope = homeScope(org);
    await assert.rejects(
      () => approvePayoutSuggestion(org.orgId, actor, lines.otherEntity!, { rank: 0, applyToSimilar: false }, scope),
      /does not belong to this organization/,
      "approving another entity's line refuses as missing",
    );
    const approved = await approvePayoutSuggestion(org.orgId, actor, lines.mix!, { rank: 0, applyToSimilar: false }, scope);
    assert.equal(approved.linked.length, 1);
    assert.equal(approved.linked[0]!.documentId, docA.id);
    const audits = (await db.execute<{ action: string; changes: unknown }>(sql`
      select action, changes from audit_log
       where org_id = ${org.orgId} and table_name = 'psp_settlement_lines' and row_id = ${lines.mix!}
       order by at`)).rows;
    assert.ok(audits.some((row) => JSON.stringify(row.changes).includes("suggestionApproved")), "the approval decision is audited");
    assert.ok(audits.some((row) => row.action === "link"), "the link itself is audited");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an unknown or empty scope fails closed", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { lines } = await seed(org, actor);
    const unknown = undefined as unknown as ReadonlySet<string> | null;
    await assert.rejects(
      () => suggestPayoutLineFix(org.orgId, lines.mix!, unknown),
      /does not belong to this organization/,
      "an omitted scope reads as missing, never as unrestricted",
    );
    await assert.rejects(
      () => suggestPayoutLineFix(org.orgId, lines.mix!, new Set()),
      /does not belong to this organization/,
      "an empty scope reads as missing",
    );
    await assert.rejects(
      () => approvePayoutSuggestion(org.orgId, actor, lines.mix!, { rank: 0, applyToSimilar: false }, unknown),
      /does not belong to this organization/,
      "approval with an omitted scope refuses before discovery",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an explicitly unrestricted caller keeps the established behavior", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { docB, lines } = await seed(org, actor);
    const suggestion = await suggestPayoutLineFix(org.orgId, lines.otherEntity!, null);
    assert.equal(suggestion.code, "single_candidate");
    assert.ok(suggestion.candidates[0]!.action.type === "link_document");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
