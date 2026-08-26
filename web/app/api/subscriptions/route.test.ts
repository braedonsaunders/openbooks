import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import {
  SubscriptionError,
  normalizeSubscriptionCadence,
  normalizeSubscriptionMoney,
} from "../../../../engine/src/subscription-billing.ts";

interface RouteState {
  queries: unknown[];
  transactionQueries: unknown[];
  normalizedMoney: string[];
  normalizedCadences: Array<{ interval: string; intervalCount: number }>;
}

const stateKey = Symbol.for("openbooks.subscription-route-test");
const routeState: RouteState & {
  SubscriptionError: typeof SubscriptionError;
  normalizeSubscriptionCadence: typeof normalizeSubscriptionCadence;
  normalizeSubscriptionMoney: typeof normalizeSubscriptionMoney;
} = {
  queries: [],
  transactionQueries: [],
  normalizedMoney: [],
  normalizedCadences: [],
  SubscriptionError,
  normalizeSubscriptionCadence: (interval, intervalCount) => {
    const cadence = normalizeSubscriptionCadence(interval, intervalCount);
    routeState.normalizedCadences.push(cadence);
    return cadence;
  },
  normalizeSubscriptionMoney: (value, label, requirement) => {
    const money = normalizeSubscriptionMoney(value, label, requirement);
    routeState.normalizedMoney.push(money);
    return money;
  },
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      return (chunk as { queryChunks?: unknown[] })?.queryChunks ? sqlText(chunk) : "";
    })
    .join("");
}

(globalThis as typeof globalThis & { openbooksSubscriptionSqlText?: typeof sqlText })
  .openbooksSubscriptionSqlText = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.subscription-route-test')]
      const sqlText = globalThis.openbooksSubscriptionSqlText
      const response = (query) => {
        const text = sqlText(query)
        if (text.includes('insert into subscription_plans')) return { rows: [{ id: 'plan-1' }] }
        if (text.includes('insert into subscriptions')) return { rows: [{ id: 'subscription-1' }] }
        return { rows: [] }
      }
      export const db = {
        execute: async (query) => {
          state.queries.push(query)
          return response(query)
        },
        transaction: async (work) => work({
          execute: async (query) => {
            state.transactionQueries.push(query)
            return response(query)
          },
        }),
      }
    `,
  ],
  [
    "mock:subscription-engine",
    `
      const state = globalThis[Symbol.for('openbooks.subscription-route-test')]
      export const SubscriptionError = state.SubscriptionError
      export const normalizeSubscriptionCadence = (...args) => state.normalizeSubscriptionCadence(...args)
      export const normalizeSubscriptionMoney = (...args) => state.normalizeSubscriptionMoney(...args)
      export async function billSubscriptionNow() { throw new Error('unexpected bill') }
      export async function changeSubscription() { throw new Error('unexpected change') }
      export function monthlyRecurringRevenue() { return '0.0000' }
      export async function prorateFirstInvoice() { throw new Error('unexpected proration') }
    `,
  ],
  [
    "mock:json",
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    "mock:authz",
    `export async function guardPermission() {
       return { user: { orgId: 'org-1', id: 'user-1' } }
     }`,
  ],
  ["mock:features", "export async function isFeatureEnabled() { return true }"],
  ["mock:money", "export function add(left) { return left }"],
  ["mock:business-date", "export async function businessToday() { return '2026-08-26' }"],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/db.ts", "mock:db"],
  ["@openbooks/engine/src/subscription-billing.ts", "mock:subscription-engine"],
  ["@openbooks/engine/src/money.ts", "mock:money"],
  ["@openbooks/engine/src/business-date.ts", "mock:business-date"],
  ["@/lib/api/json", "mock:json"],
  ["../../../lib/authz", "mock:authz"],
  ["../../../lib/features", "mock:features"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?subscription-configuration-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  routeState.queries.length = 0;
  routeState.transactionQueries.length = 0;
  routeState.normalizedMoney.length = 0;
  routeState.normalizedCadences.length = 0;
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(new Request("http://openbooks.test/api/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

const validPlan = {
  action: "addPlan",
  name: "Exact plan",
  amount: "25.0000",
  interval: "monthly",
  intervalCount: 1,
};

test("subscription API rejects invalid money, cadence, quantity, and periods before writes", async () => {
  const cases: Array<{ body: Record<string, unknown>; message: RegExp }> = [
    { body: { ...validPlan, amount: "-0.0001" }, message: /amount must be nonnegative/ },
    { body: { ...validPlan, amount: "1.00001" }, message: /amount must be an exact decimal/ },
    { body: { ...validPlan, amount: "1000000000000000" }, message: /supported money range/ },
    { body: { ...validPlan, intervalCount: 0 }, message: /positive integer/ },
    { body: { ...validPlan, interval: "sometimes" }, message: /interval must be/ },
    {
      body: {
        action: "addSubscription",
        customerId: "customer-1",
        planId: "plan-1",
        quantity: "0",
        startOn: "2026-08-26",
      },
      message: /quantity must be greater than zero/,
    },
    {
      body: {
        action: "addSubscription",
        customerId: "customer-1",
        planId: "plan-1",
        quantity: "1",
        priceOverride: "-0.0001",
        startOn: "2026-08-26",
      },
      message: /price override must be nonnegative/,
    },
    {
      body: {
        action: "addSubscription",
        customerId: "customer-1",
        planId: "plan-1",
        quantity: "1",
        startOn: "2026-08-26",
        firstBillOn: "2026-08-25",
      },
      message: /first bill date cannot precede/,
    },
  ];

  for (const { body, message } of cases) {
    reset();
    const response = await post(body);
    assert.equal(response.status, 422, JSON.stringify(body));
    assert.match(String((await response.json() as { error: string }).error), message);
    assert.deepEqual(routeState.transactionQueries, [], "validation must settle before a transaction starts");
  }
});

test("subscription API preserves valid exact-decimal plan and subscription values", async () => {
  reset();
  const planResponse = await post({
    ...validPlan,
    amount: "999999999999999.9999",
    interval: "quarterly",
    intervalCount: "3",
  });
  assert.equal(planResponse.status, 201);
  assert.deepEqual(routeState.normalizedMoney, ["999999999999999.9999"]);
  assert.deepEqual(routeState.normalizedCadences, [{ interval: "quarterly", intervalCount: 3 }]);

  reset();
  const subscriptionResponse = await post({
    action: "addSubscription",
    customerId: "customer-1",
    planId: "plan-1",
    quantity: "1.2345",
    priceOverride: "0.0001",
    startOn: "2026-08-26",
    firstBillOn: "2026-09-26",
    prorateFirstPeriod: false,
    autoPost: false,
  });
  assert.equal(subscriptionResponse.status, 201);
  assert.deepEqual(routeState.normalizedMoney, ["1.2345", "0.0001"]);
});
