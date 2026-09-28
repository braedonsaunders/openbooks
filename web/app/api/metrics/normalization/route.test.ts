import assert from "node:assert/strict";
import test from "node:test";
import { NextResponse } from "next/server";
import { stubModules } from "../../../../testing/stub-modules";

const stateKey = Symbol.for("openbooks.metrics-normalization-route-test");
const routeState: {
  session: { id: string; orgId: string } | null;
  permissions: string[];
  features: string[];
  scopeDenied: boolean;
  calls: Array<{ orgId: string }>;
  behavior: "states" | "empty" | "refusal";
} = {
  session: { id: "user-1", orgId: "org-1" },
  permissions: ["usage.read"],
  features: ["saasMetrics"],
  scopeDenied: false,
  calls: [],
  behavior: "states",
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;
(globalThis as typeof globalThis & Record<string, unknown>).openbooksNormalizationNextResponse = NextResponse;

// Validation (zod body/params) and the factory's refusal mapping stay real:
// only the auth, feature, scope, and database boundaries are doubled, and
// the service double throws a real-shaped refusal so the 4xx passthrough
// is genuinely exercised.
stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "@/lib/feature-gates": `
      const state = globalThis[Symbol.for('openbooks.metrics-normalization-route-test')]
      const NextResponse = globalThis.openbooksNormalizationNextResponse
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
      const NextResponse = globalThis.openbooksNormalizationNextResponse
      const state = globalThis[Symbol.for('openbooks.metrics-normalization-route-test')]
      export function guardUnrestrictedScope() {
        if (state.scopeDenied) return NextResponse.json({ error: 'restricted scope' }, { status: 403 })
        return null
      }
    `,
    "@openbooks/engine/src/billing/metrics/metrics-normalization-service.ts": `
      const state = globalThis[Symbol.for('openbooks.metrics-normalization-route-test')]
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
      const STATES = [
        {
          month: '2026-07-01', state: 'legacy',
          counts: { monthly: 1, facts: 1, cohorts: 1 },
          denominationVersion: null, reportingCurrency: null,
          request: null, failure: null, remedy: null,
        },
      ]
      export async function listNormalizationMonthStates(orgId) {
        state.calls.push({ orgId })
        if (state.behavior === 'empty') return []
        if (state.behavior === 'refusal') {
          throw new UsageBillingError(
            'saas_normalization_request_missing',
            'Normalization request does-not-exist does not exist in this organization.',
            'Choose an existing request in Company Setup → SaaS Metrics, or submit a new request for the month.',
            { field: 'requestId', status: 409 },
          )
        }
        return STATES
      }
    `,
  },
});

const { GET } = (await import("./route.ts?metrics-normalization-get")) as typeof import("./route.ts");

function reset(overrides?: Partial<typeof routeState>) {
  Object.assign(routeState, {
    session: { id: "user-1", orgId: "org-1" },
    permissions: ["usage.read"],
    features: ["saasMetrics"],
    scopeDenied: false,
    calls: [],
    behavior: "states",
  }, overrides);
}

test("GET returns the month states for the caller's organization", async () => {
  reset();
  const response = await GET(new Request("http://openbooks.test/api/metrics/normalization"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.length, 1);
  assert.equal(body[0].state, "legacy");
  assert.deepEqual(body[0].counts, { monthly: 1, facts: 1, cohorts: 1 });
  assert.deepEqual(routeState.calls, [{ orgId: "org-1" }]);
});

test("GET refuses without usage.read", async () => {
  reset({ permissions: [] });
  const response = await GET(new Request("http://openbooks.test/api/metrics/normalization"));
  assert.equal(response.status, 403);
  assert.deepEqual(routeState.calls, [], "a refused caller never reaches the service");
});

test("GET hides behind 404 when the feature is off", async () => {
  reset({ features: [] });
  const response = await GET(new Request("http://openbooks.test/api/metrics/normalization"));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
  assert.deepEqual(routeState.calls, []);
});

test("GET refuses an unauthenticated caller", async () => {
  reset({ session: null });
  const response = await GET(new Request("http://openbooks.test/api/metrics/normalization"));
  assert.equal(response.status, 401);
});

test("GET refuses a subsidiary-restricted caller before reading", async () => {
  reset({ scopeDenied: true });
  const response = await GET(new Request("http://openbooks.test/api/metrics/normalization"));
  assert.equal(response.status, 403);
  assert.deepEqual(routeState.calls, []);
});

test("GET preserves a service refusal code, message, and remedy", async () => {
  reset({ behavior: "refusal" });
  const response = await GET(new Request("http://openbooks.test/api/metrics/normalization"));
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "saas_normalization_request_missing");
  assert.ok(String(body.error).includes("does-not-exist"));
  assert.ok(String(body.remedy).includes("Company Setup → SaaS Metrics"));
});
