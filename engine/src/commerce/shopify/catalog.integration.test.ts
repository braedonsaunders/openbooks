import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext } from "../../platform/db.ts";
import { createChannel } from "../channels.ts";
import {
  bulkDecideCatalogMatches,
  catalogQueueCounts,
  decideCatalogMatch,
  importShopifyCatalog,
  listCatalogQueue,
} from "./catalog.ts";
import { ensureShopifyAdapterRegistered } from "./adapter.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "../../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

interface FakeVariant {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: { amount: string; currencyCode: string };
  options: Record<string, string>;
}

interface FakeProduct {
  id: string;
  title: string;
  variants: FakeVariant[];
}

function variantNode(variant: FakeVariant): Record<string, unknown> {
  return {
    id: `gid://shopify/ProductVariant/${variant.id}`,
    title: variant.title,
    sku: variant.sku,
    barcode: variant.barcode,
    taxable: true,
    updatedAt: "2026-09-01T00:00:00Z",
    price: variant.price,
    compareAtPrice: null,
    inventoryItem: { tracked: true },
    selectedOptions: Object.entries(variant.options).map(([name, value]) => ({ name, value })),
  };
}

function productNode(product: FakeProduct): Record<string, unknown> {
  const names = [...new Set(product.variants.flatMap((v) => Object.keys(v.options)))];
  return {
    id: `gid://shopify/Product/${product.id}`,
    title: product.title,
    vendor: "Test vendor",
    productType: "Shirts",
    status: "ACTIVE",
    updatedAt: "2026-09-01T00:00:00Z",
    options: names.map((name) => ({
      name,
      values: [...new Set(product.variants.map((v) => v.options[name]!))],
    })),
    variants: { edges: product.variants.map((v) => ({ node: variantNode(v) })) },
  };
}

/** Fake Admin API transport serving a mutable catalog. */
function fakeTransport(catalog: () => FakeProduct[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) as {
      query?: string;
      variables?: { after?: string | null };
    };
    const query = body.query ?? "";
    if (query.includes("productsCount")) {
      return Response.json({ data: { productsCount: { count: catalog().length } } });
    }
    if (query.includes("products(first:")) {
      const after = body.variables?.after ?? null;
      const products = catalog();
      const page = after === null ? products.slice(0, 2) : products.slice(2);
      return Response.json({
        data: {
          products: {
            edges: page.map((product) => ({ node: productNode(product) })),
            pageInfo: {
              hasNextPage: after === null && products.length > 2,
              endCursor: after === null ? "c1" : null,
            },
          },
        },
      });
    }
    void url;
    throw new Error(`unexpected Shopify call: ${query.slice(0, 80)}`);
  }) as typeof fetch;
}

function baseCatalog(): FakeProduct[] {
  return [
    {
      id: "101",
      title: "Widget One",
      variants: [
        { id: "1001", title: "Default", sku: "widget-1", barcode: null, price: { amount: "19.99", currencyCode: "USD" }, options: {} },
      ],
    },
    {
      id: "102",
      title: "Gadget Two",
      variants: [
        { id: "1002", title: "Default", sku: null, barcode: "012345678905", price: { amount: "9.50", currencyCode: "USD" }, options: {} },
      ],
    },
    {
      id: "103",
      title: "Tee",
      variants: [
        { id: "2001", title: "S / Red", sku: null, barcode: null, price: { amount: "29.99", currencyCode: "USD" }, options: { Size: "S", Color: "Red" } },
        { id: "2002", title: "M / Red", sku: null, barcode: null, price: { amount: "29.99", currencyCode: "USD" }, options: { Size: "M", Color: "Red" } },
        { id: "2003", title: "L / Red", sku: null, barcode: null, price: { amount: "29.99", currencyCode: "USD" }, options: { Size: "L", Color: "Red" } },
        { id: "2004", title: "S / Blue", sku: null, barcode: null, price: { amount: "29.99", currencyCode: "USD" }, options: { Size: "S", Color: "Blue" } },
        { id: "2005", title: "M / Blue", sku: null, barcode: null, price: { amount: "29.99", currencyCode: "USD" }, options: { Size: "M", Color: "Blue" } },
        { id: "2006", title: "L / Blue", sku: null, barcode: null, price: { amount: "29.99", currencyCode: "USD" }, options: { Size: "L", Color: "Blue" } },
      ],
    },
    {
      id: "104",
      title: "Mystery Box",
      variants: [
        { id: "1004", title: "Default", sku: "UNKNOWN-9", barcode: null, price: { amount: "1500", currencyCode: "JPY" }, options: {} },
      ],
    },
  ];
}

