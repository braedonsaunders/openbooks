import assert from "node:assert/strict";
import test from "node:test";
import { ShopifyClient } from "../../connectors/shopify.ts";
import { readShopDayTotals } from "./day-totals.ts";

/**
 * The close proof trusts the storefront, not the subledger — so this pins
 * the storefront reader itself against a realistic two-order day spread over
 * two Relay pages. The network is the only double (an injected fetch
 * transport); pagination, currency math and the refusal shape stay real.
 */
function graphqlTransport(pages: unknown[]): typeof fetch {
  let calls = 0;
  return (async () => {
    const body = pages[Math.min(calls, pages.length - 1)];
    calls += 1;
    return new Response(JSON.stringify({ data: body }));
  }) as typeof fetch;
}

function ordersPage(nodes: unknown[], endCursor: string | null): unknown {
  return {
    orders: {
      edges: nodes.map((node) => ({ node })),
      pageInfo: { hasNextPage: endCursor !== null, endCursor },
    },
  };
}

function orderNode(amount: string, currency = "USD"): unknown {
  return { totalPriceSet: { shopMoney: { amount, currencyCode: currency } } };
}

function shopClient(transport: typeof fetch): ShopifyClient {
  return new ShopifyClient({
    shopDomain: "example.myshopify.com",
    accessToken: "test-token",
    transport,
  });
}

test("day totals walk every page and sum shop money exactly", async () => {
  const totals = await readShopDayTotals(
    shopClient(
      graphqlTransport([
        ordersPage([orderNode("68.86"), orderNode("12.34")], "cursor-next"),
        ordersPage([orderNode("100.00")], null),
      ]),
    ),
    "2026-09-14",
    "USD",
  );
  assert.equal(totals.orderCount, 3);
  assert.equal(totals.grossMinor, 18120n);
  assert.equal(totals.currency, "USD");
});

test("an empty storefront day reports zero in the channel currency", async () => {
  const totals = await readShopDayTotals(
    shopClient(graphqlTransport([ordersPage([], null)])),
    "2026-09-14",
    "EUR",
  );
  assert.equal(totals.orderCount, 0);
  assert.equal(totals.grossMinor, 0n);
  assert.equal(totals.currency, "EUR");
});

test("nodes without a readable total are skipped without moving the count", async () => {
  const totals = await readShopDayTotals(
    shopClient(
      graphqlTransport([
        ordersPage([orderNode("10.00"), { totalPriceSet: null }, { bogus: true }], null),
      ]),
    ),
    "2026-09-14",
    "USD",
  );
  assert.equal(totals.orderCount, 1);
  assert.equal(totals.grossMinor, 1000n);
});

test("a missing orders connection refuses by name instead of reporting zero", async () => {
  await assert.rejects(
    readShopDayTotals(shopClient(graphqlTransport([{ shop: {} }])), "2026-09-14", "USD"),
    /without an orders connection/,
  );
});

test("a non-calendar day refuses before any network call", async () => {
  let calls = 0;
  const counting = (async () => {
    calls += 1;
    return new Response("{}");
  }) as typeof fetch;
  await assert.rejects(
    readShopDayTotals(shopClient(counting), "not-a-day", "USD"),
    /not a calendar date/,
  );
  assert.equal(calls, 0);
});
