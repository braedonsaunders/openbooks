import { sql } from "drizzle-orm";
import { SUPPORTED_CURRENCIES } from "../../fx/currencies.ts";
import {
  bulkEditVariants,
  createItemFamily,
  generateFamilyVariants,
  getItemFamily,
} from "../../inventory/item-families.ts";
import { ShopifyClient, type ShopifyGraphqlEnvelope } from "../../connectors/shopify.ts";
import type {
  ChannelProduct,
  ChannelVariant,
} from "../contracts.ts";
import { matchCatalogVariant } from "../catalog-matching.ts";
import { loadShopifyChannel, type ShopifyChannelAccess } from "./channel-access.ts";
import { CommerceError } from "../errors.ts";
import { findExternal, linkExternal, unlinkExternal } from "../external-links.ts";
import { shopifyDecimalToMinor, shopifyDecimalToRate } from "./money.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
  orgFeatureEnabled,
} from "../../organization/org-feature-lock.ts";
import { db, withOrg, withOrgContext } from "../../platform/db.ts";

/**
 * Shopify catalog import and matching. Storefront products and variants
 * flow through the channel-neutral types into the match queue
 * (`shopify_catalog_entries`): SKU then barcode auto-match, everything
 * else waits for the operator. Match decisions are `external_links` rows;
 * this table is only the queue, rebuilt idempotently on every import.
 */

const FEATURE_REMEDY = "Enable Sales Channels in Company Settings → Features.";

function refuse(code: string, message: string, remedy: string, field: string | null = null, status: 422 | 409 = 422): never {
  throw new CommerceError(code, message, remedy, { field, status });
}

async function requireFeature(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, "salesChannels"))) {
    refuse("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
  }
}

/** Shopify gids (`gid://shopify/Product/123`) and REST ids (123) share one numeric identity. */
export function shopifyNumericId(id: unknown): string {
  const text = typeof id === "number" ? String(id) : typeof id === "string" ? id.trim() : "";
  const numeric = text.includes("/") ? text.slice(text.lastIndexOf("/") + 1) : text;
  if (!/^\d+$/.test(numeric)) {
    refuse(
      "shopify_id_unreadable",
      `Shopify sent an object id of "${text.slice(0, 80)}" that is neither a numeric id nor a gid.`,
      "Re-import the catalog; if this repeats, the storefront sent an object OpenBooks cannot identify.",
      "externalId",
    );
  }
  return numeric;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return trimmed.slice(0, max);
}

interface ShopifyMoney {
  amount?: unknown;
  currencyCode?: unknown;
}

function variantPriceMinor(variant: { price?: unknown }, shopCurrency: string): { minor: bigint | null; currency: string } {
  const money = (variant.price ?? null) as ShopifyMoney | string | null;
  if (money === null || money === undefined) return { minor: null, currency: shopCurrency };
  if (typeof money === "string") {
    return { minor: shopifyDecimalToMinor(money, shopCurrency), currency: shopCurrency };
  }
  const currency = typeof money.currencyCode === "string" && money.currencyCode.trim() !== "" ? money.currencyCode : shopCurrency;
  return { minor: shopifyDecimalToMinor(money.amount, currency), currency };
}

/** Normalize one GraphQL product node (import path) to the neutral types. */
export function normalizeGraphqlProduct(node: Record<string, unknown>, shopCurrency: string): { product: ChannelProduct; variants: ChannelVariant[] } {
  const externalId = shopifyNumericId(node.id);
  const title = cleanText(node.title, 500) ?? `Shopify product ${externalId}`;
  const product: ChannelProduct = {
    externalId,
    externalParentId: null,
    title,
    description: cleanText(node.descriptionHtml, 5000),
    vendor: cleanText(node.vendor, 200),
    productType: cleanText(node.productType, 200),
    status: typeof node.status === "string" ? node.status : "ACTIVE",
    updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : null,
  };
  const optionNames: string[] = Array.isArray(node.options)
    ? (node.options as Record<string, unknown>[]).map((option, index) =>
        cleanText(option.name, 100) ?? `Option ${index + 1}`,
      )
    : [];
  const variantsConnection = node.variants as { edges?: { node: Record<string, unknown> }[] } | undefined;
  const variants = (variantsConnection?.edges ?? []).map(({ node: v }) =>
    normalizeGraphqlVariant(v, externalId, optionNames, shopCurrency),
  );
  return { product, variants };
}

function normalizeGraphqlVariant(
  v: Record<string, unknown>,
  productExternalId: string,
  optionNames: string[],
  shopCurrency: string,
): ChannelVariant {
  const externalId = shopifyNumericId(v.id);
  const selected = Array.isArray(v.selectedOptions)
    ? (v.selectedOptions as { name?: unknown; value?: unknown }[])
    : [];
  const optionValues: Record<string, string> = {};
  for (const entry of selected) {
    const name = cleanText(entry.name, 100);
    const value = cleanText(entry.value, 100);
    if (name && value) optionValues[name] = value;
  }
  // Fall back to positional options when selectedOptions is absent.
  const rawOptions = [v.option1, v.option2, v.option3];
  optionNames.forEach((name, index) => {
    if (!(name in optionValues)) {
      const value = cleanText(rawOptions[index], 100);
      if (value) optionValues[name] = value;
    }
  });
  const price = variantPriceMinor({ price: v.price }, shopCurrency);
  const compareAt = v.compareAtPrice == null ? null : variantPriceMinor({ price: v.compareAtPrice }, price.currency).minor;
  const inventoryItem = v.inventoryItem as { tracked?: unknown } | null | undefined;
  return {
    externalId,
    productExternalId,
    sku: cleanText(v.sku, 200),
    barcode: cleanText(v.barcode, 200),
    title: cleanText(v.title, 500) ?? "Default",
    optionValues,
    priceMinor: price.minor ?? 0n,
    compareAtPriceMinor: compareAt,
    taxable: v.taxable !== false,
    inventoryTracked: typeof inventoryItem?.tracked === "boolean" ? inventoryItem.tracked : true,
    updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null,
  };
}

/**
 * Normalize one webhook payload (REST product JSON) to the neutral types.
 * A malformed delivery refuses by name so the event fails visibly instead
 * of queueing a half-read product.
 */
