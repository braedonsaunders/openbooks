import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";
import { receiveInventory } from "../../inventory/movements.ts";
import { createChannel } from "../channels.ts";
import { upsertChannelLocation } from "../locations.ts";
import { linkExternal } from "../external-links.ts";
import { ensureShopifyAdapterRegistered } from "./adapter.ts";
import {
  listDueSyncPairs,
  listInventoryConflicts,
  listSyncPairs,
  pushInventoryPair,
  resolveInventoryConflict,
  runCommerceChannelSyncScan,
} from "../inventory-sync.ts";
import { loadShopifyChannel } from "./channel-access.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

interface FakeShopify {
  transport: typeof fetch;
  sets: { item: string; location: string; quantity: number; compare: number | null }[];
  policies: Map<string, string>;
  levels: Map<string, number>;
  calls: number;
}

/**
 * Fake Admin API serving inventory reads and compare-guarded writes on the
 * documented shapes: the set carries changeFromQuantity (always present,
 * null skips the check), and the sellable policy goes through
 * productVariantsBulkUpdate — productVariantUpdate is removed from the Admin
 * API, so no branch serves it and the old call fails loudly here.
 */
function fakeShopify(variantToItem: Map<string, string>, variantToProduct: Map<string, string> = new Map([["9001", "901"]])): FakeShopify {
  const fake: FakeShopify = {
    transport: undefined as unknown as typeof fetch,
    sets: [],
    policies: new Map(),
    levels: new Map(),
    calls: 0,
  };
  fake.transport = (async (_url: string | URL | Request, init?: RequestInit) => {
    fake.calls += 1;
    const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = body.query ?? "";
    const variables = body.variables ?? {};
    if (query.includes("productVariant(id:")) {
      const gid = String(variables.id ?? "");
      const numeric = gid.slice(gid.lastIndexOf("/") + 1);
      const itemNumeric = variantToItem.get(numeric);
      const productNumeric = variantToProduct.get(numeric);
      if (!itemNumeric || !productNumeric) return Response.json({ errors: [{ message: "not found" }] });
      return Response.json({
        data: {
          productVariant: {
            inventoryItem: { id: `gid://shopify/InventoryItem/${itemNumeric}` },
            product: { id: `gid://shopify/Product/${productNumeric}` },
          },
        },
      });
    }
    if (query.includes("inventoryLevel(locationId:")) {
      const key = `${String(variables.itemId)}|${String(variables.locationId)}`;
      const quantity = fake.levels.get(key);
      return Response.json({
        data: {
          inventoryItem: {
            inventoryLevel:
              quantity === undefined
                ? null
                : { quantities: [{ quantity, updatedAt: "2026-10-01T00:00:00Z" }] },
          },
        },
      });
    }
    if (query.includes("inventorySetQuantities(")) {
      const input = variables.input as {
        quantities: { inventoryItemId: string; locationId: string; quantity: number; changeFromQuantity?: number | null }[];
      };
      const line = input.quantities[0] as unknown as Record<string, unknown>;
      if ("compareQuantity" in line) {
        throw new Error("Shopify would reject compareQuantity: the field is changeFromQuantity");
      }
      if (!("changeFromQuantity" in line)) {
        throw new Error("Shopify requires changeFromQuantity even when the check is skipped");
      }
      const itemId = String(line.inventoryItemId ?? "");
      const locationId = String(line.locationId ?? "");
      const quantity = line.quantity;
      const changeFrom = (line.changeFromQuantity ?? null) as number | null;
      if (typeof quantity !== "number") throw new Error("unexpected Shopify call: quantity is not a number");
      const key = `${itemId}|${locationId}`;
      if (changeFrom !== null && fake.levels.get(key) !== changeFrom) {
        return Response.json({
          data: {
            inventorySetQuantities: {
              userErrors: [{ field: [], message: "change from quantity stale" }],
            },
          },
        });
      }
      fake.levels.set(key, quantity);
      fake.sets.push({ item: itemId, location: locationId, quantity, compare: changeFrom });
      return Response.json({
        data: {
          inventorySetQuantities: { inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1" }, userErrors: [] },
        },
      });
    }
    if (query.includes("productVariantsBulkUpdate(")) {
      const productId = String((variables.productId ?? "") as string);
      const variants = (variables.variants ?? []) as { id: string; inventoryPolicy: string }[];
      if (productId === "" || variants.length === 0) {
        return Response.json({
          data: { productVariantsBulkUpdate: { productVariants: null, userErrors: [{ field: [], message: "missing product" }] } },
        });
      }
      for (const variant of variants) fake.policies.set(variant.id, variant.inventoryPolicy);
      return Response.json({
        data: {
          productVariantsBulkUpdate: {
            productVariants: variants.map((variant) => ({ id: variant.id })),
            userErrors: [],
          },
        },
      });
    }
    throw new Error(`unexpected Shopify call: ${query.slice(0, 80)}`);
  }) as unknown as typeof fetch;
  return fake;
}

async function setupShop(): Promise<{ org: ScratchOrg; actor: string; channelId: string; fake: FakeShopify }> {
  ensureShopifyAdapterRegistered();
  const org = await withBypass(() => createScratchOrg());
  const actor = await withBypass(() => createScratchUser(org.orgId, "stock pusher", "stock_pusher"));
  await withBypass(async () => {
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}', coalesce(settings->'features', '{}'::jsonb)
        || '{"salesChannels": true, "orders": true, "inventory": true, "warehousing": true, "fulfillment": true, "outboundWebhooks": true}'::jsonb)
       where id = ${org.orgId}`);
  });
  const { channel } = await withOrgContext(org.orgId, () =>
    createChannel(org.orgId, actor, {
      kind: "shopify",
      name: "stock.myshopify.com",
      subsidiaryId: org.subsidiaryId,
      currency: "USD",
      externalAccount: "stock.myshopify.com",
      secrets: { accessToken: "shpat_test", mode: "token" },
      webhookSecret: "whsec_test",
      settings: {},
    }),
  );
  await withBypass(async () => {
    await db.execute(sql`update sales_channels set status = 'active' where id = ${channel.id}`);
  });
  await withOrgContext(org.orgId, () =>
    upsertChannelLocation(org.orgId, actor, {
      channelId: channel.id,
      externalLocationId: "770001",
      externalName: "Main warehouse",
      stockLocationId: org.stockLocationId,
    }),
  );
  await withOrgContext(org.orgId, () =>
    linkExternal(org.orgId, actor, {
      channelId: channel.id,
      provider: "shopify",
      externalAccount: "stock.myshopify.com",
      objectType: "variant",
      externalId: "9001",
      externalParentId: "901",
      nativeTable: "items",
      nativeId: org.items.fifo,
    }, "salesChannels"),
  );
  const fake = fakeShopify(new Map([["9001", "5001"]]));
  return { org, actor, channelId: channel.id, fake };
}

const run = <T>(orgId: string, work: () => Promise<T>) => withOrgContext(orgId, work);

test("movement events coalesce to one pair and the first push sets the baseline", DB, async () => {
  const { org, actor, channelId, fake } = await setupShop();
  try {
    const user = await withBypass(() => createScratchUser(org.orgId, "receiver", "receiver"));
    await withBypass(() =>
      receiveInventory(org.orgId, user, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "6",
        unitCost: "2",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      }),
    );
    await withBypass(() =>
      receiveInventory(org.orgId, user, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "4",
        unitCost: "2",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      }),
    );
    const due = await run(org.orgId, () =>
      listDueSyncPairs(org.orgId, channelId, new Date(Date.now() + 5 * 60_000)),
    );
    assert.equal(due.length, 1, "two movements coalesce to one due pair");
    const access = await run(org.orgId, () => loadShopifyChannel(org.orgId, channelId));
    const outcome = await run(org.orgId, () =>
      pushInventoryPair(org.orgId, actor, access, due[0]!, { transport: fake.transport }),
    );
    assert.deepEqual(outcome, { result: "pushed", quantity: 10 });
    assert.equal(fake.sets.length, 1);
    assert.deepEqual(
      { quantity: fake.sets[0]!.quantity, compare: fake.sets[0]!.compare },
      { quantity: 10, compare: null },
    );
    assert.equal(fake.policies.get("gid://shopify/ProductVariant/9001"), "DENY");
    const state = (
      await run(org.orgId, () => db.execute<{ last_pushed_quantity: number; last_status: string }>(sql`
        select last_pushed_quantity, last_status from channel_inventory_push_states
         where org_id = ${org.orgId} and channel_id = ${channelId}`))
    ).rows[0];
    assert.deepEqual(
      { quantity: state?.last_pushed_quantity, status: state?.last_status },
      { quantity: 10, status: "ok" },
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a quiet scan pushes nothing: the run is idempotent", DB, async () => {
  const { org, actor, channelId, fake } = await setupShop();
  try {
    const user = await withBypass(() => createScratchUser(org.orgId, "receiver", "receiver"));
    await withBypass(() =>
      receiveInventory(org.orgId, user, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        unitCost: "2",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      }),
    );
    const now = new Date(Date.now() + 5 * 60_000);
    const access = await run(org.orgId, () => loadShopifyChannel(org.orgId, channelId));
    const pairs = await run(org.orgId, () => listSyncPairs(org.orgId, channelId));
    await run(org.orgId, () => pushInventoryPair(org.orgId, actor, access, pairs[0]!, { transport: fake.transport }));
    const setsAfterFirst = fake.sets.length;
    assert.ok(setsAfterFirst > 0, "the first run pushes");
    const summaries = await runCommerceChannelSyncScan({ transport: fake.transport, now });
    const summary = summaries.find((entry) => entry.channelId === channelId);
    assert.equal(fake.sets.length, setsAfterFirst, "the second run writes nothing to Shopify");
    assert.equal(summary?.pushed ?? -1, 0);
    assert.equal(summary?.conflicts ?? -1, 0);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a quantity changed outside OpenBooks becomes a conflict, never an overwrite", DB, async () => {
  const { org, actor, channelId, fake } = await setupShop();
  try {
    const user = await withBypass(() => createScratchUser(org.orgId, "receiver", "receiver"));
    await withBypass(() =>
      receiveInventory(org.orgId, user, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        unitCost: "2",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      }),
    );
    const access = await run(org.orgId, () => loadShopifyChannel(org.orgId, channelId));
    const pairs = await run(org.orgId, () => listSyncPairs(org.orgId, channelId));
    await run(org.orgId, () => pushInventoryPair(org.orgId, actor, access, pairs[0]!, { transport: fake.transport }));
    // The merchant corrects the level in Shopify admin; the next push must
    // surface it instead of setting 10 over it.
    fake.levels.set("gid://shopify/InventoryItem/5001|gid://shopify/Location/770001", 4);
    await run(org.orgId, () => db.execute(sql`
      update channel_inventory_push_states set last_pushed_at = now() - interval '5 hours'
       where org_id = ${org.orgId} and channel_id = ${channelId}`));
    const retry = await run(org.orgId, () =>
      pushInventoryPair(org.orgId, actor, access, pairs[0]!, { transport: fake.transport }),
    );
    assert.deepEqual(retry, { result: "conflict", openbooks: 10, shopify: 4 });
    assert.equal(
      fake.levels.get("gid://shopify/InventoryItem/5001|gid://shopify/Location/770001"),
      4,
      "the storefront quantity is never overwritten by the conflict path",
    );
    const conflicts = await run(org.orgId, () => listInventoryConflicts(org.orgId, channelId));
    assert.equal(conflicts.length, 1);
    assert.deepEqual(
      { openbooks: conflicts[0]!.openbooksQuantity, shopify: conflicts[0]!.shopifyQuantity },
      { openbooks: 10, shopify: 4 },
    );
    // While the conflict waits, the pair skips instead of re-conflicting.
    const blocked = await run(org.orgId, () =>
      pushInventoryPair(org.orgId, actor, access, pairs[0]!, { transport: fake.transport }),
    );
    assert.equal(blocked.result, "skipped");
    // Pushing OpenBooks force-sets with a fresh compare.
    const resolved = await run(org.orgId, () =>
      resolveInventoryConflict(org.orgId, actor, conflicts[0]!.id, "pushed_openbooks", {
        transport: fake.transport,
      }),
    );
    assert.deepEqual(resolved, { resolution: "pushed_openbooks", quantity: 10 });
    assert.equal(fake.levels.get("gid://shopify/InventoryItem/5001|gid://shopify/Location/770001"), 10);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("the buffer holds stock back and a kit pushes its component-derived availability", DB, async () => {
  const { org, actor, channelId, fake } = await setupShop();
  try {
    const user = await withBypass(() => createScratchUser(org.orgId, "receiver", "receiver"));
    await withBypass(() =>
      receiveInventory(org.orgId, user, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        unitCost: "2",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      }),
    );
    await run(org.orgId, () =>
      upsertChannelLocation(org.orgId, actor, {
        channelId,
        externalLocationId: "770001",
        externalName: "Main warehouse",
        stockLocationId: org.stockLocationId,
        bufferQuantity: "3",
      }),
    );
    const access = await run(org.orgId, () => loadShopifyChannel(org.orgId, channelId));
    const pairs = await run(org.orgId, () => listSyncPairs(org.orgId, channelId));
    const outcome = await run(org.orgId, () =>
      pushInventoryPair(org.orgId, actor, access, pairs[0]!, { transport: fake.transport }),
    );
    assert.deepEqual(outcome, { result: "pushed", quantity: 7 });
    // A kit of two components pushes five kits from the same ten units.
    const kitId = (
      await run(org.orgId, () => db.execute<{ id: string }>(sql`
        insert into items (org_id, kind, code, name, is_active, created_by, updated_by)
        values (${org.orgId}, 'kit', 'KIT-1', 'Kit One', true, ${actor}, ${actor})
        returning id`))
    ).rows[0]!.id;
    const profile = (
      await run(org.orgId, () => db.execute<{
        asset: string;
        cogs: string;
        adjustment: string;
        clearing: string;
      }>(sql`
        select asset_account_id::text as asset, cogs_account_id::text as cogs,
               adjustment_account_id::text as adjustment,
               received_not_billed_account_id::text as clearing
          from item_inventory_profiles
         where org_id = ${org.orgId} and item_id = ${org.items.fifo} limit 1`))
    ).rows[0]!;
    await run(org.orgId, () => db.execute(sql`
      insert into item_inventory_profiles
        (org_id, item_id, costing_method, tracking, asset_account_id, cogs_account_id,
         adjustment_account_id, variance_account_id, received_not_billed_account_id,
         base_unit, unit_conversions)
      values (${org.orgId}, ${kitId}, 'fifo', 'none', ${profile.asset}, ${profile.cogs},
        ${profile.adjustment}, ${profile.adjustment}, ${profile.clearing}, 'ea', '{}'::jsonb)`));
    await run(org.orgId, () => db.execute(sql`
      insert into bom_components (org_id, assembly_item_id, component_item_id, quantity_per, sort_order)
      values (${org.orgId}, ${kitId}, ${org.items.fifo}, '2', 0)`));
    await run(org.orgId, () =>
      linkExternal(org.orgId, actor, {
        channelId,
        provider: "shopify",
        externalAccount: "stock.myshopify.com",
        objectType: "variant",
        externalId: "9002",
        externalParentId: "901",
        nativeTable: "items",
        nativeId: kitId,
      }, "salesChannels"),
    );
    fake.transport = fakeShopifyVariantTransport(fake, new Map([["9002", "5002"]]));
    const kitPair = (await run(org.orgId, () => listSyncPairs(org.orgId, channelId))).find(
      (pair) => pair.itemId === kitId,
    );
    assert.ok(kitPair, "the kit variant maps to a sync pair");
    const kitOutcome = await run(org.orgId, () =>
      pushInventoryPair(org.orgId, actor, access, kitPair, { transport: fake.transport }),
    );
    // Ten components at two per kit promise five kits, less the location's
    // keep-back buffer of three: the buffer composes with kit derivation.
    assert.deepEqual(kitOutcome, { result: "pushed", quantity: 2 });
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

/** Keep the fake's level store while teaching it one more variant mapping. */
function fakeShopifyVariantTransport(fake: FakeShopify, extra: Map<string, string>): typeof fetch {
  const inner = fake.transport;
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    if ((body.query ?? "").includes("productVariant(id:")) {
      const gid = String((body.variables ?? {}).id ?? "");
      const numeric = gid.slice(gid.lastIndexOf("/") + 1);
      const itemNumeric = extra.get(numeric);
      if (itemNumeric) {
        return Response.json({
          data: {
            productVariant: {
              inventoryItem: { id: `gid://shopify/InventoryItem/${itemNumeric}` },
              product: { id: "gid://shopify/Product/901" },
            },
          },
        });
      }
    }
    return (inner as (url: string | URL | Request, init?: RequestInit) => Promise<Response>)(url, init);
  }) as unknown as typeof fetch;
}

