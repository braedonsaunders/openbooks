import { ShopifyClient } from "../../connectors/shopify.ts";
import { CommerceError } from "../errors.ts";
import type { ChannelFulfilment } from "../orders.ts";

/**
 * Shopify fulfilment sync over the Admin GraphQL API: read the order's
 * fulfilment orders, then fulfil them with tracking. Posting code calls
 * this through the channel-neutral fulfilment writer, never directly —
 * the provider stays behind this module and the shared GraphQL client.
 */

function fail(message: string, remedy: string): never {
  throw new CommerceError("shopify_fulfilment_failed", message, remedy);
}

/** Storefront REST id to Admin GraphQL order id. */
export function shopifyOrderGid(restId: string): string {
  return `gid://shopify/Order/${restId}`;
}

function text(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export interface ShopifyFulfillmentOrderLine {
  id: string;
  /** Units still fulfillable on an open fulfilment order. */
  remainingQuantity: number;
  /** The order's full line quantity, for closed orders that already hold it. */
  totalQuantity: number;
  lineItemId: string | null;
  sku: string | null;
}

export interface ShopifyFulfillmentOrder {
  id: string;
  status: string;
  lines: ShopifyFulfillmentOrderLine[];
}

interface FulfillmentOrdersData {
  order: {
    fulfillmentOrders: {
      edges: Array<{
        node: {
          id: string;
          status: string;
          lineItems: {
            edges: Array<{
              node: {
                id: string;
                remainingQuantity: number;
                totalQuantity: number;
                lineItem: { id: string; sku: string | null } | null;
              };
            }>;
          };
        };
      }>;
    } | null;
  } | null;
}

// FulfillmentOrderLineItem carries no `quantity`: open orders expose what is
// still fulfillable as remainingQuantity, and the full line as
// totalQuantity, per
// https://shopify.dev/docs/api/admin-graphql/latest/objects/FulfillmentOrderLineItem.
const FULFILLMENT_ORDERS_QUERY = /* GraphQL */ `
  query ChannelFulfillmentOrders($orderId: ID!) {
    order(id: $orderId) {
      fulfillmentOrders(first: 25) {
        edges {
          node {
            id
            status
            lineItems(first: 100) {
              edges {
                node {
                  id
                  remainingQuantity
                  totalQuantity
                  lineItem {
                    id
                    sku
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Read one Shopify order's fulfilment orders (the fulfillable units and
 * their line identities). Closed fulfilment orders stay in the list with
 * their status, so the caller can tell fulfilled from open.
 */
export async function fetchShopifyFulfillmentOrders(
  client: ShopifyClient,
  orderRestId: string,
): Promise<ShopifyFulfillmentOrder[]> {
  let data: FulfillmentOrdersData;
  try {
    ({ data } = await client.graphql<FulfillmentOrdersData>(FULFILLMENT_ORDERS_QUERY, {
      orderId: shopifyOrderGid(orderRestId),
    }));
  } catch (error) {
    fail(
      `Shopify would not list fulfilment orders for order ${orderRestId}: ${error instanceof Error ? error.message : String(error)}`,
      "Check the channel's connection under Channels → Settings, then replay the fulfilment.",
    );
  }
  const edges = data!.order?.fulfillmentOrders?.edges ?? [];
  return edges.map((edge) => ({
    id: edge.node.id,
    status: edge.node.status,
    lines: edge.node.lineItems.edges.map((line) => ({
      id: line.node.id,
      remainingQuantity: line.node.remainingQuantity,
      totalQuantity: line.node.totalQuantity,
      lineItemId: line.node.lineItem?.id ?? null,
      sku: line.node.lineItem?.sku ?? null,
    })),
  }));
}

export interface ShopifyFulfillmentLineInput {
  fulfillmentOrderId: string;
  items: Array<{ fulfillmentOrderLineId: string; quantity: number }>;
}

export interface CreateShopifyFulfillmentInput {
  orderRestId: string;
  lines: ShopifyFulfillmentLineInput[];
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  carrierName?: string | null;
  notifyCustomer?: boolean;
}

interface FulfillmentCreateData {
  fulfillmentCreate: {
    fulfillment: { id: string; status: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  } | null;
}

// fulfillmentCreate takes FulfillmentInput (FulfillmentV2Input belongs to
// fulfillmentCreateV2); both carry lineItemsByFulfillmentOrder,
// notifyCustomer and trackingInfo, per
// https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreate
// and
// https://shopify.dev/docs/api/admin-graphql/latest/input-objects/FulfillmentInput.
const FULFILLMENT_CREATE_MUTATION = /* GraphQL */ `
  mutation ChannelFulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Fulfil Shopify fulfilment-order lines with carrier tracking. A Shopify
 * user error refuses by name (unknown line, closed order, missing scope),
 * never as a silent skip — the fulfilment event parks with the remedy.
 */
export async function createShopifyFulfillment(
  client: ShopifyClient,
  input: CreateShopifyFulfillmentInput,
): Promise<{ fulfillmentId: string; status: string }> {
  if (input.lines.length === 0) {
    fail(
      "Shopify was asked to fulfil nothing: the shipment names no quantities.",
      "Ship a positive quantity on the shipment, then replay the fulfilment.",
    );
  }
  const trackingInfo: Record<string, string> = {};
  if (input.trackingNumber) trackingInfo.number = input.trackingNumber;
  if (input.trackingUrl) trackingInfo.url = input.trackingUrl;
  if (input.carrierName) trackingInfo.company = input.carrierName;
  const fulfillment: Record<string, unknown> = {
    lineItemsByFulfillmentOrder: input.lines.map((line) => ({
      fulfillmentOrderId: line.fulfillmentOrderId,
      fulfillmentOrderLineItems: line.items.map((item) => ({
        id: item.fulfillmentOrderLineId,
        quantity: item.quantity,
      })),
    })),
    notifyCustomer: input.notifyCustomer ?? false,
  };
  if (Object.keys(trackingInfo).length > 0) fulfillment.trackingInfo = trackingInfo;
  let data: FulfillmentCreateData;
  try {
    ({ data } = await client.graphql<FulfillmentCreateData>(FULFILLMENT_CREATE_MUTATION, { fulfillment }));
  } catch (error) {
    fail(
      `Shopify refused the fulfilment for order ${input.orderRestId}: ${error instanceof Error ? error.message : String(error)}`,
      "Check the channel's connection and fulfilment scopes under Channels → Settings, then replay the fulfilment.",
    );
  }
  const result = data!.fulfillmentCreate;
  const firstError = result?.userErrors?.[0];
  if (firstError) {
    fail(
      `Shopify refused the fulfilment for order ${input.orderRestId}: ${firstError.message}`,
      "Fix the quantities or the order's fulfilment state in Shopify admin, then replay the fulfilment.",
    );
  }
  if (!result?.fulfillment) {
    fail(
      `Shopify answered the fulfilment for order ${input.orderRestId} without a fulfilment.`,
      "Replay the fulfilment; if it persists, check the channel's connection under Channels → Settings.",
    );
  }
  return { fulfillmentId: result.fulfillment.id, status: result.fulfillment.status };
}

/**
 * Normalize one Shopify REST fulfilment payload into the channel-neutral
 * fulfilment. Pure — no database, no network — so the unit test pins it
 * against a realistic payload. A cancelled fulfilment normalizes with its
 * flag set: posting reverses the issue instead of issuing again.
 */
export function normalizeShopifyFulfilment(payload: unknown, orderExternalId: string): ChannelFulfilment {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("The Shopify fulfilment payload is not an object.", "Replay the fulfillments delivery from Shopify, then ingest it again.");
  }
  const fulfilment = payload as Record<string, unknown>;
  const externalId = text(
    fulfilment.id !== undefined && fulfilment.id !== null ? String(fulfilment.id) : null,
  );
  if (!externalId) {
    fail("The Shopify fulfilment carries no id.", "Replay the fulfillments delivery from Shopify, then ingest it again.");
  }
  const status = text(fulfilment.status) ?? "";
  const lineItems = Array.isArray(fulfilment.line_items)
    ? (fulfilment.line_items as Array<Record<string, unknown>>)
    : [];
  const trackingNumbers = Array.isArray(fulfilment.tracking_numbers)
    ? (fulfilment.tracking_numbers as unknown[]).map((number) => String(number)).filter((number) => number.trim() !== "")
    : [];
  const trackingUrls = Array.isArray(fulfilment.tracking_urls)
    ? (fulfilment.tracking_urls as unknown[]).map((url) => String(url)).filter((url) => url.trim() !== "")
    : [];
  return {
    externalId,
    orderExternalId,
    locationExternalId:
      fulfilment.location_id !== undefined && fulfilment.location_id !== null ? String(fulfilment.location_id) : null,
    status,
    cancelled: status.toLowerCase() === "cancelled",
    trackingNumber: text(fulfilment.tracking_number) ?? trackingNumbers[0] ?? null,
    trackingUrl: trackingUrls[0] ?? null,
    carrierName: text(fulfilment.tracking_company),
    lines: lineItems.map((entry) => {
      const rawQuantity = entry.quantity !== undefined && entry.quantity !== null ? String(entry.quantity) : "";
      if (!/^\d+$/.test(rawQuantity.trim()) || rawQuantity.trim() === "0") {
        fail(
          "A Shopify fulfilment line carries an unusable quantity.",
          "Replay the fulfillments delivery from Shopify, then ingest it again.",
        );
      }
      return {
        lineExternalId: entry.id !== undefined && entry.id !== null ? String(entry.id) : null,
        sku: text(entry.sku),
        variantExternalId: entry.variant_id !== undefined && entry.variant_id !== null ? String(entry.variant_id) : null,
        quantity: rawQuantity.trim(),
      };
    }),
    fulfilledAt: text(fulfilment.created_at) ?? text(fulfilment.updated_at) ?? new Date().toISOString(),
  };
}