export function normalizeWebhookProduct(payload: unknown, shopCurrency: string): { product: ChannelProduct; variants: ChannelVariant[] } {
  if (typeof payload !== "object" || payload === null) {
    refuse(
      "shopify_product_unreadable",
      "The Shopify product delivery holds no product object.",
      "Ask Shopify to resend the webhook from Settings → Notifications, or re-import the catalog.",
      "topic",
    );
  }
  const body = payload as Record<string, unknown>;
  const externalId = shopifyNumericId(body.id);
  const title = cleanText(body.title, 500) ?? `Shopify product ${externalId}`;
  const product: ChannelProduct = {
    externalId,
    externalParentId: null,
    title,
    description: null,
    vendor: cleanText(body.vendor, 200),
    productType: cleanText(body.product_type, 200),
    status: typeof body.status === "string" ? body.status : "active",
    updatedAt: typeof body.updated_at === "string" ? body.updated_at : null,
  };
  const options = Array.isArray(body.options) ? (body.options as { name?: unknown }[]) : [];
  const optionNames = options.map((option, index) => cleanText(option.name, 100) ?? `Option ${index + 1}`);
  const rawVariants = Array.isArray(body.variants) ? (body.variants as Record<string, unknown>[]) : [];
  const variants = rawVariants.map((v) => {
    const variantExternalId = shopifyNumericId(v.id);
    const optionValues: Record<string, string> = {};
    [v.option1, v.option2, v.option3].forEach((raw, index) => {
      const value = cleanText(raw, 100);
      if (value) optionValues[optionNames[index] ?? `Option ${index + 1}`] = value;
    });
    const price = variantPriceMinor({ price: v.price }, shopCurrency);
    return {
      externalId: variantExternalId,
      productExternalId: externalId,
      sku: cleanText(v.sku, 200),
      barcode: cleanText(v.barcode, 200),
      title: cleanText(v.title, 500) ?? "Default",
      optionValues,
      priceMinor: price.minor ?? 0n,
      compareAtPriceMinor: null,
      taxable: v.taxable !== false,
      inventoryTracked: v.inventory_management != null,
      updatedAt: typeof v.updated_at === "string" ? v.updated_at : null,
    } satisfies ChannelVariant;
  });
  return { product, variants };
}

