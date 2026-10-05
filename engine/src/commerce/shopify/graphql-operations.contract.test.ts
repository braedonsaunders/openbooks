import assert from "node:assert/strict";
import { test } from "node:test";
import { SHOPIFY_API_VERSION, ShopifyClient } from "../../connectors/shopify.ts";
import { setShopifyAvailable, setVariantSellablePolicy } from "./inventory-push.ts";
import { createShopifyFulfillment, fetchShopifyFulfillmentOrders } from "./fulfilments.ts";
import { fetchShopifyPayouts } from "./payouts.ts";
import {
  SHOPIFY_WEBHOOK_TOPICS,
  ensureShopifySubscriptions,
  normalizeSubscriptionTopic,
} from "./subscriptions.ts";
import { readShopDayTotals } from "./day-totals.ts";

/**
 * Shopify Admin GraphQL wire contract. One strict fake stands in for
 * Shopify: it serves the documented field for every operation and answers
 * a removed or renamed field the way Shopify would — with a validation
 * error, so the operation refuses instead of booking a half-read result.
 * The network is the only double; parsing, math and error mapping stay
 * real. Doc references live beside each operation below.
 */

interface RecordedCall {
  url: string;
  query: string;
  variables: Record<string, unknown>;
}

const shopItem = "gid://shopify/InventoryItem/5001";
const shopLocation = "gid://shopify/Location/770001";
const variantGid = "gid://shopify/ProductVariant/9001";
const productGid = "gid://shopify/Product/901";
const callbackUrl = "https://openbooks.example/channels/shopify/in";

/** Every topic the fake already has, reported the way the API reports it. */
const existingSubs = [
  { id: "gid://shopify/WebhookSubscription/1", topic: "PRODUCTS_CREATE", uri: "https://other.example/hook" },
];

function validationError(message: string): Response {
  return Response.json({ errors: [{ message }] });
}

