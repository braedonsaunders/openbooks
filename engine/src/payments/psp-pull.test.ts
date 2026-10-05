import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchPaypalSettlement,
  fetchStripePayouts,
  fetchStripePayoutSettlement,
  importPulledSettlements,
  resolvePaypalPullBase,
  resolveStripePullBase,
  type PullFetchFn,
} from "./psp-pull.ts";

function stubFetch(routes: Record<string, { status: number; body: unknown }>): PullFetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    for (const [prefix, response] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        return { status: response.status, json: async () => response.body };
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as PullFetchFn & { calls: string[] };
  fn.calls = calls;
  return fn;
}

test("Stripe payout list maps ids, currencies and arrival dates", async () => {
  const fetchFn = stubFetch({
    "https://api.stripe.com/v1/payouts": {
      status: 200,
      body: {
        data: [
          { id: "po_1", currency: "usd", arrival_date: 1_783_641_600 },
          { id: "po_2", currency: "eur", arrival_date: 1_783_728_000 },
        ],
      },
    },
  });
  const payouts = await fetchStripePayouts({ apiKey: "sk_test" }, fetchFn);
  assert.deepEqual(payouts, [
    { id: "po_1", currency: "USD", arrivalDate: "2026-07-10" },
    { id: "po_2", currency: "EUR", arrivalDate: "2026-07-11" },
  ]);
  assert.match(fetchFn.calls[0]!, /\/v1\/payouts\?limit=20/);
});

test("Stripe payout fetch failure names the provider error", async () => {
  const fetchFn = stubFetch({
    "https://api.stripe.com/v1/payouts": { status: 401, body: { error: { message: "Invalid API Key" } } },
  });
  await assert.rejects(
    () => fetchStripePayouts({ apiKey: "bad" }, fetchFn),
    /stripe payout fetch failed: Invalid API Key/,
  );
});

test("Stripe balance fetch parses one payout into a settlement", async () => {
  const fetchFn = stubFetch({
    "https://api.stripe.com/v1/balance_transactions": {
      status: 200,
      body: {
        data: [
          { id: "txn_1", type: "charge", amount: 10_000, fee: 290, net: 9_710, currency: "usd" },
          { id: "txn_2", type: "charge", amount: 5_000, fee: 150, net: 4_850, currency: "usd" },
        ],
      },
    },
  });
  const parsed = await fetchStripePayoutSettlement(
    { apiKey: "sk_test" },
    { id: "po_1", currency: "USD", arrivalDate: "2026-07-10" },
    fetchFn,
  );
  assert.equal(parsed.externalRef, "po_1");
  assert.equal(parsed.lines.length, 4);
});

test("PayPal pull exchanges credentials then maps the transaction page", async () => {
  const fetchFn = stubFetch({
    "https://api-m.sandbox.paypal.com/v1/oauth2/token": { status: 200, body: { access_token: "tok_1" } },
    "https://api-m.sandbox.paypal.com/v1/reporting/transactions": {
      status: 200,
      body: {
        transaction_details: [
          {
            transaction_info: {
              transaction_id: "8RU1",
              transaction_event_code: "T0000",
              transaction_amount: { currency_code: "USD", value: "50.00" },
            },
          },
        ],
      },
    },
  });
  const parsed = await fetchPaypalSettlement(
    { apiKey: "cid:secret" },
    "STL-PULL-1",
    { startDate: "2026-07-01", endDate: "2026-07-07" },
    fetchFn,
  );
  assert.equal(parsed.provider, "paypal");
  assert.equal(parsed.lines[0]!.kind, "charge");
  assert.ok(fetchFn.calls.some((url) => url.includes("/v1/oauth2/token")));
});

test("PayPal without a client pair refuses naming the shape to store", async () => {
  await assert.rejects(
    () => fetchPaypalSettlement({ apiKey: "not-a-pair" }, "STL-X", { startDate: "2026-07-01", endDate: "2026-07-02" }, stubFetch({})),
    /client_id:client_secret/,
  );
});

test("pull bases outside the allowlist refuse", () => {
  assert.throws(() => resolveStripePullBase("https://evil.example"), /not allowlisted/);
  assert.throws(() => resolvePaypalPullBase("https://evil.example"), /not allowlisted/);
  assert.equal(resolvePaypalPullBase("https://api-m.paypal.com"), "https://api-m.paypal.com");
  assert.equal(resolveStripePullBase(undefined), "https://api.stripe.com");
});

test("scheduled pull is unavailable for providers without a fetcher", async () => {
  await assert.rejects(
    () => importPulledSettlements("org", "shopify_payments", [], null, null),
    /not available for shopify_payments/,
  );
});