type ProductsPage = {
  products: {
    edges: { node: Record<string, unknown> }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

const PRODUCTS_QUERY = `query shopifyCatalogImport($after: String) {
  products(first: 100, after: $after) {
    edges {
      node {
        id title vendor productType status updatedAt
        options(first: 10) { name values }
        variants(first: 100) {
          edges {
            node {
              id title sku barcode taxable updatedAt
              price { amount currencyCode }
              compareAtPrice { amount currencyCode }
              inventoryItem { tracked }
              selectedOptions { name value }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const BULK_PRODUCTS_QUERY = `{
  products {
    edges {
      node {
        __typename id title vendor productType status updatedAt
        options { name values }
        variants {
          edges {
            node {
              __typename id title sku barcode taxable updatedAt
              price { amount currencyCode }
              selectedOptions { name value }
            }
          }
        }
      }
    }
  }
}`;

interface QueueEntryRow extends Record<string, unknown> {
  id: string;
  object_type: string;
  external_id: string;
  external_parent_id: string | null;
  title: string;
  sku: string | null;
  barcode: string | null;
  price_minor: string | null;
  currency: string;
  option_values: Record<string, string>;
  shopify_updated_at: string | null;
  status: string;
  native_table: string | null;
  native_id: string | null;
  ignore_reason: string | null;
  proposal: Record<string, unknown> | null;
  last_synced_at: string | null;
}

export interface CatalogImportResult {
  products: number;
  variants: number;
  matchedBySku: number;
  matchedByBarcode: number;
  queued: number;
  conflicts: number;
  /** The import stopped early on the rate-limit budget; re-import resumes it. */
  budgetStopped: boolean;
  spentCost: number;
}

export async function importShopifyCatalog(
  orgId: string,
  actorId: string | null,
  channelId: string,
  options: { mode?: "auto" | "paginated" | "bulk"; transport?: typeof fetch } = {},
): Promise<CatalogImportResult> {
  // No transaction spans the import: pages stream from Shopify between
  // short per-product write units, so a large catalog never holds a
  // connection or a transaction open across network calls. Each unit
  // rechecks the feature gate under its own lock.
  if (!(await orgFeatureEnabled(orgId, "salesChannels"))) {
    refuse("feature_off", "Sales Channels is turned off for this organization.", FEATURE_REMEDY);
  }
  const channel = await loadShopifyChannel(orgId, channelId);
  const client = new ShopifyClient({
    shopDomain: channel.shop,
    accessToken: channel.accessToken,
    transport: options.transport,
  });
  const mode = options.mode ?? "auto";
  if (mode === "bulk") return importViaBulk(orgId, actorId, channel, client);
  if (mode === "paginated") {
    return importViaPagination(orgId, actorId, channel, client);
  }
  const count = await productCount(client);
  if (count !== null && count > 1000) return importViaBulk(orgId, actorId, channel, client);
  return importViaPagination(orgId, actorId, channel, client);
}

async function productCount(client: ShopifyClient): Promise<number | null> {
  try {
    const { data } = await client.graphql<{ productsCount?: { count?: unknown } }>(
      `{ productsCount { count } }`,
    );
    return typeof data.productsCount?.count === "number" ? data.productsCount.count : null;
  } catch {
    return null;
  }
}

async function importViaPagination(
  orgId: string,
  actorId: string | null,
  channel: ShopifyChannelAccess,
  client: ShopifyClient,
): Promise<CatalogImportResult> {
  const result: CatalogImportResult = {
    products: 0, variants: 0, matchedBySku: 0, matchedByBarcode: 0, queued: 0, conflicts: 0,
    budgetStopped: false, spentCost: 0,
  };
  const budget = channel.settings.rateLimitBudget;
  let after: string | null = null;
  for (;;) {
    const page: ShopifyGraphqlEnvelope<ProductsPage> = await client.graphql<ProductsPage>(PRODUCTS_QUERY, { after });
    const { data, cost } = page;
    result.spentCost += cost?.actual ?? 0;
    if (result.spentCost > budget) {
      // The run stops on the operator's rate-limit budget; re-import
      // resumes from the queued remainder instead of starting over.
      result.budgetStopped = true;
      break;
    }
    for (const { node } of data.products.edges) {
      const { product, variants } = normalizeGraphqlProduct(node, channel.currency);
      const outcome = await upsertCatalogProduct(orgId, actorId, channel, product, variants);
      result.products += 1;
      result.variants += outcome.variants;
      result.matchedBySku += outcome.matchedBySku;
      result.matchedByBarcode += outcome.matchedByBarcode;
      result.queued += outcome.queued;
      result.conflicts += outcome.conflicts;
    }
    if (!data.products.pageInfo.hasNextPage || !data.products.pageInfo.endCursor) break;
    after = data.products.pageInfo.endCursor;
  }
  await touchChannelSync(orgId, actorId, channel.channelId);
  return result;
}

async function importViaBulk(
  orgId: string,
  actorId: string | null,
  channel: ShopifyChannelAccess,
  client: ShopifyClient,
): Promise<CatalogImportResult> {
  const result: CatalogImportResult = {
    products: 0, variants: 0, matchedBySku: 0, matchedByBarcode: 0, queued: 0, conflicts: 0,
    budgetStopped: false, spentCost: 0,
  };
  await client.bulkQuery(BULK_PRODUCTS_QUERY, async (line) => {
    if (line.__typename !== "Product") return;
    const { product, variants } = normalizeGraphqlProduct(line, channel.currency);
    const outcome = await upsertCatalogProduct(orgId, actorId, channel, product, variants);
    result.products += 1;
    result.variants += outcome.variants;
    result.matchedBySku += outcome.matchedBySku;
    result.matchedByBarcode += outcome.matchedByBarcode;
    result.queued += outcome.queued;
    result.conflicts += outcome.conflicts;
  });
  await touchChannelSync(orgId, actorId, channel.channelId);
  return result;
}

async function touchChannelSync(orgId: string, actorId: string | null, channelId: string): Promise<void> {
  await withOrg(orgId, async () => {
    const updated = await db.execute(sql`
      update sales_channels
         set last_sync_at = now(), updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${channelId}`);
    if (updated.rowCount !== 1) {
      throw new Error("Channel sync stamp matched no row; the channel left while it imported");
    }
  });
}

interface UpsertOutcome {
  variants: number;
  matchedBySku: number;
  matchedByBarcode: number;
  queued: number;
  conflicts: number;
}

/**
 * Store one product with its variants and auto-match every still-queued
 * variant. Matched rows keep their operator or auto decision — re-import
 * never relinks them — except a changed SKU, which raises a re-match
 * proposal beside the standing link.
 */
export async function upsertCatalogProduct(
  orgId: string,
  actorId: string | null,
  channel: ShopifyChannelAccess,
  product: ChannelProduct,
  variants: ChannelVariant[],
): Promise<UpsertOutcome> {
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await requireFeature(orgId);
    return upsertCatalogProductUnit(orgId, actorId, channel, product, variants);
  });
}

async function upsertCatalogProductUnit(
  orgId: string,
  actorId: string | null,
  channel: ShopifyChannelAccess,
  product: ChannelProduct,
  variants: ChannelVariant[],
): Promise<UpsertOutcome> {
  const outcome: UpsertOutcome = { variants: 0, matchedBySku: 0, matchedByBarcode: 0, queued: 0, conflicts: 0 };
  await upsertEntry(orgId, actorId, channel, {
    objectType: "product",
    externalId: product.externalId,
    externalParentId: null,
    title: product.title,
    sku: null,
    barcode: null,
    priceMinor: null,
    currency: channel.currency,
    optionValues: {},
    shopifyUpdatedAt: product.updatedAt,
  });
  for (const variant of variants) {
    outcome.variants += 1;
    const row = await upsertEntry(orgId, actorId, channel, {
      objectType: "variant",
      externalId: variant.externalId,
      externalParentId: product.externalId,
      title: variant.title,
      sku: variant.sku,
      barcode: variant.barcode,
      priceMinor: variant.priceMinor,
      currency: channel.currency,
      optionValues: variant.optionValues,
      shopifyUpdatedAt: variant.updatedAt,
    });
    if (row.status === "matched" && row.native_table === "items" && row.native_id) {
      const item = (
        await db.execute<{ code: string | null }>(sql`
          select code from items where org_id = ${orgId} and id = ${row.native_id}`)
      ).rows[0];
      const linkedCode = item?.code?.trim().toLowerCase() ?? null;
      const currentSku = (variant.sku ?? "").trim().toLowerCase() || null;
      if (item && linkedCode !== currentSku) {
        await setProposal(orgId, actorId, row.id, {
          kind: "sku_changed",
          shopifySku: variant.sku,
          itemCode: item.code,
          remedy: "Confirm the new SKU still means this item under Products → Match, or unmatch and match again.",
        });
        outcome.conflicts += 1;
      }
      continue;
    }
    if (row.status !== "queued") continue;
    let match;
    try {
      match = await matchCatalogVariant(orgId, { sku: variant.sku, barcode: variant.barcode });
    } catch (error) {
      if (error instanceof CommerceError) {
        await setProposal(orgId, actorId, row.id, {
          kind: "match_refused",
          code: error.code,
          message: error.message,
          remedy: error.remedy,
        });
        outcome.conflicts += 1;
        outcome.queued += 1;
        continue;
      }
      throw error;
    }
    if (match.kind === "queued") {
      outcome.queued += 1;
      continue;
    }
    try {
      await linkExternal(
        orgId,
        actorId,
        {
          channelId: channel.channelId,
          provider: "shopify",
          externalAccount: channel.shop,
          objectType: "variant",
          externalId: variant.externalId,
          externalParentId: product.externalId,
          nativeTable: "items",
          nativeId: match.itemId,
        },
        "salesChannels",
      );
    } catch (error) {
      if (error instanceof CommerceError) {
        await setProposal(orgId, actorId, row.id, {
          kind: "link_conflict",
          code: error.code,
          message: error.message,
          remedy: error.remedy,
        });
        outcome.conflicts += 1;
        outcome.queued += 1;
        continue;
      }
      throw error;
    }
    await markMatched(orgId, actorId, row.id, "items", match.itemId);
    if (match.via === "sku") outcome.matchedBySku += 1;
    else outcome.matchedByBarcode += 1;
    // A single-variant product resolves at both levels, so the product
    // identity answers everywhere the variant one does.
    if (variants.length === 1) {
      try {
        await linkExternal(
          orgId,
          actorId,
          {
            channelId: channel.channelId,
            provider: "shopify",
            externalAccount: channel.shop,
            objectType: "product",
            externalId: product.externalId,
            nativeTable: "items",
            nativeId: match.itemId,
          },
          "salesChannels",
        );
        await markProductMatched(orgId, actorId, channel.channelId, product.externalId, "items", match.itemId);
      } catch (error) {
        if (!(error instanceof CommerceError)) throw error;
        outcome.conflicts += 1;
      }
    }
  }
  return outcome;
}

interface EntryInput {
  objectType: "product" | "variant";
  externalId: string;
  externalParentId: string | null;
  title: string;
  sku: string | null;
  barcode: string | null;
  priceMinor: bigint | null;
  currency: string;
  optionValues: Record<string, string>;
  shopifyUpdatedAt: string | null;
}

async function upsertEntry(
  orgId: string,
  actorId: string | null,
  channel: ShopifyChannelAccess,
  input: EntryInput,
): Promise<QueueEntryRow> {
  // A re-import racing the first store is an expected unique-key collision;
  // re-read below to return the winner instead of dropping the write.
  const inserted = await db.execute<{ id: string }>(sql`
    insert into shopify_catalog_entries
      (org_id, channel_id, object_type, external_id, external_parent_id, title,
       sku, barcode, price_minor, currency, option_values, shopify_updated_at,
       last_synced_at, created_by, updated_by)
    values (${orgId}, ${channel.channelId}, ${input.objectType}, ${input.externalId},
      ${input.externalParentId}, ${input.title}, ${input.sku}, ${input.barcode},
      ${input.priceMinor}, ${input.currency}, ${JSON.stringify(input.optionValues)}::jsonb,
      ${input.shopifyUpdatedAt}, now(), ${actorId}, ${actorId})
    on conflict (org_id, channel_id, external_id) do nothing
    returning id`);
  const id =
    inserted.rows[0]?.id ??
    (
      await db.execute<{ id: string }>(sql`
        select id from shopify_catalog_entries
         where org_id = ${orgId} and channel_id = ${channel.channelId} and external_id = ${input.externalId}`)
    ).rows[0]?.id;
  if (!id) throw new Error("Catalog queue store returned no row; the product was lost");
  // Refresh the storefront snapshot; the match decision stands until the
  // operator changes it — re-import never relinks on its own.
  const updated = await db.execute<QueueEntryRow>(sql`
    update shopify_catalog_entries
       set title = ${input.title}, sku = ${input.sku}, barcode = ${input.barcode},
           price_minor = ${input.priceMinor}, currency = ${input.currency},
           option_values = ${JSON.stringify(input.optionValues)}::jsonb,
           shopify_updated_at = ${input.shopifyUpdatedAt}, last_synced_at = now(),
           external_parent_id = coalesce(${input.externalParentId}, external_parent_id),
           updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and id = ${id}
     returning id, object_type, external_id, external_parent_id, title, sku, barcode,
       price_minor, currency, option_values, shopify_updated_at::text, status,
       native_table, native_id, ignore_reason, proposal, last_synced_at::text`);
  if (updated.rows.length !== 1 || !updated.rows[0]) {
    throw new Error("Catalog queue refresh matched no row; the product left while it imported");
  }
  return updated.rows[0];
}

async function setProposal(orgId: string, actorId: string | null, entryId: string, proposal: Record<string, unknown>): Promise<void> {
  const updated = await db.execute(sql`
    update shopify_catalog_entries
       set proposal = ${JSON.stringify(proposal)}::jsonb, updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and id = ${entryId}`);
  if (updated.rowCount !== 1) {
    throw new Error("Catalog queue proposal matched no row; the entry left while it imported");
  }
}

async function markMatched(orgId: string, actorId: string | null, entryId: string, nativeTable: string, nativeId: string): Promise<void> {
  const updated = await db.execute(sql`
    update shopify_catalog_entries
       set status = 'matched', native_table = ${nativeTable}, native_id = ${nativeId},
           proposal = null, ignore_reason = null, updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and id = ${entryId}`);
  if (updated.rowCount !== 1) {
    throw new Error("Catalog queue match matched no row; the entry left while it imported");
  }
}

async function markProductMatched(
  orgId: string,
  actorId: string | null,
  channelId: string,
  productExternalId: string,
  nativeTable: string,
  nativeId: string,
): Promise<void> {
  const row = (
    await db.execute<{ id: string }>(sql`
      select id from shopify_catalog_entries
       where org_id = ${orgId} and channel_id = ${channelId}
         and object_type = 'product' and external_id = ${productExternalId}`)
  ).rows[0];
  if (row) await markMatched(orgId, actorId, row.id, nativeTable, nativeId);
}

export interface CatalogQueueFilters {
  status?: "queued" | "matched" | "ignored";
  search?: string;
  limit?: number;
  offset?: number;
}

export interface CatalogQueueRow {
  id: string;
  objectType: string;
  externalId: string;
  externalParentId: string | null;
  productTitle: string | null;
  title: string;
  sku: string | null;
  barcode: string | null;
  priceMinor: string | null;
  currency: string;
  optionValues: Record<string, string>;
  status: string;
  nativeTable: string | null;
  nativeId: string | null;
  nativeCode: string | null;
  nativeName: string | null;
  ignoreReason: string | null;
  proposal: Record<string, unknown> | null;
  shopifyUpdatedAt: string | null;
  lastSyncedAt: string | null;
}

interface QueueListRow extends Record<string, unknown> {
  id: string;
  object_type: string;
  external_id: string;
  external_parent_id: string | null;
  product_title: string | null;
  title: string;
  sku: string | null;
  barcode: string | null;
  price_minor: string | null;
  currency: string;
  option_values: Record<string, string>;
  status: string;
  native_table: string | null;
  native_id: string | null;
  native_code: string | null;
  native_name: string | null;
  ignore_reason: string | null;
  proposal: Record<string, unknown> | null;
  shopify_updated_at: string | null;
  last_synced_at: string | null;
}

/** The operator's Products queue: entries with their product and native item names resolved. */
export async function listCatalogQueue(
  orgId: string,
  channelId: string,
  filters: CatalogQueueFilters = {},
): Promise<{ rows: CatalogQueueRow[]; total: number }> {
  const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
  const offset = Math.max(filters.offset ?? 0, 0);
  const search = filters.search?.trim() ? `%${filters.search.trim()}%` : null;
  const where = sql`e.org_id = ${orgId} and e.channel_id = ${channelId}`;
  const statusClause = filters.status ? sql` and e.status = ${filters.status}` : sql``;
  const searchClause = search
    ? sql` and (e.title ilike ${search} or e.sku ilike ${search} or e.barcode ilike ${search} or p.title ilike ${search})`
    : sql``;
  const rows = (
    await withOrgContext(orgId, () =>
      db.execute<QueueListRow>(sql`
        select e.id, e.object_type, e.external_id, e.external_parent_id,
               p.title as product_title, e.title, e.sku, e.barcode,
               e.price_minor::text, e.currency, e.option_values, e.status,
               e.native_table, e.native_id, i.code as native_code, i.name as native_name,
               e.ignore_reason, e.proposal,
               e.shopify_updated_at::text, e.last_synced_at::text
          from shopify_catalog_entries e
          left join shopify_catalog_entries p
            on p.org_id = e.org_id and p.channel_id = e.channel_id
           and p.object_type = 'product' and p.external_id = e.external_parent_id
          left join items i
            on e.native_table = 'items' and i.org_id = e.org_id and i.id = e.native_id
         where ${where}${statusClause}${searchClause}
         order by e.status = 'queued' desc, e.title
         limit ${limit} offset ${offset}`),
    )
  ).rows;
  const total = (
    await withOrgContext(orgId, () =>
      db.execute<{ count: string }>(sql`
        select count(*)::text as count
          from shopify_catalog_entries e
          left join shopify_catalog_entries p
            on p.org_id = e.org_id and p.channel_id = e.channel_id
           and p.object_type = 'product' and p.external_id = e.external_parent_id
         where ${where}${statusClause}${searchClause}`),
    )
  ).rows[0];
  return {
    rows: rows.map((row) => ({
      id: row.id,
      objectType: row.object_type,
      externalId: row.external_id,
      externalParentId: row.external_parent_id,
      productTitle: row.product_title,
      title: row.title,
      sku: row.sku,
      barcode: row.barcode,
      priceMinor: row.price_minor,
      currency: row.currency,
      optionValues: row.option_values ?? {},
      status: row.status,
      nativeTable: row.native_table,
      nativeId: row.native_id,
      nativeCode: row.native_code,
      nativeName: row.native_name,
      ignoreReason: row.ignore_reason,
      proposal: row.proposal,
      shopifyUpdatedAt: row.shopify_updated_at,
      lastSyncedAt: row.last_synced_at,
    })),
    total: Number(total?.count ?? "0"),
  };
}

export interface CatalogQueueCounts {
  queued: number;
  matched: number;
  ignored: number;
}

export async function catalogQueueCounts(orgId: string, channelId: string): Promise<CatalogQueueCounts> {
  const rows = (
    await withOrgContext(orgId, () =>
      db.execute<{ status: string; count: string }>(sql`
        select status, count(*)::text as count from shopify_catalog_entries
         where org_id = ${orgId} and channel_id = ${channelId}
         group by status`),
    )
  ).rows;
  const counts: CatalogQueueCounts = { queued: 0, matched: 0, ignored: 0 };
  for (const row of rows) {
    if (row.status === "queued" || row.status === "matched" || row.status === "ignored") {
      counts[row.status] = Number(row.count);
    }
  }
  return counts;
}

export type CatalogDecision =
  | { kind: "match"; nativeTable: "items" | "item_families"; nativeId: string }
  | { kind: "create_item"; itemKind?: string; code?: string; name?: string }
  | { kind: "create_family"; familyKind?: string; code?: string }
  | { kind: "ignore"; reason: string }
  | { kind: "unmatch"; reason: string };

async function loadQueueEntry(orgId: string, channelId: string, entryId: string): Promise<QueueEntryRow> {
  const row = (
    await db.execute<QueueEntryRow>(sql`
      select id, object_type, external_id, external_parent_id, title, sku, barcode,
        price_minor, currency, option_values, shopify_updated_at::text, status,
        native_table, native_id, ignore_reason, proposal, last_synced_at::text
        from shopify_catalog_entries
       where org_id = ${orgId} and channel_id = ${channelId} and id = ${entryId}`)
  ).rows[0];
  if (!row) {
    refuse(
      "catalog_entry_not_found",
      "The catalog entry does not belong to this channel.",
      "Refresh the Products queue and choose an entry from this channel.",
      "entryId",
    );
  }
  return row;
}

function cleanDecisionText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    refuse(
      `catalog_${field}_missing`,
      `A ${field} is required for this catalog decision.`,
      `Enter the ${field} so the record says what the operator chose.`,
      field,
    );
  }
  return value.trim().slice(0, max);
}

/**
 * Apply the operator's decision on one queue entry. Every decision writes
 * its `external_links` row (or removes it, for unmatch) and moves the
 * entry; a decision on a stale entry refuses instead of overwriting the
 * newer one.
 */
export async function decideCatalogMatch(
  orgId: string,
  actorId: string,
  channelId: string,
  entryId: string,
  decision: CatalogDecision,
): Promise<{ entryId: string; status: string }> {
  return withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await requireFeature(orgId);
    const channel = await loadShopifyChannel(orgId, channelId);
    const entry = await loadQueueEntry(orgId, channelId, entryId);
    switch (decision.kind) {
      case "match":
        return decideMatch(orgId, actorId, channel, entry, decision.nativeTable, decision.nativeId);
      case "create_item":
        return decideCreateItem(orgId, actorId, channel, entry, decision);
      case "create_family":
        return decideCreateFamily(orgId, actorId, channel, entry, decision);
      case "ignore":
        return decideIgnore(orgId, actorId, entry, decision.reason);
      case "unmatch":
        return decideUnmatch(orgId, actorId, channel, entry, decision.reason);
    }
  });
}

async function decideMatch(
  orgId: string,
  actorId: string,
  channel: ShopifyChannelAccess,
  entry: QueueEntryRow,
  nativeTable: "items" | "item_families",
  nativeId: string,
): Promise<{ entryId: string; status: string }> {
  if (entry.status === "matched") {
    refuse(
      "catalog_already_matched",
      `Shopify ${entry.object_type} "${entry.title}" is already matched; unmatch it first to move it.`,
      "Unmatch the entry with a reason, then match it to the correct record.",
      "entryId",
      409,
    );
  }
  const targetTable = entry.object_type === "product" && nativeTable === "items" ? "items" : nativeTable;
  if (entry.object_type === "variant" && targetTable !== "items") {
    refuse(
      "catalog_variant_target_invalid",
      "A Shopify variant maps to an item, never to a family.",
      "Match the variant to one of the family's variant items, or create the family first.",
      "nativeId",
    );
  }
  const target = (
    await db.execute<{ id: string }>(sql`
      select id from ${sql.raw(`"${targetTable}"`)} where org_id = ${orgId} and id = ${nativeId}`)
  ).rows[0];
  if (!target) {
    refuse(
      "catalog_target_missing",
      `The ${targetTable} record does not belong to this organization.`,
      "Choose an existing record in this organization for the link target.",
      "nativeId",
    );
  }
  await linkExternal(
    orgId,
    actorId,
    {
      channelId: channel.channelId,
      provider: "shopify",
      externalAccount: channel.shop,
      objectType: entry.object_type,
      externalId: entry.external_id,
      externalParentId: entry.external_parent_id,
      nativeTable: targetTable,
      nativeId,
    },
    "salesChannels",
  );
  await markMatched(orgId, actorId, entry.id, targetTable, nativeId);
  await linkSingleVariantProduct(orgId, actorId, channel, entry, targetTable, nativeId);
  return { entryId: entry.id, status: "matched" };
}

/**
 * A single-variant product resolves at both levels, so the product
 * identity answers everywhere the variant one does. Multi-variant
 * products resolve at the product level only through their family.
 */
async function linkSingleVariantProduct(
  orgId: string,
  actorId: string,
  channel: ShopifyChannelAccess,
  entry: QueueEntryRow,
  nativeTable: string,
  nativeId: string,
): Promise<void> {
  if (entry.object_type !== "variant" || !entry.external_parent_id) return;
  const siblings = (
    await db.execute<{ count: string }>(sql`
      select count(*)::text as count from shopify_catalog_entries
       where org_id = ${orgId} and channel_id = ${channel.channelId}
         and object_type = 'variant' and external_parent_id = ${entry.external_parent_id}`)
  ).rows[0];
  if (Number(siblings?.count ?? "0") !== 1) return;
  try {
    await linkExternal(
      orgId,
      actorId,
      {
        channelId: channel.channelId,
        provider: "shopify",
        externalAccount: channel.shop,
        objectType: "product",
        externalId: entry.external_parent_id,
        nativeTable,
        nativeId,
      },
      "salesChannels",
    );
    await markProductMatched(orgId, actorId, channel.channelId, entry.external_parent_id, nativeTable, nativeId);
  } catch (error) {
    if (!(error instanceof CommerceError)) throw error;
  }
}

const ITEM_KINDS = ["service", "non_inventory", "inventory", "assembly", "kit"] as const;

function checkItemKind(kind: unknown): string {
  const text = typeof kind === "string" ? kind.trim() : "";
  if (!(ITEM_KINDS as readonly string[]).includes(text)) {
    refuse(
      "catalog_item_kind_unknown",
      `Item kind "${text || "blank"}" is not a storable item kind.`,
      `Choose one of ${ITEM_KINDS.join(", ")}.`,
      "itemKind",
    );
  }
  return text;
}

/** Minor units back to a canonical rate string for rate columns. */
export function minorToRate(minor: bigint | null, currencyCode: string): string | null {
  if (minor === null) return null;
  const currency = SUPPORTED_CURRENCIES.find((entry) => entry.code === currencyCode.toUpperCase());
  const exponent = currency?.minorUnits ?? 2;
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent) || "0";
  const fraction = digits.slice(digits.length - exponent).padEnd(4, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function barcodeKind(barcode: string): "gtin" | "upc" | "ean" | "internal" {
  if (!/^\d+$/.test(barcode)) return "internal";
  if (barcode.length === 12) return "upc";
  if (barcode.length === 13) return "ean";
  if (barcode.length === 8 || barcode.length === 14) return "gtin";
  return "internal";
}

async function decideCreateItem(
  orgId: string,
  actorId: string,
  channel: ShopifyChannelAccess,
  entry: QueueEntryRow,
  decision: { itemKind?: string; code?: string; name?: string },
): Promise<{ entryId: string; status: string }> {
  if (entry.object_type !== "variant") {
    refuse(
      "catalog_create_item_product",
      `Shopify product "${entry.title}" has variants; create a family for it, not a single item.`,
      "Choose Create family so every variant becomes its own item.",
      "entryId",
    );
  }
  if (entry.status === "matched") {
    refuse(
      "catalog_already_matched",
      `Shopify variant "${entry.title}" is already matched; unmatch it first to recreate it.`,
      "Unmatch the entry with a reason, then create the item.",
      "entryId",
      409,
    );
  }
  const kind = checkItemKind(decision.itemKind ?? "inventory");
  const code = cleanDecisionText(decision.code ?? entry.sku ?? `SHOPIFY-${entry.external_id}`, "code", 120);
  const name = cleanDecisionText(
    decision.name ?? (entry.title === "Default" ? null : entry.title) ?? entry.title,
    "name",
    500,
  );
  const taken = (
    await db.execute<{ id: string }>(sql`
      select id from items where org_id = ${orgId} and lower(code) = lower(${code})`)
  ).rows[0];
  if (taken) {
    refuse(
      "catalog_item_code_taken",
      `Item code "${code}" already belongs to another item; the new item was not created.`,
      "Match the variant to that item instead, or choose a different code.",
      "code",
      409,
    );
  }
  const rate = minorToRate(entry.price_minor === null ? null : BigInt(entry.price_minor), entry.currency || channel.currency);
  const inserted = await db.execute<{ id: string }>(sql`
    insert into items (org_id, kind, code, name, default_rate, is_active, created_by, updated_by)
    values (${orgId}, ${kind}, ${code}, ${name}, ${rate}, true, ${actorId}, ${actorId})
    returning id`);
  if (inserted.rows.length !== 1 || !inserted.rows[0]) {
    throw new Error("Catalog item create returned no row; the item was lost");
  }
  const itemId = inserted.rows[0].id;
  const barcode = (entry.barcode ?? "").trim();
  if (barcode !== "") {
    const identifier = await db.execute(sql`
      insert into item_identifiers (org_id, item_id, kind, value, created_by, updated_by)
      values (${orgId}, ${itemId}, ${barcodeKind(barcode)}, ${barcode}, ${actorId}, ${actorId})
      on conflict (org_id, value) do nothing`);
    if ((identifier.rowCount ?? 0) !== 1) {
      await db.execute(sql`delete from items where org_id = ${orgId} and id = ${itemId}`);
      refuse(
        "catalog_barcode_taken",
        `Barcode "${barcode}" already identifies another item; the new item was not created.`,
        "Match the variant to the item carrying that barcode instead.",
        "nativeId",
        409,
      );
    }
  }
  await db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'items', ${itemId}, 'insert',
      ${JSON.stringify({ before: null, after: { code, name, kind }, reason: `Created from Shopify variant ${entry.external_id}` })}::jsonb, ${actorId})`);
  await linkExternal(
    orgId,
    actorId,
    {
      channelId: channel.channelId,
      provider: "shopify",
      externalAccount: channel.shop,
      objectType: "variant",
      externalId: entry.external_id,
      externalParentId: entry.external_parent_id,
      nativeTable: "items",
      nativeId: itemId,
    },
    "salesChannels",
  );
  await markMatched(orgId, actorId, entry.id, "items", itemId);
  await linkSingleVariantProduct(orgId, actorId, channel, entry, "items", itemId);
  return { entryId: entry.id, status: "matched" };
}