test("accepting Shopify rebases the baseline and stays quiet until either side moves", DB, async () => {
  const { org, actor, channelId, fake } = await setupShop();
  try {
    const user = await withBypass(() => createScratchUser(org.orgId, "receiver", "receiver"));
    await withBypass(() =>
      receiveInventory(org.orgId, user, {
        itemId: org.items.fifo,
        stockLocationId: org.stockLocationId,
        quantity: "10",
        unitCost: "2",
        subsidiaryId: org.subsidiaryId,
        offsetAccountId: org.accounts.clearing,
        date: org.date,
      }),
    );
    const access = await run(org.orgId, () => loadShopifyChannel(org.orgId, channelId));
    const pairs = await run(org.orgId, () => listSyncPairs(org.orgId, channelId));
    await run(org.orgId, () => pushInventoryPair(org.orgId, actor, access, pairs[0]!, { transport: fake.transport }));
    fake.levels.set("gid://shopify/InventoryItem/5001|gid://shopify/Location/770001", 4);
    await run(org.orgId, () => db.execute(sql`
      update channel_inventory_push_states set last_pushed_at = now() - interval '5 hours'
       where org_id = ${org.orgId} and channel_id = ${channelId}`));
    await run(org.orgId, () => pushInventoryPair(org.orgId, actor, access, pairs[0]!, { transport: fake.transport }));
    const conflicts = await run(org.orgId, () => listInventoryConflicts(org.orgId, channelId));
    const accepted = await run(org.orgId, () =>
      resolveInventoryConflict(org.orgId, actor, conflicts[0]!.id, "accepted_shopify", {
        transport: fake.transport,
      }),
    );
    assert.deepEqual(accepted, { resolution: "accepted_shopify", quantity: 4 });
    assert.equal(fake.levels.get("gid://shopify/InventoryItem/5001|gid://shopify/Location/770001"), 4);
    // Nothing moved since: the pair converges on the accepted baseline.
    const quiet = await run(org.orgId, () =>
      pushInventoryPair(org.orgId, actor, access, pairs[0]!, { transport: fake.transport }),
    );
    assert.equal(quiet.result, "converged");
    assert.equal(
      (await run(org.orgId, () => listInventoryConflicts(org.orgId, channelId))).length,
      0,
      "no fresh conflict opens while both sides hold still",
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
