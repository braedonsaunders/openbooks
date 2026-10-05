import { ShopifyClient } from "../../connectors/shopify.ts";
import { add, cmp, fromUnits, neg, normalizeDecimal, toUnits } from "../../money/money.ts";
import { CommerceError } from "../errors.ts";

/**
 * Storefront inventory push: available-to-sell becomes a whole-unit
 * Shopify quantity, guarded by the last-pushed baseline so a quantity
 * changed outside OpenBooks is surfaced as a conflict, never overwritten.
 *
 * Shopify holds whole units (a 32-bit Int). OpenBooks keeps four decimal
 * places, so the push floors — it never promises a fraction it cannot
 * ship, and never rounds up into an oversell.
 */

/** Largest whole-unit quantity Shopify's Int quantity accepts. */
export const SHOPIFY_MAX_QUANTITY = 2_147_483_647;

function refuse(code: string, message: string, remedy: string, field: string | null = null): never {
  throw new CommerceError(code, message, remedy, { field });
}

/**
 * What the storefront may sell: available to promise less the buffer kept
 * back, clamped at zero, floored to whole units for the push. The decimal
 * `sellable` is what the operator sees; `pushQuantity` is what Shopify gets.
 */
export function sellableQuantity(
  atpAvailable: string,
  bufferQuantity: string,
): { sellable: string; pushQuantity: number } {
  let buffer: string;
  try {
    buffer = normalizeDecimal(bufferQuantity, 4);
  } catch {
    refuse(
      "channel_inventory_buffer_invalid",
      `The keep-back buffer "${bufferQuantity}" is not a quantity OpenBooks can hold.`,
      "Enter the buffer as whole units (for example 2) under Channels → Locations & stock.",
      "bufferQuantity",
    );
  }
  let available: string;
  try {
    available = normalizeDecimal(atpAvailable, 4);
  } catch {
    throw new Error(`Channel inventory push computed an unreadable available quantity of "${atpAvailable}"; the push was lost`);
  }
  const held = cmp(buffer, "0.0000") < 0 ? "0.0000" : buffer;
  const netted = add(available, neg(held));
  const sellable = cmp(netted, "0.0000") < 0 ? "0.0000" : netted;
  const floored = toUnits(sellable) / 10_000n;
  if (floored > BigInt(SHOPIFY_MAX_QUANTITY)) {
    refuse(
      "channel_inventory_quantity_unpushable",
      `The computed storefront quantity of ${fromUnits(toUnits(sellable))} exceeds what Shopify can hold.`,
      "Reduce the on-hand stock or raise the keep-back buffer, then push again from Channels → Locations & stock.",
      null,
    );
  }
  return { sellable, pushQuantity: Number(floored) };
}

export type PushDecision =
  | { action: "push"; compareQuantity: number | null }
  | { action: "converged" }
  | { action: "conflict"; live: number };

/**
 * Push, skip, or conflict from the two quantities that matter: what
 * OpenBooks computes now (`computed`) and what the storefront holds now
 * (`live`, null when the storefront carries no level yet), against the
 * baseline of the last push (`pushed`, `lastShopify`, null before the
 * first push).
 *
 * A converged pair needs no call — the storefront already shows the
 * computed quantity, so the caller only refreshes the baseline. A first
 * push carries the live quantity as its compare, so even the initial sync
 * conflicts instead of overwriting a concurrent change.
 */
export function decidePushOutcome(input: {
  computed: number;
  live: number | null;
  pushed: number | null;
  lastShopify: number | null;
}): PushDecision {
  const { computed, live, pushed, lastShopify } = input;
  if (live !== null && live === computed) return { action: "converged" };
  if (pushed === null || lastShopify === null) return { action: "push", compareQuantity: live };
  if (live === lastShopify) return { action: "push", compareQuantity: live };
  return { action: "conflict", live: live ?? lastShopify };
}

const INVENTORY_ITEM_QUERY = `query channelInventoryItem($id: ID!) {
  productVariant(id: $id) { inventoryItem { id } }
}`;

const LEVEL_QUERY = `query channelInventoryLevel($itemId: ID!, $locationId: ID!) {
  inventoryItem(id: $itemId) {
    inventoryLevel(locationId: $locationId) {
      quantities(names: ["available"]) { quantity updatedAt }
    }
  }
}`;

const SET_QUANTITIES_MUTATION = `mutation channelInventorySet($input: InventorySetQuantitiesInput!) {
  inventorySetQuantities(input: $input) {
    inventoryAdjustmentGroup { id }
    userErrors { field message }
  }
}`;