async function decideCreateFamily(
  orgId: string,
  actorId: string,
  channel: ShopifyChannelAccess,
  entry: QueueEntryRow,
  decision: { familyKind?: string; code?: string },
): Promise<{ entryId: string; status: string }> {
  if (entry.object_type !== "product") {
    refuse(
      "catalog_create_family_variant",
      `Shopify variant "${entry.title}" belongs to a product; create the family from its product.`,
      "Open the product row and choose Create family there.",
      "entryId",
    );
  }
  if (entry.status === "matched") {
    refuse(
      "catalog_already_matched",
      `Shopify product "${entry.title}" is already matched; unmatch it first to recreate it.`,
      "Unmatch the entry with a reason, then create the family.",
      "entryId",
      409,
    );
  }
  const kind = checkItemKind(decision.familyKind ?? "inventory");
  const code = cleanDecisionText(decision.code ?? `SHOPIFY-${entry.external_id}`, "code", 60);
  const siblings = (
    await db.execute<QueueEntryRow>(sql`
      select id, object_type, external_id, external_parent_id, title, sku, barcode,
        price_minor, currency, option_values, shopify_updated_at::text, status,
        native_table, native_id, ignore_reason, proposal, last_synced_at::text
        from shopify_catalog_entries
       where org_id = ${orgId} and channel_id = ${channel.channelId}
         and object_type = 'variant' and external_parent_id = ${entry.external_id}
         and status = 'queued'`)
  ).rows;
  if (siblings.length === 0) {
    refuse(
      "catalog_family_no_variants",
      `Shopify product "${entry.title}" has no queued variants to build a family from.`,
      "Re-import the catalog so the variants queue, or match the product directly.",
      "entryId",
    );
  }
  // Option order follows the first variant that names each option, so the
  // family reads the way the storefront lists it.
  const optionOrder: string[] = [];
  const optionValues = new Map<string, Set<string>>();
  for (const sibling of siblings) {
    const values = (sibling.option_values ?? {}) as Record<string, string>;
    for (const [name, value] of Object.entries(values)) {
      if (!optionValues.has(name)) {
        optionOrder.push(name);
        optionValues.set(name, new Set());
      }
      optionValues.get(name)!.add(value);
    }
  }
  if (optionOrder.length === 0) {
    refuse(
      "catalog_family_no_options",
      `Shopify product "${entry.title}" carries no variant options; a family needs at least one.`,
      "Create a single item from its variant instead.",
      "entryId",
    );
  }
  const options = optionOrder.map((name) => ({ name, values: [...optionValues.get(name)!] }));
  let familyId: string;
  try {
    const family = await createItemFamily(orgId, actorId, {
      code,
      name: entry.title,
      kind,
      options,
    });
    familyId = family.id;
  } catch (error) {
    // Resume a half-finished create: the family insert won but a later
    // step failed, so the retry continues from the standing family instead
    // of refusing on its own code.
    const familyError = error as { code?: string; message?: string };
    if (typeof familyError?.code === "string" && familyError.code !== "family_code_taken") throw error;
    if (!(error instanceof Error) || !/already in use/.test(error.message)) throw error;
    const standing = (
      await db.execute<{ id: string }>(sql`
        select id from item_families where org_id = ${orgId} and code = ${code}`)
    ).rows[0];
    if (!standing) throw error;
    familyId = standing.id;
  }
  const family = await getItemFamily(orgId, familyId);
  if (!family) throw new Error("Catalog family create lost its family; the product was not created");
  const combinations = siblings.map((sibling) => {
    const ordered: Record<string, string> = {};
    for (const option of family.options) ordered[option.name] = (sibling.option_values as Record<string, string>)[option.name] ?? "";
    return { sibling, combination: ordered };
  });
  const generated = await generateFamilyVariants(orgId, actorId, familyId, {
    only: combinations.map((entry) => entry.combination),
  });
  const byKey = new Map(
    generated.variants.map((variant) => [
      family.options.map((option) => variant.optionValues[option.name] ?? "").join(""),
      variant,
    ]),
  );
  for (const { sibling, combination } of combinations) {
    const key = family.options.map((option) => combination[option.name] ?? "").join("");
    const variant = byKey.get(key);
    if (!variant) {
      throw new Error(`Catalog family create lost variant ${sibling.external_id}; rerun the decision to resume`);
    }
    // The Shopify SKU becomes the item code when it is free, so a later
    // re-import still matches by SKU even without the link.
    const sku = (sibling.sku ?? "").trim();
    if (sku !== "") {
      const taken = (
        await db.execute<{ id: string }>(sql`
          select id from items where org_id = ${orgId} and lower(code) = lower(${sku}) and id <> ${variant.id}`)
      ).rows[0];
      if (!taken) {
        await db.execute(sql`
          update items set code = ${sku}, updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${variant.id}`);
      }
    }
    const rate = minorToRate(sibling.price_minor === null ? null : BigInt(sibling.price_minor), sibling.currency || channel.currency);
    const barcode = (sibling.barcode ?? "").trim();
    if (rate !== null || barcode !== "") {
      await bulkEditVariants(orgId, actorId, {
        variantIds: [variant.id],
        ...(rate !== null ? { price: shopifyDecimalToRate(canonicalRate(rate)) } : {}),
        ...(barcode !== "" ? { barcode: { value: barcode, kind: barcodeKind(barcode) } } : {}),
      });
    }
    await linkExternal(
      orgId,
      actorId,
      {
        channelId: channel.channelId,
        provider: "shopify",
        externalAccount: channel.shop,
        objectType: "variant",
        externalId: sibling.external_id,
        externalParentId: entry.external_id,
        nativeTable: "items",
        nativeId: variant.id,
      },
      "salesChannels",
    );
    await markMatched(orgId, actorId, sibling.id, "items", variant.id);
  }
  await linkExternal(
    orgId,
    actorId,
    {
      channelId: channel.channelId,
      provider: "shopify",
      externalAccount: channel.shop,
      objectType: "product",
      externalId: entry.external_id,
      nativeTable: "item_families",
      nativeId: familyId,
    },
    "salesChannels",
  );
  await markMatched(orgId, actorId, entry.id, "item_families", familyId);
  return { entryId: entry.id, status: "matched" };
}