/** Resolve a test link by its Shopify side (findExternal resolves the reverse direction). */
async function findLinkByExternalId(
  orgId: string,
  objectType: string,
  externalId: string,
): Promise<{ nativeTable: string; nativeId: string } | null> {
  const row = (
    await withOrgContext(orgId, () =>
      db.execute<{ native_table: string; native_id: string }>(sql`
        select native_table, native_id from external_links
         where org_id = ${orgId} and provider = 'shopify'
           and external_account = 'test.myshopify.com'
           and object_type = ${objectType} and external_id = ${externalId}`),
    )
  ).rows[0];
  return row ? { nativeTable: row.native_table, nativeId: row.native_id } : null;
}

async function setupShop(org: ScratchOrg): Promise<{ actorId: string; channelId: string }> {
  ensureShopifyAdapterRegistered();
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features,salesChannels}', 'true'::jsonb)
     where id = ${org.orgId}`);
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features,orders}', 'true'::jsonb)
     where id = ${org.orgId}`);
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features,inventory}', 'true'::jsonb)
     where id = ${org.orgId}`);
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features,itemVariants}', 'true'::jsonb)
     where id = ${org.orgId}`);
  const actorId = await withBypass(() => createScratchUser(org.orgId, "shopify tester", "shopify_tester"));
  await withOrgContext(org.orgId, () =>
    db.execute(sql`
      insert into items (org_id, kind, code, name, is_active, created_by, updated_by)
      values (${org.orgId}, 'inventory', 'WIDGET-1', 'Widget One', true, ${actorId}, ${actorId})`),
  );
  const gadget = (
    await withOrgContext(org.orgId, () =>
      db.execute<{ id: string }>(sql`
        insert into items (org_id, kind, code, name, is_active, created_by, updated_by)
        values (${org.orgId}, 'inventory', 'GADGET-2', 'Gadget Two', true, ${actorId}, ${actorId})
        returning id`),
    )
  ).rows[0]!.id;
  await withOrgContext(org.orgId, () =>
    db.execute(sql`
      insert into item_identifiers (org_id, item_id, kind, value, created_by, updated_by)
      values (${org.orgId}, ${gadget}, 'upc', '012345678905', ${actorId}, ${actorId})`),
  );
  const { channel } = await createChannel(org.orgId, actorId, {
    kind: "shopify",
    name: "test.myshopify.com",
    currency: "USD",
    externalAccount: "test.myshopify.com",
    secrets: { accessToken: "shpat_test", mode: "token" },
    webhookSecret: "whsec_test",
    settings: {},
  });
  return { actorId, channelId: channel.id };
}

