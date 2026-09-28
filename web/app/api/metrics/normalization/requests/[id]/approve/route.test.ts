import assert from "node:assert/strict";
import test from "node:test";
import { NextResponse } from "next/server";
import { stubModules } from "../../../../../../../testing/stub-modules";

const stateKey = Symbol.for("openbooks.metrics-normalization-approve-test");
const routeState: {
  session: { id: string; orgId: string } | null;
  permissions: string[];
  features: string[];
  scopeDenied: boolean;
  calls: Array<{ orgId: string; requestId: string; approverId: string }>;
  behavior: "succeeded" | "self-approval";
} = {
  session: { id: "user-2", orgId: "org-1" },
  permissions: ["usage.manage", "close.reopen"],
  features: ["saasMetrics"],
  scopeDenied: false,
  calls: [],
  behavior: "succeeded",
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;
(globalThis as typeof globalThis & Record<string, unknown>).openbooksNormalizationApproveNextResponse = NextResponse;

// The authorize callback, params schema, and refusal mapping stay real: the
// doubles cover only the session, permission predicate, feature read, scope,
// and service boundary, and the service double throws a real-shaped refusal.
stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "@/lib/authz": `
      const NextResponse = globalThis.openbooksNormalizationApproveNextResponse
      const state = globalThis[Symbol.for('openbooks.metrics-normalization-approve-test')]
      export async function getAuthz() {
        if (!state.session) return null
        return { user: state.session, permissions: state.permissions, allowedSubsidiaryIds: null }
      }
      export function can(authz, perm) {
        const permissions = authz?.permissions ?? []
        return permissions.includes('*') || permissions.includes(perm)
      }
      export function guardUnrestrictedScope() {
        if (state.scopeDenied) return NextResponse.json({ error: 'restricted scope' }, { status: 403 })
        return null
      }
    `,
    "@/lib/features": `
      const state = globalThis[Symbol.for('openbooks.metrics-normalization-approve-test')]
      export async function isFeatureEnabled(_orgId, key) {
        return state.features.includes(key)
      }
    `,
    "@openbooks/engine/src/billing/metrics/metrics-normalization-service.ts": `
      const state = globalThis[Symbol.for('openbooks.metrics-normalization-approve-test')]
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
      export async function approveAndExecuteNormalizationRequest(args) {
        state.calls.push(args)
        if (state.behavior === 'self-approval') {
          throw new UsageBillingError(
            'saas_normalization_self_approval',
            'Request ' + args.requestId + ' cannot be approved by its requester.',
            'Have a different authorized approver approve the request in Company Setup → SaaS Metrics.',
            { field: 'approved_by', status: 409 },
          )
        }
        return {
          request: { id: args.requestId, month: '2026-07-01', status: 'succeeded', approvedBy: args.approverId },
          result: { requestId: args.requestId, month: '2026-07-01', denominationVersion: 'v1' },
        }
      }
    `,
  },
});

const { POST } = (await import(new URL("./route.ts?metrics-normalization-approve", import.meta.url).href)) as typeof import("./route.ts");

const REQUEST_ID = "00000000-0000-4000-8000-000000000002";

function reset(overrides?: Partial<typeof routeState>) {
  Object.assign(routeState, {
    session: { id: "user-2", orgId: "org-1" },
    permissions: ["usage.manage", "close.reopen"],
    features: ["saasMetrics"],
    scopeDenied: false,
    calls: [],
    behavior: "succeeded",
  }, overrides);
}

function post(id: string) {
  return POST(
    new Request(`http://openbooks.test/api/metrics/normalization/requests/${id}/approve`, { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
}

test("POST approves with the distinct approver identity and executes", async () => {
  reset();
  const response = await post(REQUEST_ID);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.request.status, "succeeded");
  assert.equal(body.result.denominationVersion, "v1");
  assert.deepEqual(routeState.calls, [{ orgId: "org-1", requestId: REQUEST_ID, approverId: "user-2" }]);
});

test("POST refuses a usage.manage-only caller that lacks close.reopen", async () => {
  reset({ permissions: ["usage.manage"] });
  const response = await post(REQUEST_ID);
  assert.equal(response.status, 403);
  assert.ok(String((await response.json()).error).includes("close.reopen"));
  assert.deepEqual(routeState.calls, [], "a half-authorized caller never reaches the service");
});

test("POST refuses a close.reopen-only caller that lacks usage.manage", async () => {
  reset({ permissions: ["close.reopen"] });
  const response = await post(REQUEST_ID);
  assert.equal(response.status, 403);
  assert.ok(String((await response.json()).error).includes("usage.manage"));
  assert.deepEqual(routeState.calls, []);
});

test("POST refuses an unauthenticated caller", async () => {
  reset({ session: null });
  const response = await post(REQUEST_ID);
  assert.equal(response.status, 401);
  assert.deepEqual(routeState.calls, []);
});

test("POST checks authorization before parsing the request id", async () => {
  reset({ permissions: [] });
  const response = await post("not-a-uuid");
  assert.equal(response.status, 403);
  assert.deepEqual(routeState.calls, []);
});

test("POST answers 400 for a malformed request id behind authorization", async () => {
  reset();
  const response = await post("not-a-uuid");
  assert.equal(response.status, 400);
  assert.deepEqual(routeState.calls, []);
});

test("POST checks the feature gate before parsing the request id", async () => {
  reset({ features: [] });
  const response = await post("not-a-uuid");
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
  assert.deepEqual(routeState.calls, [], "a feature-off caller never reaches the service");
});

test("POST checks unrestricted scope before parsing the request id", async () => {
  reset({ scopeDenied: true });
  const response = await post("not-a-uuid");
  assert.equal(response.status, 403);
  assert.deepEqual(routeState.calls, [], "a restricted caller never reaches the service");
});

test("POST hides behind 404 when the feature is off", async () => {
  reset({ features: [] });
  const response = await post(REQUEST_ID);
  assert.equal(response.status, 404);
  assert.deepEqual(routeState.calls, []);
});

test("POST refuses a subsidiary-restricted caller before executing", async () => {
  reset({ scopeDenied: true });
  const response = await post(REQUEST_ID);
  assert.equal(response.status, 403);
  assert.deepEqual(routeState.calls, []);
});

test("POST delivers a self-approval refusal with its code and remedy", async () => {
  reset({ behavior: "self-approval" });
  const response = await post(REQUEST_ID);
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "saas_normalization_self_approval");
  assert.ok(String(body.remedy).includes("different authorized approver"));
});

test("POST never returns a raw lease token", async () => {
  reset();
  const body = JSON.stringify(await (await post(REQUEST_ID)).json());
  assert.ok(!body.includes("leaseToken") && !body.includes("lease_token"));
});