/** Canonical rate ("19.9900") back to the exact-decimal shape the variant editor validates. */
function canonicalRate(rate: string): string {
  return rate.replace(/0+$/, "").replace(/\.$/, ".0");
}

async function decideIgnore(
  orgId: string,
  actorId: string,
  entry: QueueEntryRow,
  reason: unknown,
): Promise<{ entryId: string; status: string }> {
  const why = cleanDecisionText(reason, "reason", 500);
  if (entry.status === "matched") {
    refuse(
      "catalog_ignore_matched",
      `Shopify ${entry.object_type} "${entry.title}" is matched; unmatch it first instead of ignoring it.`,
      "Unmatch the entry with a reason so the link is removed with audit evidence.",
      "entryId",
      409,
    );
  }
  const updated = await db.execute(sql`
    update shopify_catalog_entries
       set status = 'ignored', ignore_reason = ${why}, proposal = null,
           updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and id = ${entry.id} and status <> 'matched'`);
  if (updated.rowCount !== 1) {
    throw new Error("Catalog ignore matched no row; the entry left while it was decided");
  }
  return { entryId: entry.id, status: "ignored" };
}

async function decideUnmatch(
  orgId: string,
  actorId: string,
  channel: ShopifyChannelAccess,
  entry: QueueEntryRow,
  reason: unknown,
): Promise<{ entryId: string; status: string }> {
  const why = cleanDecisionText(reason, "reason", 500);
  if (entry.status !== "matched" || !entry.native_id || !entry.native_table) {
    refuse(
      "catalog_unmatch_unmatched",
      `Shopify ${entry.object_type} "${entry.title}" carries no link to remove.`,
      "Match, create, or ignore the entry instead.",
      "entryId",
      409,
    );
  }
  await unlinkExternal(
    orgId,
    actorId,
    {
      provider: "shopify",
      externalAccount: channel.shop,
      objectType: entry.object_type,
      externalId: entry.external_id,
    },
    why,
    "salesChannels",
  );
  const updated = await db.execute(sql`
    update shopify_catalog_entries
       set status = 'queued', native_table = null, native_id = null,
           proposal = null, ignore_reason = null, updated_by = ${actorId}, updated_at = now()
     where org_id = ${orgId} and id = ${entry.id}`);
  if (updated.rowCount !== 1) {
    throw new Error("Catalog unmatch matched no row; the entry left while it was decided");
  }
  return { entryId: entry.id, status: "queued" };
}