test(
  "catalog import matches by SKU and barcode and queues the rest",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const { actorId, channelId } = await setupShop(org);
      const catalog = baseCatalog();
      const result = await importShopifyCatalog(org.orgId, actorId, channelId, {
        mode: "paginated",
        transport: fakeTransport(() => catalog),
      });
      assert.deepEqual(
        { products: result.products, variants: result.variants, sku: result.matchedBySku, barcode: result.matchedByBarcode, queued: result.queued },
        { products: 4, variants: 9, sku: 1, barcode: 1, queued: 7 },
      );
      // Lowercase shop SKU matched the uppercase item code.
      const widgetLink = await findLinkByExternalId(org.orgId, "variant", "1001");
      assert.ok(widgetLink, "SKU-matched variant links to the item");
      // A zero-decimal currency converts without scaling.
      const queue = await listCatalogQueue(org.orgId, channelId, { status: "queued" });
      const mystery = queue.rows.find((row) => row.externalId === "1004");
      assert.equal(mystery?.priceMinor, "1500");
      assert.equal(mystery?.currency, "JPY");
      const counts = await catalogQueueCounts(org.orgId, channelId);
      assert.deepEqual(counts, { queued: 9, matched: 4, ignored: 0 });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "create family, idempotent re-import and SKU-change proposal",
  { skip: !DB },
  async () => {
    const org = await withBypass(() => createScratchOrg());
    try {
      const { actorId, channelId } = await setupShop(org);
      let catalog = baseCatalog();
      const transport = fakeTransport(() => catalog);
      await importShopifyCatalog(org.orgId, actorId, channelId, { mode: "paginated", transport });
      // Create a family from the 3x2 product.
      const products = await listCatalogQueue(org.orgId, channelId, { search: "Tee" });
      const tee = products.rows.find((row) => row.objectType === "product");
      assert.ok(tee, "product entry queues");
      await decideCatalogMatch(org.orgId, actorId, channelId, tee.id, { kind: "create_family" });
      const afterFamily = await catalogQueueCounts(org.orgId, channelId);
      assert.deepEqual(afterFamily, { queued: 2, matched: 11, ignored: 0 });
      const teeVariant = await findLinkByExternalId(org.orgId, "variant", "2001");
      assert.equal(teeVariant?.nativeTable, "items");
      const teeProduct = await findLinkByExternalId(org.orgId, "product", "103");
      assert.equal(teeProduct?.nativeTable, "item_families");
      // Re-import changes nothing: no duplicate rows, no relinking.
      const before = await listCatalogQueue(org.orgId, channelId, { limit: 500 });
      const repeat = await importShopifyCatalog(org.orgId, actorId, channelId, { mode: "paginated", transport });
      assert.equal(repeat.conflicts, 0);
      const after = await listCatalogQueue(org.orgId, channelId, { limit: 500 });
      assert.equal(after.total, before.total);
      // A changed shop SKU raises a proposal beside the standing link.
      catalog = catalog.map((product) =>
        product.id === "101"
          ? { ...product, variants: product.variants.map((v) => ({ ...v, sku: "WIDGET-1X" })) }
          : product,
      );
      const changed = await importShopifyCatalog(org.orgId, actorId, channelId, { mode: "paginated", transport });
      assert.equal(changed.conflicts, 1);
      const queued = await listCatalogQueue(org.orgId, channelId, { search: "WIDGET-1X" });
      const moved = queued.rows.find((row) => row.externalId === "1001");
      assert.equal((moved?.proposal as { kind?: string } | null)?.kind, "sku_changed");
      assert.equal(moved?.status, "matched");
      // The mystery variant becomes an item, then is ignored after unmatch.
      const mystery = (await listCatalogQueue(org.orgId, channelId, { search: "Mystery" })).rows.find(
        (row) => row.objectType === "variant",
      );
      assert.ok(mystery);
      await decideCatalogMatch(org.orgId, actorId, channelId, mystery.id, { kind: "create_item" });
      const created = await findLinkByExternalId(org.orgId, "variant", "1004");
      assert.ok(created, "created item links");
      const bulk = await bulkDecideCatalogMatches(org.orgId, actorId, channelId, [mystery.id], {
        kind: "unmatch",
        reason: "wrong item created in test",
      });
      assert.equal(bulk.decided, 1);
      await decideCatalogMatch(org.orgId, actorId, channelId, mystery.id, { kind: "ignore", reason: "not stocked" });
      const final = await catalogQueueCounts(org.orgId, channelId);
      assert.deepEqual(final, { queued: 0, matched: 12, ignored: 1 });
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
