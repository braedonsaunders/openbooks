import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import {
  SubscriptionError,
  normalizeSubscriptionCadence,
  normalizeSubscriptionMoney,
  resolveNextBillOnUpdate,
} from "../../../../engine/src/billing/subscription-billing.ts";
import {
  assertUnrestrictedScope,
  UNRESTRICTED_SCOPE_REQUIRED,
  UnrestrictedScopeError,
} from "../../../../engine/src/organization/subsidiary-scope.ts";

interface RouteState {
  queries: unknown[];
  transactionQueries: unknown[];
  normalizedMoney: string[];
  normalizedCadences: Array<{ interval: string; intervalCount: number }>;
  engineCalls: Array<{ fn: string; args: unknown[] }>;
  mrrRows: Array<Record<string, unknown>>;
  orgCurrency: string;
  fxRate: string | null;
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: Set<string> | null;
  };
  customerSubsidiaryId: string | null;
  subscriptionSubsidiaryId: string | null;
  beforeSubscription: Record<string, unknown> | null;
  guardedThrough: string | null;
}

const stateKey = Symbol.for("openbooks.subscription-route-test");
const routeState: RouteState & {
  assertUnrestrictedScope: typeof assertUnrestrictedScope;
  unrestrictedScopeError: typeof UnrestrictedScopeError;
  unrestrictedScopeRequired: typeof UNRESTRICTED_SCOPE_REQUIRED;
  SubscriptionError: typeof SubscriptionError;
  normalizeSubscriptionCadence: typeof normalizeSubscriptionCadence;
  normalizeSubscriptionMoney: typeof normalizeSubscriptionMoney;
  resolveNextBillOnUpdate: typeof resolveNextBillOnUpdate;
} = {
  queries: [],
  transactionQueries: [],
  normalizedMoney: [],
  normalizedCadences: [],
  engineCalls: [],
  mrrRows: [],
  orgCurrency: "CAD",
  fxRate: null,
  authz: {
    user: { orgId: "org-1", id: "user-1" },
    allowedSubsidiaryIds: null,
  },
  customerSubsidiaryId: "subsidiary-a",
  subscriptionSubsidiaryId: "subsidiary-a",
  beforeSubscription: null,
  guardedThrough: null,
  SubscriptionError,
  assertUnrestrictedScope,
  unrestrictedScopeError: UnrestrictedScopeError,
  unrestrictedScopeRequired: UNRESTRICTED_SCOPE_REQUIRED,
  // The cursor guard is pure domain validation: the double delegates to the
  // real function, or the refusal cases below would test a copy of the rule.
  resolveNextBillOnUpdate,
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
        if (text.includes('select * from subscriptions where id =')) {
          return { rows: state.beforeSubscription ? [state.beforeSubscription] : [] }
        }
        if (text.includes('max(pi.period_ends_on)')) return { rows: [{ guardedThrough: state.guardedThrough }] }
        if (text.includes('update subscriptions set')) return { rows: [{ id: 'subscription-1' }] }
        if (text.includes('insert into audit_log')) return { rows: [] }
        if (text.includes('from orgs') && text.includes('base_currency')) return { rows: [{ baseCurrency: state.orgCurrency }] }
        if (text.includes('from fx_rates')) return { rows: state.fxRate ? [{ rate: state.fxRate }] : [] }
        if (text.includes('planCurrency')) return { rows: state.mrrRows }
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
      export async function lockCustomerForScope(tx) {
        return tx.execute({ queryChunks: ['select scoped customer lock for share'] })
      }
      export async function lockSubscriptionCustomerForScope(tx) {
        return tx.execute({ queryChunks: ['select customer for share'] })
      }
      export const resolveNextBillOnUpdate = (...args) => state.resolveNextBillOnUpdate(...args)
      export function monthlyRecurringRevenue(amount) { return String(amount) }
      export async function prorateFirstInvoice(...args) {
        state.engineCalls.push({ fn: 'prorateFirstInvoice', args })
        return { invoiceId: 'invoice-2', documentNumber: 'INV-0002', posted: false, amount: '42.0000' }
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
     }
     export function guardUnrestrictedScope(authz) {
       try {
         state.assertUnrestrictedScope(authz.allowedSubsidiaryIds)
         return null
       } catch (error) {
         if (!(error instanceof state.unrestrictedScopeError)) throw error
         return new Response(JSON.stringify({ error: state.unrestrictedScopeRequired }), { status: 403 })
       }
     }`,
  ],
  ["mock:features", "export async function isFeatureEnabled() { return true }"],
  ["mock:business-date", "export async function businessToday() { return '2026-08-26' }"],
]);

// Neither '@/lib/api/json' nor the money kernel is mocked: a double of
// validation or money cannot produce the refusals the real modules
// enforce, so it would hollow every refusal case behind it.
const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["@openbooks/engine/src/billing/subscription-billing.ts", "mock:subscription-engine"],
  ["@openbooks/engine/src/platform/business-date.ts", "mock:business-date"],
  ["../../../lib/authz", "mock:authz"],
  ["../../../lib/features", "mock:features"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The real '@/lib/api/json' imports 'server-only', which is inert here.
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
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
  routeState.mrrRows = [];
  routeState.orgCurrency = "CAD";
  routeState.fxRate = null;
  routeState.authz = {
    user: { orgId: "org-1", id: "user-1" },
    allowedSubsidiaryIds: null,
  };
  routeState.customerSubsidiaryId = "subsidiary-a";
  routeState.subscriptionSubsidiaryId = "subsidiary-a";
  routeState.beforeSubscription = null;
  routeState.guardedThrough = null;
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
    { body: { ...validPlan, amount: "1.00001" }, message: /amount allows at most 4 decimal places/ },
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

test("subscription MRR translates each active plan into the organization currency", async () => {
  reset();
  routeState.orgCurrency = "CAD";
  routeState.fxRate = "1.3500000000";
  routeState.mrrRows = [
    {
      id: "subscription-cad",
      status: "active",
      priceOverride: null,
      planAmount: "100.0000",
      interval: "monthly",
      intervalCount: 1,
      quantity: "1",
      planCurrency: "CAD",
    },
    {
      id: "subscription-usd",
      status: "active",
      priceOverride: null,
      planAmount: "100.0000",
      interval: "monthly",
      intervalCount: 1,
      quantity: "1",
      planCurrency: "USD",
    },
  ];

  const response = await GET();
  assert.equal(response.status, 200);
  const body = await response.json() as { mrr: string };
  assert.equal(body.mrr, "235.0000", "CAD 100 + USD 100 at 1.35 must be CAD 235");
});

test("subscription MRR refuses a foreign plan when no dated spot rate exists", async () => {
  reset();
  routeState.mrrRows = [{
    id: "subscription-usd",
    status: "active",
    priceOverride: null,
    planAmount: "100.0000",
    interval: "monthly",
    intervalCount: 1,
    quantity: "1",
    planCurrency: "USD",
  }];

  const response = await GET();
  assert.equal(response.status, 422);
  assert.match(String((await response.json() as { error: string }).error), /no spot rate/);
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
  assert.ok(
    routeState.transactionQueries.some((query) => sqlText(query).includes("scoped customer lock for share")),
    "creation must lock and recheck the customer inside the insert transaction",
  );

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

test("subsidiary-restricted callers cannot change organization-wide subscription plans", async () => {
  const actions: Array<Record<string, unknown>> = [
    { ...validPlan, action: "addPlan" },
    { action: "updatePlan", id: "plan-1", name: "Changed plan", amount: "30.00", interval: "monthly" },
    { action: "deletePlan", id: "plan-1" },
  ];
  for (const body of actions) {
    reset();
    routeState.authz.allowedSubsidiaryIds = new Set(["subsidiary-a"]);
    const response = await post(body);
    assert.equal(response.status, 403, String(body.action));
    assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
    assert.deepEqual(routeState.queries, [], `${String(body.action)} must be refused before any row lookup`);
    assert.deepEqual(routeState.transactionQueries, [], `${String(body.action)} must not open a write transaction`);
  }
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
    { fn: "billSubscriptionNow", args: ["subscription-1", undefined, { actorId: "user-1" }, null] },
    {
      fn: "changeSubscription",
      args: ["subscription-1", { quantity: "2.0000", priceOverride: undefined }, undefined, { actorId: "user-1" }, null],
    },
    { fn: "prorateFirstInvoice", args: ["subscription-1", "2026-09-26", undefined, { actorId: "user-1" }] },
  ]);
});

/** A plain subscription billed for [Mar 1, Apr 1): cursor Apr 1, one invoice. */
function billedMarchSubscription(): void {
  routeState.beforeSubscription = {
    id: "subscription-1",
    start_on: "2026-03-01",
    current_period_start: "2026-03-01",
    next_bill_on: "2026-04-01",
    last_invoice_id: "invoice-9",
  };
  routeState.guardedThrough = null;
}

/** Every string leaf of a drizzle query — bound params and template text alike. */
function boundStrings(query: unknown): string[] {
  const out: string[] = [];
  const visit = (node: unknown): void => {
    if (typeof node === "string" || typeof node === "number") {
      out.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      for (const element of node) visit(element);
      return;
    }
    if (node && typeof node === "object") {
      for (const value of Object.values(node as Record<string, unknown>)) visit(value);
    }
  };
  visit((query as { queryChunks?: unknown }).queryChunks ?? query);
  return out;
}

test("updateSubscription refuses a next bill date inside the billed window", async () => {
  reset();
  billedMarchSubscription();
  // Mar 15 passes the old only-check (>= current_period_start) and would
  // double-bill Mar 15 - Apr 1 under a different guard key.
  const response = await post({ action: "updateSubscription", id: "subscription-1", nextBillOn: "2026-03-15" });
  assert.equal(response.status, 422);
  assert.match(
    String((await response.json() as { error: string }).error),
    /already-billed service through 2026-04-01/,
  );
  assert.ok(
    !routeState.transactionQueries.map(sqlText).some((text) => text.includes("update subscriptions set")),
    "a refused cursor move must not reach the update",
  );
});

test("updateSubscription refuses a forward jump without an explicit skip", async () => {
  reset();
  billedMarchSubscription();
  const response = await post({ action: "updateSubscription", id: "subscription-1", nextBillOn: "2026-06-01" });
  assert.equal(response.status, 422);
  const error = String((await response.json() as { error: string }).error);
  assert.match(error, /skips unbilled service from 2026-04-01 to 2026-06-01/);
  assert.match(error, /skipUnbilledService and a skip reason/);
});

test("updateSubscription records a forward skip with its reason and shows the window", async () => {
  reset();
  billedMarchSubscription();
  const response = await post({
    action: "updateSubscription",
    id: "subscription-1",
    nextBillOn: "2026-06-01",
    skipUnbilledService: true,
    skipReason: "tenant paused Apr-May",
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean; skippedWindow: { from: string; to: string }; skipReason: string };
  assert.deepEqual(body.skippedWindow, { from: "2026-04-01", to: "2026-06-01" });
  assert.equal(body.skipReason, "tenant paused Apr-May");
  const auditQuery = routeState.transactionQueries.find((query) => sqlText(query).includes("insert into audit_log"));
  assert.ok(auditQuery, "a forward skip must write an audit row");
  const auditJson = boundStrings(auditQuery)
    .map((candidate) => {
      try {
        return JSON.parse(candidate) as unknown;
      } catch {
        return null;
      }
    })
    .find((parsed): parsed is { nextBillOnSkip: unknown } =>
      !!parsed && typeof parsed === "object" && "nextBillOnSkip" in parsed);
  assert.deepEqual(auditJson?.nextBillOnSkip, {
    from: "2026-04-01",
    to: "2026-06-01",
    reason: "tenant paused Apr-May",
  });
});

test("updateSubscription accepts a next bill date exactly on the boundary", async () => {
  reset();
  billedMarchSubscription();
  const response = await post({ action: "updateSubscription", id: "subscription-1", nextBillOn: "2026-04-01" });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});