export interface BulkDecisionResult {
  decided: number;
  failed: { entryId: string; code: string; message: string }[];
}

/**
 * Apply one decision across many entries, one row at a time. A failing row
 * reports its refusal and the rest still apply — the queue shows exactly
 * which rows need the operator.
 */
export async function bulkDecideCatalogMatches(
  orgId: string,
  actorId: string,
  channelId: string,
  entryIds: string[],
  decision: CatalogDecision,
): Promise<BulkDecisionResult> {
  const result: BulkDecisionResult = { decided: 0, failed: [] };
  for (const entryId of [...new Set(entryIds)].slice(0, 200)) {
    try {
      await decideCatalogMatch(orgId, actorId, channelId, entryId, decision);
      result.decided += 1;
    } catch (error) {
      if (error instanceof CommerceError) {
        result.failed.push({ entryId, code: error.code, message: error.message });
        continue;
      }
      throw error;
    }
  }
  return result;
}

/**
 * Entries the operator can decide together with this one: siblings from
 * the same product plus queued rows sharing its SKU. Powers "apply to all
 * similar" without the client guessing similarity.
 */
export async function similarCatalogEntries(orgId: string, channelId: string, entryId: string): Promise<string[]> {
  const entry = await withOrgContext(orgId, () => loadQueueEntry(orgId, channelId, entryId));
  const sku = (entry.sku ?? "").trim();
  const rows = (
    await withOrgContext(orgId, () =>
      db.execute<{ id: string }>(sql`
        select id from shopify_catalog_entries
         where org_id = ${orgId} and channel_id = ${channelId}
           and status = 'queued' and id <> ${entryId}
           and (${entry.external_parent_id ?? null} is not null
                and external_parent_id = ${entry.external_parent_id ?? null}
              ${sku !== "" ? sql`or (sku is not null and lower(sku) = lower(${sku}))` : sql``})`),
    )
  ).rows;
  return rows.map((row) => row.id);
}

