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
import { ingestChannelEvent, ingestChannelOrder } from "./orders.ts";
import { postChannelOrder } from "./order-posting.ts";
import { postChannelRefund } from "./refunds.ts";
import { setPostingPolicy } from "./posting-policies.ts";
import type { ChannelOrder } from "./contracts.ts";
import { approvePayoutSuggestion, suggestPayoutLineFix } from "./exception-assistance.ts";
import { matchPayoutLines } from "./payout-reconciliation.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
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
    provider: "stripe", externalAccount: "acct_2", objectType: "payout",
    externalId: "txn-mix-6", nativeTable: "documents", nativeId: docA.id,
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
      { kind: "charge", amount: docA.total, externalRef: "txn-mix-6", currency: "CAD", meta: {} },
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
    mixCompanion: await lineOf(batchA, "txn-mix-6"),
    hiddenOnly: await lineOf(batchA, "txn-hidden-2"),
    hiddenCompanion: await lineOf(batchA, "txn-hidden-3"),
    hiddenDraft: await lineOf(batchA, "txn-draft-B"),
    plain: await lineOf(batchA, "txn-plain-5"),
    otherEntity: await lineOf(batchB, "txn-hidden-B"),
    shopVisible: await lineOf(batchShop, "txn-shop-A"),
    shopHidden: await lineOf(batchShop, "txn-shop-B"),
  };
  // A link stored before the entity control: it models legacy evidence the
  // writer refuses today, so it is written directly — discovery must not
  // propose from it, and a restricted caller must not read through it.
  const legacy = await db.execute(sql`update psp_settlement_lines set document_id = ${docB.id}
     where id = ${lines.plain!} and org_id = ${org.orgId} and batch_id = ${batchA}`);
  assert.equal(legacy.rowCount, 1, "the legacy cross-entity link lands on its line");
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
        assert.match(error.message, /unavailable in this payout's legal entity/);
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
    assert.equal(mixed.similarCount, 2, "the count covers the visible companion line only");
    const [only] = mixed.candidates;
    assert.ok(only!.action.type === "link_document" && only!.action.documentId === docA.id);
    for (const text of [mixed.explanation, ...only!.evidence]) {
      assert.ok(!text.includes(docB.number), `hidden receipt number leaks: ${text}`);
      assert.ok(!text.includes(docB.total), `hidden receipt total leaks: ${text}`);
    }
    // A claim the caller may not read parks as dangling — never as a named
    // proposal, and never naming what it cannot read. Manual branches report
    // the line itself, so no count can carry another line's cause.
    const hidden = await suggestPayoutLineFix(org.orgId, lines.hiddenOnly!, scope);
    assert.equal(hidden.code, "links_dangling");
    assert.equal(hidden.similarCount, 1);
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
    assert.equal(hidden.code, "links_dangling", "visibility alone does not make another entity's receipt a proposal");
    const texts = [hidden.explanation, ...hidden.candidates.flatMap((candidate) => [candidate.detail, ...candidate.evidence])];
    for (const text of texts) {
      assert.ok(!text.includes(docB.number), `other-entity receipt number leaks: ${text}`);
    }
    // The receipt exists in another entity: the queue must never declare it
    // gone or send the operator hunting a replacement — availability wording
    // with the real remedy instead.
    for (const text of texts) {
      assert.doesNotMatch(text, /gone|no longer belongs|replacement/i, `never asserts deletion of a hidden receipt: ${text}`);
    }
    assert.match(hidden.explanation, /unavailable in this payout's legal entity/, "names availability, not deletion");
    assert.match(hidden.candidates[0]!.detail, /authorized operator/, "the remedy names the real next step");
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
      /unavailable in this payout's legal entity/,
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
      /unavailable in this payout's legal entity/,
      "an omitted scope reads as missing, never as unrestricted",
    );
    await assert.rejects(
      () => suggestPayoutLineFix(org.orgId, lines.mix!, new Set()),
      /unavailable in this payout's legal entity/,
      "an empty scope reads as missing",
    );
    await assert.rejects(
      () => approvePayoutSuggestion(org.orgId, actor, lines.mix!, { rank: 0, applyToSimilar: false }, unknown),
      /unavailable in this payout's legal entity/,
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
    const { lines } = await seed(org, actor);
    const suggestion = await suggestPayoutLineFix(org.orgId, lines.otherEntity!, null);
    assert.equal(suggestion.code, "single_candidate");
    assert.ok(suggestion.candidates[0]!.action.type === "link_document");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the link writer checks the receipt's entity before its status or number", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { docA, docB, batchA, lines } = await seed(org, actor);
    const scope = homeScope(org);
    // A restricted caller meets the hidden receipt as missing: neither its
    // number nor its status steers the refusal.
    await assert.rejects(
      () => setSettlementLineDocument(org.orgId, batchA, lines.plain!, docB.id, actor, scope),
      (error: unknown) => {
        assert.ok(error instanceof ScopeNotFoundError);
        assert.equal(error.message, "not found");
        return true;
      },
      "linking a hidden receipt reads as missing",
    );
    // An explicitly unrestricted caller is refused by name with the remedy.
    await assert.rejects(
      () => setSettlementLineDocument(org.orgId, batchA, lines.plain!, docB.id, actor, null),
      (error: unknown) => {
        assert.ok(error instanceof Error && !(error instanceof ScopeNotFoundError));
        assert.match(error.message, /different legal entity/);
        assert.match(error.message, /payout's entity/);
        assert.ok(error.message.includes(docB.number), "the refusal names the visible receipt");
        return true;
      },
      "linking another entity's receipt refuses with its remedy",
    );
    // An unknown scope writes nothing.
    const unknown = undefined as unknown as ReadonlySet<string> | null;
    await assert.rejects(
      () => setSettlementLineDocument(org.orgId, batchA, lines.hiddenCompanion!, docA.id, actor, unknown),
      (error: unknown) => error instanceof ScopeNotFoundError,
      "an omitted scope writes nothing",
    );
    // A same-entity link still writes through the hardened writer.
    const linked = await setSettlementLineDocument(org.orgId, batchA, lines.hiddenCompanion!, docA.id, actor, scope);
    assert.equal(linked.documentId, docA.id);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a runtime restricted role resolves to the same refusal", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { lines } = await seed(org, actor);
    const clerk = await withBypass(() => createScratchUser(org.orgId, "Entity clerk", "entity-clerk"));
    await db.execute(sql`update app_roles set permissions = '["banking.read"]'::jsonb,
      subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
      where org_id = ${org.orgId} and key = 'entity-clerk'`);
    const resolved = await withBypass(() => actorAllowedSubsidiaryIds(db, org.orgId, clerk));
    assert.ok(resolved instanceof Set, "a restricted role resolves to a finite scope");
    assert.deepEqual([...resolved].sort(), [org.subsidiaryId].sort());
    await assert.rejects(
      () => suggestPayoutLineFix(org.orgId, lines.otherEntity!, resolved),
      /unavailable in this payout's legal entity/,
      "the role-resolved scope refuses the other entity's line",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("matching a batch outside the caller's entity refuses without verdicts", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { batchB, lines } = await seed(org, actor);
    await assert.rejects(
      () => matchPayoutLines(org.orgId, batchB, actor, homeScope(org)),
      (error: unknown) => {
        assert.ok(error instanceof ScopeNotFoundError, `a hidden batch reads as missing, got: ${(error as Error)?.message}`);
        assert.ok(
          !String((error as Error)?.message ?? "").includes(lines.otherEntity!),
          "the refusal carries no hidden line id",
        );
        return true;
      },
      "a hidden batch refuses before any line loads",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("matching with an empty or unknown scope refuses instead of running", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { batchA, batchB } = await seed(org, actor);
    await assert.rejects(
      () => matchPayoutLines(org.orgId, batchB, actor, new Set()),
      (error: unknown) => error instanceof ScopeNotFoundError,
      "an empty scope matches nothing, even a hidden batch",
    );
    await assert.rejects(
      () => matchPayoutLines(org.orgId, batchA, actor, new Set()),
      (error: unknown) => error instanceof ScopeNotFoundError,
      "an empty scope matches nothing, even the home batch",
    );
    const unknown = undefined as unknown as ReadonlySet<string> | null;
    await assert.rejects(
      () => matchPayoutLines(org.orgId, batchB, actor, unknown),
      (error: unknown) => error instanceof ScopeNotFoundError,
      "an unknown scope never runs the matcher",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a runtime restricted role refuses a hidden batch at match", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { batchB } = await seed(org, actor);
    const clerk = await withBypass(() => createScratchUser(org.orgId, "Entity clerk", "entity-clerk"));
    await db.execute(sql`update app_roles set permissions = '["banking.read", "banking.reconcile"]'::jsonb,
      subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [org.subsidiaryId] })}::jsonb
      where org_id = ${org.orgId} and key = 'entity-clerk'`);
    const resolved = await withBypass(() => actorAllowedSubsidiaryIds(db, org.orgId, clerk));
    assert.ok(resolved instanceof Set, "a restricted role resolves to a finite scope");
    await assert.rejects(
      () => matchPayoutLines(org.orgId, batchB, clerk, resolved),
      (error: unknown) => error instanceof ScopeNotFoundError,
      "the role-resolved scope refuses the hidden batch",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the automatic matcher counts only receipts visible in the payout's entity", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { docA, docB } = await seed(org, actor);
    // One provider reference claimed by two receipts in two entities, plus a
    // second reference naming only hidden receipts.
    await withBypass(() => linkExternal(org.orgId, actor, {
      provider: "stripe", externalAccount: "acct_1", objectType: "order",
      externalId: "txn-count-1", nativeTable: "documents", nativeId: docA.id,
    }, "salesChannels"));
    await withBypass(() => linkExternal(org.orgId, actor, {
      provider: "stripe", externalAccount: "acct_3", objectType: "payout",
      externalId: "txn-count-1", nativeTable: "documents", nativeId: docB.id,
    }, "salesChannels"));
    await withBypass(() => linkExternal(org.orgId, actor, {
      provider: "stripe", externalAccount: "acct_3", objectType: "order",
      externalId: "txn-count-2", nativeTable: "documents", nativeId: docB.id,
    }, "salesChannels"));
    const draftId = (await db.execute<{ id: string }>(sql`
      select id from documents where org_id = ${org.orgId} and document_number = 'CS-DRAFT-W1'`)).rows[0]!.id;
    await withBypass(() => linkExternal(org.orgId, actor, {
      provider: "stripe", externalAccount: "acct_1", objectType: "order",
      externalId: "txn-count-2", nativeTable: "documents", nativeId: draftId,
    }, "salesChannels"));
    const batch = (await importSettlementBatch(org.orgId, actor, {
      provider: "stripe", externalRef: "po_scope_count", settlementDate: "2026-07-10", currency: "CAD",
      lines: [
        { kind: "charge", amount: docA.total, externalRef: "txn-count-1", currency: "CAD", meta: {} },
        { kind: "charge", amount: "9.00", externalRef: "txn-count-2", currency: "CAD", meta: {} },
      ],
    }, {
      bankAccountId: org.accounts.bank, feeAccountId: org.accounts.adjustment,
      clearingAccountId: org.accounts.clearing, subsidiaryId: org.subsidiaryId,
    }, null)).batchId;
    const refs = new Map((await db.execute<{ id: string; ref: string }>(sql`
      select id, external_ref as ref from psp_settlement_lines
       where org_id = ${org.orgId} and batch_id = ${batch}`)).rows.map((row) => [row.id, row.ref] as const));
    const result = await matchPayoutLines(org.orgId, batch, actor, homeScope(org));
    const byRef = new Map([...refs].map(([id, ref]) => [ref, result.lines.find((line) => line.lineId === id)!]));
    const mixed = byRef.get("txn-count-1")!;
    assert.equal(mixed.status, "matched", `the visible receipt wins outright, got ${JSON.stringify(mixed)}`);
    assert.ok(mixed.status === "matched" && mixed.documentId === docA.id && mixed.via === "external_link");
    const hidden = byRef.get("txn-count-2")!;
    assert.equal(hidden.status, "unmatched");
    assert.ok(hidden.status === "unmatched");
    assert.equal(hidden.reason, "linked_missing", `hidden claims never read as several documents, got ${hidden.reason}`);
    assert.match(hidden.remedy ?? "", /unavailable in this payout's legal entity/);
    assert.match(hidden.remedy ?? "", /authorized operator/);
    for (const text of [hidden.reason, hidden.remedy ?? ""]) {
      assert.ok(!text.includes(docB.number), `hidden receipt number leaks: ${text}`);
      assert.ok(!text.includes("CS-DRAFT-W1"), `hidden draft number leaks: ${text}`);
      assert.doesNotMatch(text, /several/i, `hidden claims never report a count: ${text}`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("refund claims count only posted receipts visible in the payout's entity", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { channelA, docB } = await seed(org, actor);
    // A real storefront refund posts its cash refund through the product
    // flow; a second refund event names the hidden receipt the same way a
    // companion settlement batch from the other entity would.
    const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelA, "8801", {
      kind: "refund",
      externalId: "r-count-1",
      refund: {
        externalId: "r-count-1",
        orderExternalId: "8801",
        reason: "damaged in transit",
        restock: true,
        totalMinor: 6040n,
        lines: [{
          lineExternalId: "1", sku: "TEE-RED-M", variantExternalId: null, quantity: "2",
          amountMinor: 5000n, taxMinor: 380n, restock: true,
        }],
        shippingMinor: 600n,
        tenders: [{ gateway: "shopify_payments", amountMinor: 6040n }],
        refundedAt: "2026-07-16T09:00:00Z",
      },
      occurredAt: "2026-07-16T09:00:00Z",
    }));
    const refunded = await withBypass(() => postChannelRefund(org.orgId, actor, event.eventId));
    assert.equal(refunded.status, "posted", "the home refund posts its cash refund");
    assert.ok(refunded.documentId);
    const inserted = await db.execute(sql`
      insert into channel_order_events (org_id, channel_id, order_id, kind, external_id, payload, posting_status, posting_document_id, occurred_at)
      values (${org.orgId}, ${channelA}, ${event.orderId}, 'refund', 'r-count-hidden', '{}'::jsonb, 'posted', ${docB.id}, now())`);
    assert.equal(inserted.rowCount, 1, "the hidden refund event lands on the home order");
    const parsed = parseShopifyPaymentsPayout(
      { id: "shopify-payout-refund-1", currency: "CAD", issuedAt: "2026-07-10" },
      [{ id: "txn-refund-R1", type: "refund", amount: "20.00", currency: "CAD", sourceOrderId: "8801" }],
    );
    const batch = (await importSettlementBatch(org.orgId, actor, parsed, {
      bankAccountId: org.accounts.bank, feeAccountId: org.accounts.adjustment,
      clearingAccountId: org.accounts.clearing, subsidiaryId: org.subsidiaryId,
    }, null)).batchId;
    const result = await matchPayoutLines(org.orgId, batch, actor, homeScope(org));
    assert.equal(result.lines.length, 1);
    const [verdict] = result.lines;
    assert.ok(verdict, "the batch yields its refund verdict");
    assert.equal(verdict.status, "matched", `the visible posted refund wins outright, got ${JSON.stringify(verdict)}`);
    assert.ok(verdict.status === "matched" && verdict.documentId === refunded.documentId && verdict.via === "channel_order");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("hidden refund claims never read as several posted refunds", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { channelA, docB } = await seed(org, actor);
    const draftId = (await db.execute<{ id: string }>(sql`
      select id from documents where org_id = ${org.orgId} and document_number = 'CS-DRAFT-W1'`)).rows[0]!.id;
    const orderId = (await db.execute<{ id: string }>(sql`
      select id from channel_orders
       where org_id = ${org.orgId} and channel_id = ${channelA} and external_id = '8801'`)).rows[0]!.id;
    for (const [externalId, documentId] of [["refund-hidden-1", docB.id], ["refund-hidden-2", draftId]] as const) {
      const inserted = await db.execute(sql`
        insert into channel_order_events (org_id, channel_id, order_id, kind, external_id, payload, posting_status, posting_document_id, occurred_at)
        values (${org.orgId}, ${channelA}, ${orderId}, 'refund', ${externalId}, '{}'::jsonb, 'posted', ${documentId}, now())`);
      assert.equal(inserted.rowCount, 1, "the refund event lands on the home order");
    }
    const parsed = parseShopifyPaymentsPayout(
      { id: "shopify-payout-refund-2", currency: "CAD", issuedAt: "2026-07-10" },
      [{ id: "txn-refund-R2", type: "refund", amount: "20.00", currency: "CAD", sourceOrderId: "8801" }],
    );
    const batch = (await importSettlementBatch(org.orgId, actor, parsed, {
      bankAccountId: org.accounts.bank, feeAccountId: org.accounts.adjustment,
      clearingAccountId: org.accounts.clearing, subsidiaryId: org.subsidiaryId,
    }, null)).batchId;
    const result = await matchPayoutLines(org.orgId, batch, actor, homeScope(org));
    assert.equal(result.lines.length, 1);
    const [verdict] = result.lines;
    assert.ok(verdict, "the batch yields its refund verdict");
    assert.equal(verdict.status, "unmatched");
    assert.ok(verdict.status === "unmatched");
    assert.equal(verdict.reason, "refund_unavailable", `hidden refund claims never read as several, got ${verdict.reason}`);
    assert.match(verdict.remedy, /unavailable in this payout's legal entity/);
    assert.match(verdict.remedy, /authorized operator/);
    for (const text of [verdict.reason, verdict.remedy]) {
      assert.ok(!text.includes(docB.number), `hidden receipt number leaks: ${text}`);
      assert.ok(!text.includes("CS-DRAFT-W1"), `hidden draft number leaks: ${text}`);
      assert.doesNotMatch(text, /several/i, `hidden claims never report a count: ${text}`);
      assert.doesNotMatch(text, /not posted/i, `hidden posted claims never read as unposted: ${text}`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an order outside the payout's entity never makes its line ambiguous", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { subB, channelB, batchShop, lines, docA } = await seed(org, actor);
    // The same storefront order number ingested on the western storefront and
    // never posted there. The caller may see both entities, but the payout is
    // a home-entity payout, so discovery must not see the western order at all.
    await withBypass(() => ingestChannelOrder(org.orgId, actor, channelB, paidOrder("8801")));
    const both = new Set([org.subsidiaryId, subB]);
    const result = await matchPayoutLines(org.orgId, batchShop, actor, both);
    const line = result.lines.find((verdict) => verdict.lineId === lines.shopVisible);
    assert.ok(line, "the shop line reports its verdict");
    assert.equal(line.status, "matched", `the home order resolves alone, got ${JSON.stringify(line)}`);
    assert.ok(line.status === "matched" && line.documentId === docA.id && line.via === "channel_order");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a claimed but ineligible order never asks for re-ingest", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { subB } = await seed(org, actor);
    // Order 8802 posted on the western storefront: the caller may see both
    // entities, but the home payout cannot use it.
    const parsed = parseShopifyPaymentsPayout(
      { id: "shopify-payout-foreign-order-1", currency: "CAD", issuedAt: "2026-07-10" },
      [{ id: "txn-foreign-8802", type: "charge", amount: "25.30", currency: "CAD", sourceOrderId: "8802" }],
    );
    const batch = (await importSettlementBatch(org.orgId, actor, parsed, {
      bankAccountId: org.accounts.bank, feeAccountId: org.accounts.adjustment,
      clearingAccountId: org.accounts.clearing, subsidiaryId: org.subsidiaryId,
    }, null)).batchId;
    const result = await matchPayoutLines(org.orgId, batch, actor, new Set([org.subsidiaryId, subB]));
    assert.equal(result.lines.length, 1);
    const [verdict] = result.lines;
    assert.ok(verdict, "the batch yields its order verdict");
    assert.equal(verdict.status, "unmatched");
    assert.ok(verdict.status === "unmatched");
    assert.equal(verdict.reason, "order_unavailable", `an ineligible order never reads as unknown, got ${verdict.reason}`);
    assert.match(verdict.remedy, /No eligible order in this payout's legal entity/);
    assert.match(verdict.remedy, /authorized operator/);
    for (const text of [verdict.reason, verdict.remedy]) {
      assert.ok(!text.includes("#8802"), `the foreign order number leaks: ${text}`);
      assert.doesNotMatch(text, /ingest/i, `an ineligible order never asks for re-ingest: ${text}`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("hidden, draft and missing sale documents share one neutral answer", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { channelA, docB } = await seed(org, actor);
    const draftId = (await db.execute<{ id: string }>(sql`
      select id from documents where org_id = ${org.orgId} and document_number = 'CS-DRAFT-W1'`)).rows[0]!.id;
    // Legacy cross-posted evidence: the home order points at receipts the
    // caller may not use the way a pre-control posting left them. Posted,
    // draft and missing targets must answer identically: the remedy never
    // infers posting state from denied visibility.
    const parsed = parseShopifyPaymentsPayout(
      { id: "shopify-payout-hidden-sale-1", currency: "CAD", issuedAt: "2026-07-10" },
      [{ id: "txn-hidden-sale-1", type: "charge", amount: "60.40", currency: "CAD", sourceOrderId: "gid://shopify/Order/8801" }],
    );
    const batch = (await importSettlementBatch(org.orgId, actor, parsed, {
      bankAccountId: org.accounts.bank, feeAccountId: org.accounts.adjustment,
      clearingAccountId: org.accounts.clearing, subsidiaryId: org.subsidiaryId,
    }, null)).batchId;
    const remedies: string[] = [];
    for (const [label, documentId] of [["posted", docB.id], ["draft", draftId], ["missing", randomUUID()]] as const) {
      const moved = await db.execute(sql`update channel_orders set posting_document_id = ${documentId}
         where org_id = ${org.orgId} and channel_id = ${channelA} and external_id = '8801'`);
      assert.equal(moved.rowCount, 1, `the home order carries the ${label} receipt`);
      const result = await matchPayoutLines(org.orgId, batch, actor, homeScope(org));
      assert.equal(result.lines.length, 1);
      const [verdict] = result.lines;
      assert.ok(verdict, `the batch yields its ${label} sale verdict`);
      assert.equal(verdict.status, "unmatched");
      assert.ok(verdict.status === "unmatched");
      assert.equal(verdict.reason, "document_unavailable", `a ${label} sale document never reads as unposted, got ${verdict.reason}`);
      assert.match(verdict.remedy, /channel order's document is unavailable/);
      assert.match(verdict.remedy, /authorized operator/);
      for (const text of [verdict.reason, verdict.remedy]) {
        assert.ok(!text.includes(docB.number), `hidden receipt number leaks: ${text}`);
        assert.ok(!text.includes("CS-DRAFT-W1"), `hidden draft number leaks: ${text}`);
        assert.doesNotMatch(text, /post the order/i, `denied visibility never asks for posting: ${text}`);
      }
      remedies.push(verdict.remedy);
    }
    assert.deepEqual(remedies, [remedies[0], remedies[0], remedies[0]], "posting state never steers the answer");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("hidden, draft and missing summary documents share one neutral answer", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { channelA, docB } = await seed(org, actor);
    const draftId = (await db.execute<{ id: string }>(sql`
      select id from documents where org_id = ${org.orgId} and document_number = 'CS-DRAFT-W1'`)).rows[0]!.id;
    const summaryId = (await db.execute<{ id: string }>(sql`
      insert into channel_daily_summaries (org_id, channel_id, summary_date, stock_location_id, currency, posting_document_id)
      values (${org.orgId}, ${channelA}, ${org.date}, ${org.stockLocationId}, 'CAD', ${docB.id})
      returning id`)).rows[0]!.id;
    const moved = await db.execute(sql`update channel_orders set posting_document_id = null, summary_id = ${summaryId}
       where org_id = ${org.orgId} and channel_id = ${channelA} and external_id = '8801'`);
    assert.equal(moved.rowCount, 1, "the home order summarizes in the channel");
    const parsed = parseShopifyPaymentsPayout(
      { id: "shopify-payout-hidden-summary-1", currency: "CAD", issuedAt: "2026-07-10" },
      [{ id: "txn-hidden-sum-1", type: "charge", amount: "60.40", currency: "CAD", sourceOrderId: "8801" }],
    );
    const batch = (await importSettlementBatch(org.orgId, actor, parsed, {
      bankAccountId: org.accounts.bank, feeAccountId: org.accounts.adjustment,
      clearingAccountId: org.accounts.clearing, subsidiaryId: org.subsidiaryId,
    }, null)).batchId;
    const remedies: string[] = [];
    for (const [label, documentId] of [["posted", docB.id], ["draft", draftId], ["missing", randomUUID()]] as const) {
      const pointed = await db.execute(sql`update channel_daily_summaries set posting_document_id = ${documentId}
         where org_id = ${org.orgId} and id = ${summaryId}`);
      assert.equal(pointed.rowCount, 1, `the summary carries the ${label} receipt`);
      const result = await matchPayoutLines(org.orgId, batch, actor, homeScope(org));
      assert.equal(result.lines.length, 1);
      const [verdict] = result.lines;
      assert.ok(verdict, `the batch yields its ${label} summary verdict`);
      assert.equal(verdict.status, "unmatched");
      assert.ok(verdict.status === "unmatched");
      assert.equal(verdict.reason, "document_unavailable", `a ${label} summary document never reads as unposted, got ${verdict.reason}`);
      assert.match(verdict.remedy, /daily summary's document is unavailable/);
      assert.match(verdict.remedy, /authorized operator/);
      for (const text of [verdict.reason, verdict.remedy]) {
        assert.ok(!text.includes(docB.number), `hidden receipt number leaks: ${text}`);
        assert.ok(!text.includes("CS-DRAFT-W1"), `hidden draft number leaks: ${text}`);
        assert.doesNotMatch(text, /post it/i, `denied visibility never asks for posting: ${text}`);
      }
      remedies.push(verdict.remedy);
    }
    assert.deepEqual(remedies, [remedies[0], remedies[0], remedies[0]], "posting state never steers the answer");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a hidden order answers exactly like an unknown one to a restricted caller", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    await seed(org, actor);
    // 8802 exists on a channel the caller may not see; 9999 exists nowhere.
    // A restricted caller runs no existence read, so both answer identically
    // without ever instructing ingestion.
    const parsed = parseShopifyPaymentsPayout(
      { id: "shopify-payout-oracle-1", currency: "CAD", issuedAt: "2026-07-10" },
      [
        { id: "txn-oracle-hidden", type: "charge", amount: "25.30", currency: "CAD", sourceOrderId: "8802" },
        { id: "txn-oracle-unknown", type: "charge", amount: "11.00", currency: "CAD", sourceOrderId: "9999" },
      ],
    );
    const batch = (await importSettlementBatch(org.orgId, actor, parsed, {
      bankAccountId: org.accounts.bank, feeAccountId: org.accounts.adjustment,
      clearingAccountId: org.accounts.clearing, subsidiaryId: org.subsidiaryId,
    }, null)).batchId;
    const refs = new Map((await db.execute<{ id: string; ref: string }>(sql`
      select id, external_ref as ref from psp_settlement_lines
       where org_id = ${org.orgId} and batch_id = ${batch}`)).rows.map((row) => [row.id, row.ref] as const));
    const result = await matchPayoutLines(org.orgId, batch, actor, homeScope(org));
    const byRef = new Map([...refs].map(([id, ref]) => [ref, result.lines.find((line) => line.lineId === id)!]));
    const hidden = byRef.get("txn-oracle-hidden")!;
    const unknown = byRef.get("txn-oracle-unknown")!;
    assert.ok(hidden.status === "unmatched" && unknown.status === "unmatched");
    assert.equal(hidden.reason, "order_unavailable");
    assert.equal(hidden.reason, unknown.reason, "hidden reads exactly like missing");
    assert.equal(hidden.remedy, unknown.remedy, "hidden remedies exactly like missing");
    assert.doesNotMatch(hidden.remedy, /ingest/i, "no existence read ever instructs ingestion");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an unrestricted caller keeps unknown and foreign order answers apart", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    await seed(org, actor);
    // Explicit null hides nothing: the home payout cannot use the western
    // order, while a reference nothing claims keeps the ingest remedy.
    const parsed = parseShopifyPaymentsPayout(
      { id: "shopify-payout-null-oracle-1", currency: "CAD", issuedAt: "2026-07-10" },
      [
        { id: "txn-null-foreign", type: "charge", amount: "25.30", currency: "CAD", sourceOrderId: "8802" },
        { id: "txn-null-unknown", type: "charge", amount: "11.00", currency: "CAD", sourceOrderId: "9999" },
      ],
    );
    const batch = (await importSettlementBatch(org.orgId, actor, parsed, {
      bankAccountId: org.accounts.bank, feeAccountId: org.accounts.adjustment,
      clearingAccountId: org.accounts.clearing, subsidiaryId: org.subsidiaryId,
    }, null)).batchId;
    const refs = new Map((await db.execute<{ id: string; ref: string }>(sql`
      select id, external_ref as ref from psp_settlement_lines
       where org_id = ${org.orgId} and batch_id = ${batch}`)).rows.map((row) => [row.id, row.ref] as const));
    const result = await matchPayoutLines(org.orgId, batch, actor, null);
    const byRef = new Map([...refs].map(([id, ref]) => [ref, result.lines.find((line) => line.lineId === id)!]));
    const foreign = byRef.get("txn-null-foreign")!;
    const unknown = byRef.get("txn-null-unknown")!;
    assert.ok(foreign.status === "unmatched" && unknown.status === "unmatched");
    assert.equal(foreign.reason, "order_unavailable", `a foreign order reads unavailable, got ${foreign.reason}`);
    assert.equal(unknown.reason, "order_unknown", `a truly unknown reference keeps ingestion, got ${unknown.reason}`);
    assert.match(unknown.remedy, /ingest it under Channels/, "the ingest remedy survives where nothing hides");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("two visible posted refunds still read as ambiguous", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actor = await withBypass(() => createScratchUser(org.orgId, "Scope clerk", "admin"));
    const { channelA } = await seed(org, actor);
    // Two partial refunds through the product flow exhaust the order exactly,
    // so both cash refunds post in the home entity.
    const partial = async (externalId: string, quantity: string, amount: bigint, shipping: bigint, total: bigint, refundedAt: string) => {
      const event = await withBypass(() => ingestChannelEvent(org.orgId, actor, channelA, "8801", {
        kind: "refund",
        externalId,
        refund: {
          externalId,
          orderExternalId: "8801",
          reason: "damaged in transit",
          restock: true,
          totalMinor: total,
          lines: [{
            lineExternalId: "1", sku: "TEE-RED-M", variantExternalId: null, quantity,
            amountMinor: amount, taxMinor: null, restock: true,
          }],
          shippingMinor: shipping,
          tenders: [{ gateway: "shopify_payments", amountMinor: total }],
          refundedAt,
        },
        occurredAt: refundedAt,
      }));
      const outcome = await withBypass(() => postChannelRefund(org.orgId, actor, event.eventId));
      assert.equal(outcome.status, "posted", `partial refund ${externalId} posts`);
      assert.ok(outcome.documentId);
    };
    await partial("r-2vis-1", "1", 2500n, 0n, 2690n, "2026-07-16T09:00:00Z");
    await partial("r-2vis-2", "1", 2500n, 600n, 3350n, "2026-07-17T09:00:00Z");
    const parsed = parseShopifyPaymentsPayout(
      { id: "shopify-payout-refund-3", currency: "CAD", issuedAt: "2026-07-10" },
      [{ id: "txn-refund-R3", type: "refund", amount: "20.00", currency: "CAD", sourceOrderId: "8801" }],
    );
    const batch = (await importSettlementBatch(org.orgId, actor, parsed, {
      bankAccountId: org.accounts.bank, feeAccountId: org.accounts.adjustment,
      clearingAccountId: org.accounts.clearing, subsidiaryId: org.subsidiaryId,
    }, null)).batchId;
    const result = await matchPayoutLines(org.orgId, batch, actor, homeScope(org));
    assert.equal(result.lines.length, 1);
    const [verdict] = result.lines;
    assert.ok(verdict, "the batch yields its refund verdict");
    assert.equal(verdict.status, "unmatched");
    assert.ok(verdict.status === "unmatched");
    assert.equal(verdict.reason, "ambiguous_refund", `two visible refunds still refuse to guess, got ${verdict.reason}`);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