const VARIANT_POLICY_MUTATION = `mutation channelVariantPolicy($input: ProductVariantUpdateInput!) {
  productVariantUpdate(input: $input) {
    productVariant { id inventoryPolicy }
    userErrors { field message }
  }
}`;

function userErrorText(errors: Array<{ field?: unknown; message?: unknown }>): string {
  const first = errors[0];
  const field = Array.isArray(first?.field) ? first.field.join(".") : null;
  return `${field ? `${field}: ` : ""}${typeof first?.message === "string" ? first.message : "unknown error"}`;
}

/** The Shopify inventory item behind a variant, by variant gid. */
export async function resolveShopifyInventoryItemId(client: ShopifyClient, variantGid: string): Promise<string> {
  const { data } = await client.graphql<{
    productVariant: { inventoryItem: { id: string } | null } | null;
  }>(INVENTORY_ITEM_QUERY, { id: variantGid });
  const gid = data.productVariant?.inventoryItem?.id;
  if (typeof gid !== "string" || gid.trim() === "") {
    refuse(
      "channel_inventory_item_unreadable",
      "Shopify answered without an inventory item for this variant.",
      "Check the variant still exists in Shopify admin, then push again from Channels → Locations & stock.",
      null,
    );
  }
  return gid;
}

/** The storefront's available quantity at one location, null when it carries no level. */
export async function readShopifyAvailable(
  client: ShopifyClient,
  inventoryItemGid: string,
  locationGid: string,
): Promise<{ quantity: number | null; updatedAt: string | null }> {
  const { data } = await client.graphql<{
    inventoryItem: {
      inventoryLevel: { quantities: { quantity: number; updatedAt: string | null }[] } | null;
    } | null;
  }>(LEVEL_QUERY, { itemId: inventoryItemGid, locationId: locationGid });
  const entry = data.inventoryItem?.inventoryLevel?.quantities[0];
  if (!entry || typeof entry.quantity !== "number") return { quantity: null, updatedAt: null };
  return { quantity: entry.quantity, updatedAt: entry.updatedAt };
}

/**
 * Set the storefront quantity with optimistic concurrency: `compareQuantity`
 * is the quantity the last read saw, and Shopify refuses the write when the
 * level moved underneath it. The refusal travels as a named error so the
 * caller raises a conflict instead of retrying blindly.
 */
export async function setShopifyAvailable(
  client: ShopifyClient,
  input: {
    inventoryItemGid: string;
    locationGid: string;
    quantity: number;
    compareQuantity: number | null;
    referenceUri: string;
  },
): Promise<void> {
  const quantity =
    input.compareQuantity === null
      ? { inventoryItemId: input.inventoryItemGid, locationId: input.locationGid, quantity: input.quantity }
      : {
          inventoryItemId: input.inventoryItemGid,
          locationId: input.locationGid,
          quantity: input.quantity,
          compareQuantity: input.compareQuantity,
        };
  const { data } = await client.graphql<{
    inventorySetQuantities: { userErrors: { field: string[]; message: string }[] };
  }>(SET_QUANTITIES_MUTATION, {
    input: {
      name: "available",
      reason: "correction",
      referenceDocumentUri: input.referenceUri,
      quantities: [quantity],
    },
  });
  const errors = data.inventorySetQuantities.userErrors;
  if (errors.length > 0) {
    refuse(
      "channel_inventory_push_refused",
      `Shopify refused the stock push: ${userErrorText(errors)}.`,
      "Read the conflict queue under Channels → Locations & stock: a concurrent change waits there instead of being overwritten.",
      null,
    );
  }
}

/**
 * Enforce stop-selling-at-zero on the variant itself: DENY stops the
 * storefront selling past zero, CONTINUE leaves oversell to the merchant's
 * explicit policy. Quantity-only pushes never touch this.
 */
export async function setVariantSellablePolicy(
  client: ShopifyClient,
  variantGid: string,
  stopSellingAtZero: boolean,
): Promise<void> {
  const { data } = await client.graphql<{
    productVariantUpdate: {
      productVariant: { id: string } | null;
      userErrors: { field: string[]; message: string }[];
    };
  }>(VARIANT_POLICY_MUTATION, {
    input: { id: variantGid, inventoryPolicy: stopSellingAtZero ? "DENY" : "CONTINUE" },
  });
  const errors = data.productVariantUpdate.userErrors;
  if (errors.length > 0 || !data.productVariantUpdate.productVariant) {
    refuse(
      "channel_inventory_policy_refused",
      `Shopify refused the sellable policy: ${errors.length > 0 ? userErrorText(errors) : "no variant returned"}.`,
      "Check the variant still exists in Shopify admin, then push again from Channels → Locations & stock.",
      null,
    );
  }
}