/**
 * Push an item's price and title back to its Shopify variant. Off unless
 * the channel enables catalog push (Advanced, default off): the
 * storefront is read-only otherwise, and the push skips every field
 * already in sync so a no-op stays a no-op.
 */
export async function pushItemToShopify(
  orgId: string,
  actorId: string,
  channelId: string,
  itemId: string,
  options: { fields?: ("price" | "title")[]; transport?: typeof fetch } = {},
): Promise<{ pushed: ("price" | "title")[]; variantExternalId: string }> {
  // Read, network, then write: no transaction spans the Shopify calls.
  const prepared = await withOrg(orgId, async () => {
    await acquireOrgFeatureGateLock(db, orgId);
    await requireFeature(orgId);
    const channel = await loadShopifyChannel(orgId, channelId);
    if (!channel.settings.pushCatalog) {
      refuse(
        "shopify_push_disabled",
        `Channel "${channel.name}" does not push catalog changes to Shopify.`,
        "Enable catalog push under Channels → Settings → Advanced, then push again.",
        "pushCatalog",
      );
    }
    const link = await findExternal(orgId, {
      provider: "shopify",
      externalAccount: channel.shop,
      objectType: "variant",
      nativeTable: "items",
      nativeId: itemId,
    });
    if (!link) {
      refuse(
        "shopify_push_unlinked",
        "This item is not linked to a Shopify variant.",
        "Match or create the variant on the Products tab first, then push.",
        "itemId",
      );
    }
    const item = (
      await db.execute<{ code: string | null; name: string; default_rate: string | null }>(sql`
        select code, name, default_rate from items where org_id = ${orgId} and id = ${itemId}`)
    ).rows[0];
    if (!item) {
      refuse(
        "catalog_target_missing",
        "The item does not belong to this organization.",
        "Choose an existing item in this organization.",
        "itemId",
      );
    }
    return { channel, externalId: link.externalId, item };
  });
  {
    const { channel, externalId, item } = prepared;
    const client = new ShopifyClient({
      shopDomain: channel.shop,
      accessToken: channel.accessToken,
      transport: options.transport,
    });
    const variantGid = `gid://shopify/ProductVariant/${externalId}`;
    const current = await client.graphql<{
      productVariant: {
        price: { amount: string; currencyCode: string };
        title: string;
        product: { id: string; title: string };
      } | null;
    }>(
      `query shopifyVariantCurrent($id: ID!) {
         productVariant(id: $id) { price { amount currencyCode } title product { id title } }
       }`,
      { id: variantGid },
    );
    const remote = current.data.productVariant;
    if (!remote) {
      refuse(
        "shopify_variant_gone",
        `Shopify variant ${externalId} no longer exists at the storefront.`,
        "Re-import the catalog so the queue reflects the storefront, then unmatch this entry.",
        "itemId",
      );
    }
    const fields = options.fields ?? ["price", "title"];
    const pushed: ("price" | "title")[] = [];
    if (fields.includes("price") && item.default_rate !== null) {
      const decimal = rateToShopifyDecimal(item.default_rate, channel.currency);
      if (decimal !== remote.price.amount) {
        const productGid = remote.product.id;
        const { data } = await client.graphql<{
          productVariantsBulkUpdate: {
            productVariants: { id: string }[] | null;
            userErrors: { field: string[]; message: string }[];
          };
        }>(
          `mutation shopifyVariantPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
             productVariantsBulkUpdate(productId: $productId, variants: $variants) {
               productVariants { id }
               userErrors { field message }
             }
           }`,
          { productId: productGid, variants: [{ id: variantGid, price: decimal }] },
        );
        const errors = data.productVariantsBulkUpdate.userErrors;
        if (errors.length > 0) {
          refuse(
            "shopify_push_refused",
            `Shopify refused the price push: ${errors[0]!.message}.`,
            "Correct the price or the storefront state, then push again.",
            "itemId",
          );
        }
        pushed.push("price");
      }
    }
    if (fields.includes("title") && item.name !== remote.title) {
      const { data } = await client.graphql<{
        productUpdate: {
          product: { id: string } | null;
          userErrors: { field: string[]; message: string }[];
        };
      }>(
        `mutation shopifyProductTitle($input: ProductInput!) {
           productUpdate(input: $input) { product { id } userErrors { field message } }
         }`,
        { input: { id: remote.product.id, title: item.name } },
      );
      const errors = data.productUpdate.userErrors;
      if (errors.length > 0) {
        refuse(
          "shopify_push_refused",
          `Shopify refused the title push: ${errors[0]!.message}.`,
          "Correct the title or the storefront state, then push again.",
          "itemId",
        );
      }
      pushed.push("title");
    }
    await withOrg(orgId, async () => {
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'items', ${itemId}, 'update',
          ${JSON.stringify({ before: null, after: { pushed, variantExternalId: externalId }, reason: `Pushed to Shopify variant ${externalId}` })}::jsonb, ${actorId})`);
    });
    return { pushed, variantExternalId: externalId };
  }
}

/** Canonical rate ("19.9900") to the exact decimal Shopify prices in. */
function rateToShopifyDecimal(rate: string, currencyCode: string): string {
  const currency = SUPPORTED_CURRENCIES.find((entry) => entry.code === currencyCode.toUpperCase());
  const exponent = currency?.minorUnits ?? 2;
  const match = /^(\d+)(?:\.(\d+))?$/.exec(rate);
  if (!match) {
    refuse(
      "shopify_price_unreadable",
      `Item rate "${rate}" is not an exact decimal amount.`,
      "Correct the item's price to digits with an optional decimal point, then push again.",
      "itemId",
    );
  }
  const fraction = (match[2] ?? "").padEnd(exponent, "0");
  if (fraction.length > exponent) {
    refuse(
      "shopify_push_too_precise",
      `Item rate ${rate} carries more decimals than ${currencyCode.toUpperCase()} prices.`,
      "Round the item's price to the currency's decimals, then push again.",
      "itemId",
    );
  }
  const whole = match[1];
  return exponent === 0 ? whole! : `${whole}.${fraction}`;
}

/**
 * Retire a deleted storefront product: queued and ignored rows go (nothing
 * was ever decided on them); matched rows keep their link and gain a
 * deletion proposal so the operator confirms before unlinking.
 */
export async function retireCatalogProduct(
  orgId: string,
  actorId: string | null,
  channelId: string,
  productExternalId: string,
): Promise<{ removed: number; proposed: number }> {
  return withOrg(orgId, async () => {
    const removed = await db.execute(sql`
      delete from shopify_catalog_entries
       where org_id = ${orgId} and channel_id = ${channelId}
         and status <> 'matched'
         and (external_id = ${productExternalId}
              or external_parent_id = ${productExternalId})`);
    const matched = (
      await db.execute<{ id: string }>(sql`
        select id from shopify_catalog_entries
         where org_id = ${orgId} and channel_id = ${channelId}
           and status = 'matched'
           and (external_id = ${productExternalId}
                or external_parent_id = ${productExternalId})`)
    ).rows;
    for (const row of matched) {
      await setProposal(orgId, actorId, row.id, {
        kind: "deleted_at_shopify",
        remedy: "Confirm the product is gone in Shopify, then unmatch the entry to release the link.",
      });
    }
    return { removed: removed.rowCount ?? 0, proposed: matched.length };
  });
}
