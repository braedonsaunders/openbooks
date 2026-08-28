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
  engineCalls: Array<{ fn: string; args: unknown[] }>;
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: Set<string> | null;
  };
  customerSubsidiaryId: string | null;
  subscriptionSubsidiaryId: string | null;
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
  engineCalls: [],
  authz: {
    user: { orgId: "org-1", id: "user-1" },
    allowedSubsidiaryIds: null,
  },
  customerSubsidiaryId: "subsidiary-a",
  subscriptionSubsidiaryId: "subsidiary-a",
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
        if (text.includes('from parties c')) return { rows: [{ subsidiaryId: state.customerSubsidiaryId }] }
        if (text.includes('from subscriptions s') && text.includes('join parties c')) {
          return { rows: [{ subsidiaryId: state.subscriptionSubsidiaryId }] }
        }
        if (text.includes('from subscriptions where id =')) return { rows: [{ owned: 1 }] }
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
      export async function billSubscriptionNow(...args) {
        state.engineCalls.push({ fn: 'billSubscriptionNow', args })
        return { invoiceId: 'invoice-1', documentNumber: 'INV-0001', posted: true }
      }
      export async function changeSubscription(...args) {
        state.engineCalls.push({ fn: 'changeSubscription', args })
        return { invoiceId: null, documentNumber: null, adjustment: '0.0000' }
      }
      export function monthlyRecurringRevenue() { return '0.0000' }
      export async function prorateFirstInvoice(...args) {
        state.engineCalls.push({ fn: 'prorateFirstInvoice', args })
        return { invoiceId: 'invoice-2', documentNumber: 'INV-0002', posted: false, amount: '42.0000' }
      }
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
    `const state = globalThis[Symbol.for('openbooks.subscription-route-test')]
     export async function guardPermission() { return state.authz }
     export function guardSubsidiaryScope(authz, subsidiaryId, opts = {}) {
       const allowed = authz.allowedSubsidiaryIds
       if (allowed === null || (subsidiaryId == null && opts.orgWideNull === true) || (subsidiaryId != null && allowed.has(subsidiaryId))) {
         return null
       }
       return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
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
const { GET, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  routeState.queries.length = 0;
  routeState.transactionQueries.length = 0;
  routeState.normalizedMoney.length = 0;
  routeState.normalizedCadences.length = 0;
  routeState.engineCalls.length = 0;
  routeState.authz = {
    user: { orgId: "org-1", id: "user-1" },
    allowedSubsidiaryIds: null,
  };
  routeState.customerSubsidiaryId = "subsidiary-a";
  routeState.subscriptionSubsidiaryId = "subsidiary-a";
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

test("subsidiary-restricted callers cannot create, list, or bill another customer's subscriptions", async () => {
  reset();
  routeState.authz.allowedSubsidiaryIds = new Set(["subsidiary-a"]);
  routeState.customerSubsidiaryId = "subsidiary-b";

  const createDenied = await post({
    action: "addSubscription",
    customerId: "customer-b",
    planId: "plan-1",
    startOn: "2026-08-26",
  });
  assert.equal(createDenied.status, 404);
  assert.deepEqual(routeState.transactionQueries, [], "out-of-scope customers must be rejected before writes");

  reset();
  routeState.authz.allowedSubsidiaryIds = new Set(["subsidiary-a"]);
  routeState.customerSubsidiaryId = "subsidiary-a";
  const createAllowed = await post({
    action: "addSubscription",
    customerId: "customer-a",
    planId: "plan-1",
    startOn: "2026-08-26",
  });
  assert.equal(createAllowed.status, 201, "in-scope customers remain manageable");

  reset();
  routeState.authz.allowedSubsidiaryIds = new Set(["subsidiary-a"]);
  routeState.subscriptionSubsidiaryId = "subsidiary-b";
  const billDenied = await post({ action: "billNow", id: "subscription-b" });
  assert.equal(billDenied.status, 404);
  assert.deepEqual(routeState.engineCalls, [], "out-of-scope subscriptions must not reach billing engines");
  assert.deepEqual(routeState.transactionQueries, [], "out-of-scope subscriptions must be rejected before writes");

  reset();
  routeState.authz.allowedSubsidiaryIds = new Set(["subsidiary-a"]);
  routeState.subscriptionSubsidiaryId = "subsidiary-b";
  const listResponse = await GET();
  assert.equal(listResponse.status, 200);
  assert.ok(
    routeState.queries.map(sqlText).some((text) => text.includes("c.subsidiary_id") && text.includes("any")),
    "subscription lists must carry the caller's subsidiary predicate",
  );
});

test("bill-now, change, and first proration attribute the engine call to the authenticated user", async () => {
  reset();
  const billResponse = await post({ action: "billNow", id: "subscription-1" });
  assert.equal(billResponse.status, 200);
  const changeResponse = await post({ action: "changeSubscription", id: "subscription-1", quantity: "2" });
  assert.equal(changeResponse.status, 200);
  const prorateResponse = await post({
    action: "addSubscription",
    customerId: "customer-1",
    planId: "plan-1",
    startOn: "2026-08-26",
    firstBillOn: "2026-09-26",
    prorateFirstPeriod: true,
  });
  assert.equal(prorateResponse.status, 201);

  // The defect: the route discarded gate.user.id on all three interactive
  // paths, so the engine stamped the subscription's own UUID into user-actor
  // columns. Every interactive engine call must carry the authenticated user.
  assert.deepEqual(routeState.engineCalls, [
    { fn: "billSubscriptionNow", args: ["subscription-1", undefined, { actorId: "user-1" }] },
    {
      fn: "changeSubscription",
      args: ["subscription-1", { quantity: "2.0000", priceOverride: undefined }, undefined, { actorId: "user-1" }],
    },
    { fn: "prorateFirstInvoice", args: ["subscription-1", "2026-09-26", undefined, { actorId: "user-1" }] },
  ]);
});
