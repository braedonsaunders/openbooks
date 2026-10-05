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
        has_more: false,
        data: [
          { id: "po_1", currency: "usd", amount: 1000, arrival_date: 1_783_641_600 },
          { id: "po_2", currency: "eur", amount: 2000, arrival_date: 1_783_728_000 },
        ],
      },
    },
  });
  const payouts = await fetchStripePayouts({ apiKey: "sk_test" }, fetchFn);
  assert.deepEqual(payouts, [
    { id: "po_1", currency: "USD", arrivalDate: "2026-07-10", amount: 1000 },
    { id: "po_2", currency: "EUR", arrivalDate: "2026-07-11", amount: 2000 },
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
        has_more: false,
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
        total_pages: 1, total_items: 1,
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
    () => importPulledSettlements("org", "recurly", [], null, null),
    /not available for recurly/,
  );
});

const stripeCharge = (id: string, amount = 1000) => ({ id, type: "charge", amount, fee: 0, net: amount, currency: "usd" });
const paypalCharge = (id: string) => ({ transaction_info: { transaction_id: id, transaction_event_code: "T0000", transaction_amount: { currency_code: "USD", value: "10.00" } } });

function sequenceFetch(bodies: unknown[]): PullFetchFn & { calls: string[] } {
  const calls: string[] = [];
  const fetchFn = Object.assign(async (url: string, init: Parameters<PullFetchFn>[1]) => {
    calls.push(url);
    assert.equal(init.redirect, "error", "credentials must not follow redirects");
    assert.ok(bodies.length, `unexpected request ${url}`);
    return { status: 200, json: async () => bodies.shift() };
  }, { calls });
  return fetchFn;
}

test("Stripe payout settlement includes every page and reconciles the provider total", async () => {
  const fetchFn = sequenceFetch([{ data: [stripeCharge("txn_a")], has_more: true }, { data: [stripeCharge("txn_b", 2000)], has_more: false }]);
  const result = await fetchStripePayoutSettlement({ apiKey: "synthetic" }, { id: "po_complete", currency: "USD", arrivalDate: "2026-07-10", amount: 3000 }, fetchFn);
  assert.deepEqual(result.lines.map((line) => line.externalRef), ["txn_a", "txn_b"]);
  assert.match(fetchFn.calls[1]!, /starting_after=txn_a/);
  assert.equal(result.raw?.providerPayoutAmount, "30.0000");
});

test("Stripe payout listing follows continuation instead of omitting older payouts", async () => {
  const payout = (id: string) => ({ id, currency: "usd", amount: 1000, arrival_date: 1_783_641_600 });
  const fetchFn = sequenceFetch([{ data: [payout("po_a")], has_more: true }, { data: [payout("po_b")], has_more: false }]);
  assert.deepEqual((await fetchStripePayouts({ apiKey: "synthetic" }, fetchFn)).map((row) => row.id), ["po_a", "po_b"]);
  assert.match(fetchFn.calls[1]!, /starting_after=po_a/);
});

test("Stripe refuses incomplete or repeated pagination and mismatched payout totals", async () => {
  for (const bodies of [
    [{ data: [stripeCharge("txn_a")] }],
    [{ data: [], has_more: true }],
    [{ data: [stripeCharge("txn_a")], has_more: true }, { data: [stripeCharge("txn_a")], has_more: false }],
    [{ data: [stripeCharge("txn_a")], has_more: false }],
  ]) {
    await assert.rejects(() => fetchStripePayoutSettlement({ apiKey: "synthetic" }, { id: "po_incomplete", currency: "USD", arrivalDate: "2026-07-10", amount: 2000 }, sequenceFetch(bodies)), /stripe.*(pagination|repeated|reconcile).*retry the complete pull/);
  }
});

test("Stripe page failure refuses the complete settlement instead of returning its first page", async () => {
  let calls = 0;
  const fetchFn: PullFetchFn = async () => ++calls === 1
    ? { status: 200, json: async () => ({ data: [stripeCharge("txn_a")], has_more: true }) }
    : { status: 503, json: async () => ({ error: { message: "Provider unavailable" } }) };
  await assert.rejects(() => fetchStripePayoutSettlement({ apiKey: "synthetic" }, { id: "po_failed", currency: "USD", arrivalDate: "2026-07-10" }, fetchFn), /po_failed.*Provider unavailable.*retry/);
});

test("PayPal retrieves every page and verifies the range count", async () => {
  const fetchFn = sequenceFetch([{ access_token: "synthetic" }, { page: 1, total_pages: 2, total_items: 2, transaction_details: [paypalCharge("pp_a")] }, { page: 2, total_pages: 2, total_items: 2, transaction_details: [paypalCharge("pp_b")] }]);
  const result = await fetchPaypalSettlement({ apiKey: "synthetic:synthetic" }, "pp_complete", { startDate: "2026-07-01", endDate: "2026-07-07" }, fetchFn);
  assert.deepEqual(result.lines.map((line) => line.externalRef), ["pp_a", "pp_b"]);
  assert.match(fetchFn.calls[2]!, /page=2/);
});

test("PayPal refuses missing counts, duplicate transactions, changing ranges and truncated pages", async () => {
  for (const pages of [
    [{ transaction_details: [paypalCharge("pp_a")] }],
    [{ total_pages: 1, total_items: 2, transaction_details: [paypalCharge("pp_a")] }],
    [{ total_pages: 2, total_items: 2, transaction_details: [] }],
    [{ total_pages: 2, total_items: 2, transaction_details: [paypalCharge("pp_a")] }, { total_pages: 2, total_items: 2, transaction_details: [paypalCharge("pp_a")] }],
    [{ total_pages: 2, total_items: 2, transaction_details: [paypalCharge("pp_a")] }, { total_pages: 3, total_items: 3, transaction_details: [paypalCharge("pp_b")] }],
  ]) {
    await assert.rejects(() => fetchPaypalSettlement({ apiKey: "synthetic:synthetic" }, "pp_incomplete", { startDate: "2026-07-01", endDate: "2026-07-07" }, sequenceFetch([{ access_token: "synthetic" }, ...pages])), /paypal.*retry the complete pull/);
  }
});