function strictTransport(calls: RecordedCall[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String((init as { body?: unknown })?.body ?? "{}")) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const query = body.query ?? "";
    const variables = (body.variables ?? {}) as Record<string, unknown>;
    calls.push({ url: String(url), query, variables });
    if (query.includes("productVariantUpdate(")) {
      return validationError("Field 'productVariantUpdate' doesn't exist on type 'Mutation'");
    }
    if (query.includes("productVariant(id:")) {
      return Response.json({
        data: { productVariant: { inventoryItem: { id: shopItem }, product: { id: productGid } } },
      });
    }
    if (query.includes("inventoryLevel(locationId:")) {
      return Response.json({
        data: { inventoryItem: { inventoryLevel: { quantities: [{ quantity: 4, updatedAt: "2026-10-01T00:00:00Z" }] } } },
      });
    }
    if (query.includes("inventorySetQuantities(")) {
      const input = variables.input as {
        name?: unknown;
        reason?: unknown;
        referenceDocumentUri?: unknown;
        quantities?: Record<string, unknown>[];
      };
      const line = input.quantities?.[0] ?? {};
      if ("compareQuantity" in line) {
        return validationError("InventoryQuantityInput doesn't accept 'compareQuantity'");
      }
      if (!("changeFromQuantity" in line)) {
        return validationError("InventoryQuantityInput requires 'changeFromQuantity'");
      }
      if (input.name !== "available" || input.reason !== "correction" || typeof input.referenceDocumentUri !== "string") {
        return validationError("InventorySetQuantitiesInput needs name, reason and referenceDocumentUri");
      }
      if (line.changeFromQuantity !== null && line.changeFromQuantity !== 4) {
        return Response.json({
          data: { inventorySetQuantities: { userErrors: [{ field: [], message: "change from quantity stale" }] } },
        });
      }
      return Response.json({
        data: { inventorySetQuantities: { inventoryAdjustmentGroup: { id: "gid://shopify/InventoryAdjustmentGroup/1" }, userErrors: [] } },
      });
    }
    if (query.includes("productVariantsBulkUpdate(")) {
      const variants = (variables.variants ?? []) as { id: string; inventoryPolicy: string }[];
      if (typeof variables.productId !== "string" || variants.length === 0) {
        return validationError("productVariantsBulkUpdate needs productId and variants");
      }
      return Response.json({
        data: {
          productVariantsBulkUpdate: { productVariants: variants.map((v) => ({ id: v.id })), userErrors: [] },
        },
      });
    }
    if (query.includes("fulfillmentCreate(")) {
      // fulfillmentCreate takes FulfillmentInput; FulfillmentV2Input belongs
      // to fulfillmentCreateV2.
      // https://shopify.dev/docs/api/admin-graphql/latest/mutations/fulfillmentCreate
      if (!query.includes("FulfillmentInput!") || query.includes("FulfillmentV2Input")) {
        return validationError("fulfillmentCreate takes FulfillmentInput");
      }
      return Response.json({
        data: { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/55", status: "SUCCESS" }, userErrors: [] } },
      });
    }
    if (query.includes("fulfillmentOrders(")) {
      if (/(?:^|[\s{,])quantity(?:\s|[,}])/.test(query)) {
        return validationError("Field 'quantity' doesn't exist on type 'FulfillmentOrderLineItem'");
      }
      return Response.json({
        data: {
          order: {
            fulfillmentOrders: {
              edges: [
                {
                  node: {
                    id: "gid://shopify/FulfillmentOrder/10",
                    status: "OPEN",
                    lineItems: {
                      edges: [
                        {
                          node: {
                            id: "gid://shopify/FulfillmentOrderLineItem/100",
                            remainingQuantity: 3,
                            totalQuantity: 5,
                            lineItem: { id: "gid://shopify/LineItem/1", sku: "TEE-RED-M" },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      });
    }
    if (query.includes("shopifyPaymentsAccount")) {
      return Response.json({
        data: {
          shopifyPaymentsAccount: {
            payouts: {
              edges: [
                {
                  cursor: "p1",
                  node: {
                    id: "gid://shopify/ShopifyPaymentsPayout/1",
                    issuedAt: "2026-07-10T00:00:00Z",
                    net: { amount: "77.10", currencyCode: "CAD" },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }
    if (query.includes("balanceTransactions")) {
      if (query.includes("sourceOrderId")) {
        return validationError("Field 'sourceOrderId' doesn't exist on type 'ShopifyPaymentsBalanceTransaction'");
      }
      return Response.json({
        data: {
          node: {
            id: "gid://shopify/ShopifyPaymentsPayout/1",
            balanceTransactions: {
              edges: [
                {
                  cursor: "t1",
                  node: {
                    id: "gid://shopify/ShopifyPaymentsBalanceTransaction/11",
                    type: "CHARGE",
                    amount: { amount: "100.00", currencyCode: "CAD" },
                    fee: { amount: "2.90", currencyCode: "CAD" },
                    net: { amount: "97.10", currencyCode: "CAD" },
                    associatedOrder: { id: "gid://shopify/Order/2001" },
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }
    if (query.includes("webhookSubscriptionCreate")) {
      const topic = variables.topic;
      const sub = (variables.webhookSubscription ?? {}) as Record<string, unknown>;
      if (typeof topic !== "string" || !/^[A-Z_]+$/.test(topic)) {
        return validationError("webhookSubscriptionCreate takes a WebhookSubscriptionTopic enum");
      }
      if (typeof sub.uri !== "string" || "callbackUrl" in sub || "endpoint" in sub) {
        return validationError("WebhookSubscriptionInput takes the delivery address as 'uri'");
      }
      return Response.json({
        data: { webhookSubscriptionCreate: { webhookSubscription: { id: "gid://shopify/WebhookSubscription/9" }, userErrors: [] } },
      });
    }
    if (query.includes("webhookSubscriptions(")) {
      if (!query.includes("uri") || query.includes("callbackUrl") || query.includes("endpoint")) {
        return validationError("WebhookSubscription exposes the delivery address as 'uri'");
      }
      return Response.json({
        data: {
          webhookSubscriptions: {
            edges: existingSubs.map((sub) => ({ node: sub })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }
    if (query.includes("shop {")) {
      return Response.json({
        data: {
          shop: {
            name: "Contract shop",
            myshopifyDomain: "contract.myshopify.com",
            plan: { displayName: "Shopify" },
            currencyCode: "USD",
          },
        },
      });
    }
    if (query.includes("commerceDayTotals") || query.includes("totalPriceSet")) {
      return Response.json({
        data: {
          orders: {
            edges: [{ node: { totalPriceSet: { shopMoney: { amount: "68.86", currencyCode: "USD" } } } }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }
    throw new Error(`strict fake has no documented shape for: ${query.slice(0, 80)}`);
  }) as unknown as typeof fetch;
}

function contractClient(calls: RecordedCall[], apiVersion?: string): ShopifyClient {
  return new ShopifyClient({
    shopDomain: "contract.myshopify.com",
    accessToken: "contract-token",
    transport: strictTransport(calls),
    ...(apiVersion === undefined ? {} : { apiVersion }),
  });
}

test("every call pins a supported Admin API version, overridable per channel", () => {
  assert.equal(SHOPIFY_API_VERSION, "2026-10");
  const pinned = contractClient([]);
  assert.equal(pinned.endpoint, "https://contract.myshopify.com/admin/api/2026-10/graphql.json");
  const heldBack = contractClient([], "2025-10");
  assert.equal(heldBack.endpoint, "https://contract.myshopify.com/admin/api/2025-10/graphql.json");
  const malformed = contractClient([], "latest");
  assert.equal(malformed.endpoint, pinned.endpoint, "a malformed override falls back to the pin, never to an unversioned URL");
});

test("inventory set sends the documented compare-and-swap field, always present", async () => {
  const calls: RecordedCall[] = [];
  const client = contractClient(calls);
  await setShopifyAvailable(client, {
    inventoryItemGid: shopItem,
    locationGid: shopLocation,
    quantity: 10,
    compareQuantity: 4,
    referenceUri: "gid://openbooks/channel-inventory/1",
  });
  const set = calls.find((call) => call.query.includes("inventorySetQuantities("));
  assert.ok(set, "expected the set mutation");
  const line = ((set.variables.input as { quantities: Record<string, unknown>[] }).quantities[0] ?? {}) as Record<string, unknown>;
  assert.equal(line.changeFromQuantity, 4);
  assert.ok(!("compareQuantity" in line), "the removed field must not travel");

  const skipped: RecordedCall[] = [];
  await setShopifyAvailable(contractClient(skipped), {
    inventoryItemGid: shopItem,
    locationGid: shopLocation,
    quantity: 10,
    compareQuantity: null,
    referenceUri: "gid://openbooks/channel-inventory/1",
  });
  const skippedSet = skipped.find((call) => call.query.includes("inventorySetQuantities("));
  const skippedLine = ((skippedSet!.variables.input as { quantities: Record<string, unknown>[] }).quantities[0] ?? {}) as Record<string, unknown>;
  assert.ok("changeFromQuantity" in skippedLine, "the field is mandatory even when the check is skipped");
  assert.equal(skippedLine.changeFromQuantity, null);

  const stale = await setShopifyAvailable(client, {
    inventoryItemGid: shopItem,
    locationGid: shopLocation,
    quantity: 10,
    compareQuantity: 9,
    referenceUri: "gid://openbooks/channel-inventory/1",
  }).then(
    () => null,
    (error: unknown) => error,
  );
  assert.equal(
    (stale as { code?: unknown } | null)?.code,
    "channel_inventory_push_refused",
    "a stale compare refuses by name so the caller raises a conflict",
  );
});

test("sellable policy updates through the bulk mutation, never the removed one", async () => {
  const calls: RecordedCall[] = [];
  await setVariantSellablePolicy(contractClient(calls), variantGid, true);
  assert.ok(
    calls.every((call) => !call.query.includes("productVariantUpdate(")),
    "the removed mutation must not be sent",
  );
  const bulk = calls.find((call) => call.query.includes("productVariantsBulkUpdate("));
  assert.ok(bulk, "expected the bulk policy update");
  assert.equal(bulk.variables.productId, productGid);
  const variants = bulk.variables.variants as { id: string; inventoryPolicy: string }[];
  assert.deepEqual(variants, [{ id: variantGid, inventoryPolicy: "DENY" }]);

  const continued: RecordedCall[] = [];
  await setVariantSellablePolicy(contractClient(continued), variantGid, false);
  const continuedBulk = continued.find((call) => call.query.includes("productVariantsBulkUpdate("));
  assert.deepEqual((continuedBulk!.variables.variants as { inventoryPolicy: string }[]).map((v) => v.inventoryPolicy), ["CONTINUE"]);
});

test("fulfilment creation pairs fulfillmentCreate with FulfillmentInput", async () => {
  const calls: RecordedCall[] = [];
  const created = await createShopifyFulfillment(contractClient(calls), {
    orderRestId: "7001",
    lines: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/10", items: [{ fulfillmentOrderLineId: "gid://shopify/FulfillmentOrderLineItem/100", quantity: 3 }] }],
    trackingNumber: "1Z999",
    trackingUrl: null,
    carrierName: "UPS",
    notifyCustomer: true,
  });
  assert.equal(created.fulfillmentId, "gid://shopify/Fulfillment/55");
  const mutation = calls.find((call) => call.query.includes("fulfillmentCreate("));
  assert.ok(mutation, "expected the fulfilment mutation");
  const input = mutation.variables.fulfillment as Record<string, unknown>;
  assert.deepEqual(Object.keys(input).sort(), ["lineItemsByFulfillmentOrder", "notifyCustomer", "trackingInfo"]);
  assert.equal(input.notifyCustomer, true);
  assert.deepEqual(input.trackingInfo, { number: "1Z999", company: "UPS" });
});

test("fulfilment orders read the documented quantity fields", async () => {
  const calls: RecordedCall[] = [];
  const orders = await fetchShopifyFulfillmentOrders(contractClient(calls), "7001");
  assert.equal(orders.length, 1);
  assert.equal(orders[0]!.status, "OPEN");
  assert.equal(orders[0]!.lines.length, 1);
  const line = orders[0]!.lines[0]!;
  assert.equal(line.remainingQuantity, 3, "open orders expose what is still fulfillable");
  assert.equal(line.totalQuantity, 5, "closed orders account for what they already hold");
  assert.equal(line.sku, "TEE-RED-M");
});

test("payout pull reads the source order through the associated reference", async () => {
  const calls: RecordedCall[] = [];
  const settlements = await fetchShopifyPayouts(contractClient(calls), { sinceDate: "2026-01-01" });
  assert.equal(settlements.length, 1);
  const charge = settlements[0]!.lines.find((line) => line.kind === "charge");
  assert.ok(charge, "expected a charge line");
  assert.equal((charge.meta as Record<string, unknown>).sourceOrderId, "gid://shopify/Order/2001");
  const txQuery = calls.find((call) => call.query.includes("balanceTransactions"));
  assert.ok(txQuery, "expected the balance-transactions query");
  assert.ok(txQuery.query.includes("associatedOrder"), "the source order travels as associatedOrder");
});

test("subscriptions subscribe exactly the handled topics over the documented shapes", async () => {
  const calls: RecordedCall[] = [];
  const result = await ensureShopifySubscriptions(contractClient(calls), callbackUrl);
  assert.equal(result.existing.length, 0, "the foreign subscription stays untouched");
  assert.deepEqual([...result.created].sort(), [...SHOPIFY_WEBHOOK_TOPICS].sort());
  const creates = calls.filter((call) => call.query.includes("webhookSubscriptionCreate"));
  assert.equal(creates.length, SHOPIFY_WEBHOOK_TOPICS.length);
  for (const create of creates) {
    assert.match(String(create.variables.topic ?? ""), /^[A-Z_]+$/, "topic travels as the enum, not the REST path");
    const sub = create.variables.webhookSubscription as Record<string, unknown>;
    assert.equal(sub.uri, callbackUrl);
    assert.equal(sub.format, "JSON");
  }
  const list = calls.find((call) => call.query.includes("webhookSubscriptions("));
  assert.ok(list && list.query.includes("uri"), "reconciliation reads the documented address field");
});

test("subscription topics normalize both ways the API reports them", () => {
  assert.equal(normalizeSubscriptionTopic("ORDERS_CREATE"), "orders/create");
  assert.equal(normalizeSubscriptionTopic("orders/create"), "orders/create");
  assert.equal(normalizeSubscriptionTopic("FULFILLMENTS_UPDATE"), "fulfillments/update");
  assert.equal(normalizeSubscriptionTopic(""), "");
});

test("day totals read the orders connection with shop money", async () => {
  const calls: RecordedCall[] = [];
  const totals = await readShopDayTotals(contractClient(calls), "2026-09-14", "USD");
  assert.equal(totals.orderCount, 1);
  assert.equal(totals.grossMinor, 6886n);
  const query = calls.find((call) => call.query.includes("orders("));
  assert.ok(query, "expected the day-totals query");
  assert.ok(query.query.includes("sortKey: CREATED_AT"), "the window pages in creation order");
  assert.ok(query.query.includes("totalPriceSet"), "totals come from the documented money bag");
});
