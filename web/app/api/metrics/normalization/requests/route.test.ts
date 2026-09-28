import assert from "node:assert/strict";
import test from "node:test";
import { NextResponse } from "next/server";
import { stubModules } from "../../../../../testing/stub-modules";

const stateKey = Symbol.for("openbooks.metrics-normalization-requests-test");
const routeState: {
  session: { id: string; orgId: string } | null;
  permissions: string[];
  features: string[];
  scopeDenied: boolean;
  calls: Array<{ orgId: string; month: string; reason: string; requestedBy: string; idempotencyKey: string }>;
  behavior: "created" | "replayed" | "conflict";
} = {
  session: { id: "user-1", orgId: "org-1" },
  permissions: ["usage.manage"],
  features: ["saasMetrics"],
  scopeDenied: false,
  calls: [],
  behavior: "created",
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;
(globalThis as typeof globalThis & Record<string, unknown>).openbooksNormalizationRequestsNextResponse = NextResponse;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "@/lib/feature-gates": `
      const state = globalThis[Symbol.for('openbooks.metrics-normalization-requests-test')]
      const NextResponse = globalThis.openbooksNormalizationRequestsNextResponse
      export async function guardFeaturePermission(permission, feature) {
        if (!state.session) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
        if (!state.permissions.includes(permission)) {
          return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
        }
        if (!state.features.includes(feature)) {
          return NextResponse.json({ error: 'feature_disabled' }, { status: 404 })
        }
        return { user: state.session, allowedSubsidiaryIds: null }
      }
    `,
    "@/lib/authz": `
      const NextResponse = globalThis.openbooksNormalizationRequestsNextResponse
      const state = globalThis[Symbol.for('openbooks.metrics-normalization-requests-test')]
      export function guardUnrestrictedScope() {
        if (state.scopeDenied) return NextResponse.json({ error: 'restricted scope' }, { status: 403 })
        return null
      }
    `,
    "@openbooks/engine/src/billing/metrics/metrics-normalization-service.ts": `
      const state = globalThis[Symbol.for('openbooks.metrics-normalization-requests-test')]
      class UsageBillingError extends Error {
        constructor(code, message, remedy, options) {
          super(message)
          this.name = 'UsageBillingError'
          this.code = code
          this.remedy = remedy
          this.field = options?.field ?? null
          this.status = options?.status ?? 422
        }
      }
      export async function createNormalizationRequest(args) {
        state.calls.push(args)
        if (state.behavior === 'replayed') {
          return { request: { id: 'request-1', month: args.month, status: 'pending' }, created: false }
        }
        if (state.behavior === 'conflict') {
          throw new UsageBillingError(
            'saas_normalization_idempotency_conflict',
            'Idempotency key ' + args.idempotencyKey + ' already belongs to request request-9 with a different body.',
            'Reuse the original request body with this idempotency key, or generate a new idempotency key in Company Setup → SaaS Metrics.',
            { field: 'idempotency_key', status: 409 },
          )
        }
        return { request: { id: 'request-1', month: args.month, status: 'pending' }, created: true }
      }
    `,
  },
});

const { POST } = (await import("./route.ts?metrics-normalization-requests")) as typeof import("./route.ts");

const KEY = "00000000-0000-4000-8000-000000000001";

function reset(overrides?: Partial<typeof routeState>) {
  Object.assign(routeState, {
    session: { id: "user-1", orgId: "org-1" },
    permissions: ["usage.manage"],
    features: ["saasMetrics"],
    scopeDenied: false,
    calls: [],
    behavior: "created",
  }, overrides);
}

function post(body: unknown) {
  return POST(
    new Request("http://openbooks.test/api/metrics/normalization/requests", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

const VALID = { month: "2026-07-01", reason: "Correct the July legacy denomination.", idempotencyKey: KEY };

test("POST files exactly one month with the caller's identity and answers 201", async () => {
  reset();
  const response = await post(VALID);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.created, true);
  assert.equal(body.request.status, "pending");
  assert.deepEqual(routeState.calls, [{
    orgId: "org-1",
    month: "2026-07-01",
    reason: "Correct the July legacy denomination.",
    requestedBy: "user-1",
    idempotencyKey: KEY,
  }]);
});

test("POST replays the same key and body with 200 instead of duplicating", async () => {
  reset({ behavior: "replayed" });
  const response = await post(VALID);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).created, false);
  assert.equal(routeState.calls.length, 1);
});

test("POST refuses a conflicting key reuse with its code and remedy", async () => {
  reset({ behavior: "conflict" });
  const response = await post(VALID);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "saas_normalization_idempotency_conflict");
  assert.ok(String(body.remedy).includes("Company Setup → SaaS Metrics"));
});

test("POST checks permission before parsing a malformed body", async () => {
  reset({ permissions: [] });
  const response = await post({ month: "not-a-month" });
  assert.equal(response.status, 403);
  assert.deepEqual(routeState.calls, [], "a refused caller never reaches the service");
});

test("POST answers 422 for a malformed body behind the permission", async () => {
  reset();
  const response = await post({ month: "2026-07-01" });
  assert.equal(response.status, 422);
  assert.deepEqual(routeState.calls, []);
});

test("POST checks the feature gate before parsing a malformed body", async () => {
  reset({ features: [] });
  const response = await post({ month: "not-a-month" });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
  assert.deepEqual(routeState.calls, [], "a feature-off caller never reaches the service");
});

test("POST checks unrestricted scope before parsing a malformed body", async () => {
  reset({ scopeDenied: true });
  const response = await post({ month: "not-a-month" });
  assert.equal(response.status, 403);
  assert.deepEqual(routeState.calls, [], "a restricted caller never reaches the service");
});

test("POST hides behind 404 when the feature is off", async () => {
  reset({ features: [] });
  const response = await post(VALID);
  assert.equal(response.status, 404);
  assert.deepEqual(routeState.calls, []);
});

test("POST refuses a subsidiary-restricted caller before writing", async () => {
  reset({ scopeDenied: true });
  const response = await post(VALID);
  assert.equal(response.status, 403);
  assert.deepEqual(routeState.calls, []);
});

test("POST never returns a raw lease token", async () => {
  reset();
  const body = JSON.stringify(await (await post(VALID)).json());
  assert.ok(!body.includes("leaseToken") && !body.includes("lease_token"));
});
