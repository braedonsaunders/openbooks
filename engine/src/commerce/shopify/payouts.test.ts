import assert from "node:assert/strict";
import test from "node:test";
import { ShopifyClient } from "../../connectors/shopify.ts";
import { fetchShopifyPayouts } from "./payouts.ts";

/**
 * A realistic Shopify Payments payout page: one payout with a charge, its
 * fee, and a refund naming the storefront order that the channel subledger
 * holds. Amounts are decimal strings in the payout currency, exactly as the
 * Admin API returns them.
 */
function stubTransport(): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
    if (typeof body.query === "string" && body.query.includes("balanceTransactions")) {
      return new Response(JSON.stringify({
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
                    sourceOrderId: "gid://shopify/Order/2001",
                  },
                },
                {
                  cursor: "t2",
                  node: {
                    id: "gid://shopify/ShopifyPaymentsBalanceTransaction/12",
                    type: "REFUND",
                    amount: { amount: "20.00", currencyCode: "CAD" },
                    fee: null,
                    net: null,
                    sourceOrderId: "gid://shopify/Order/2001",
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
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
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

function client(): ShopifyClient {
  return new ShopifyClient({
    shopDomain: "test.myshopify.com",
    accessToken: "test-token",
    transport: stubTransport(),
  });
}

test("shopify payout pull keeps the storefront order reference on every content line", async () => {
  const settlements = await fetchShopifyPayouts(client());
  assert.equal(settlements.length, 1);
  const batch = settlements[0]!;
  assert.equal(batch.provider, "shopify_payments");
  assert.equal(batch.currency, "CAD");
  const charge = batch.lines.find((line) => line.kind === "charge");
  assert.ok(charge, "expected a charge line");
  assert.equal((charge.meta as Record<string, unknown>).sourceOrderId, "gid://shopify/Order/2001");
  const refund = batch.lines.find((line) => line.kind === "refund");
  assert.ok(refund, "expected a refund line");
  assert.equal((refund.meta as Record<string, unknown>).sourceOrderId, "gid://shopify/Order/2001");
  const fee = batch.lines.find((line) => line.kind === "fee");
  assert.ok(fee, "expected the charge fee as its own line");
});

test("shopify payout pull refuses an unreadable payouts connection instead of booking half a payout", async () => {
  const broken = new ShopifyClient({
    shopDomain: "test.myshopify.com",
    accessToken: "test-token",
    transport: (async () =>
      new Response(JSON.stringify({ data: { shopifyPaymentsAccount: {} } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  });
  await assert.rejects(
    () => fetchShopifyPayouts(broken),
    /without a payouts connection/,
    "a shape Shopify changed must refuse by name",
  );
});
