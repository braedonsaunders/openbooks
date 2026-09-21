import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

/**
 * Compliance-findings route gates (HR-13): the feature-off 404 fires
 * before the service runs, an unauthenticated caller never reaches it,
 * and engine refusals map with their message intact. Module doubles
 * follow the positions route-test pattern; the zod bodies and JSON
 * boundary run as-is.
 */

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
  mapped: Array<{ error: unknown }>;
}

const stateKey = Symbol.for("openbooks.hrm-compliance-route-test");
type TestFn = typeof nodeTest;
const test: TestFn = nodeTest;

const routeState: RouteState = {
  gate: { user: { id: "user-1", orgId: "org-1" } },
  featureOn: true,
  calls: [],
  serviceThrow: null,
  mapped: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-compliance-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.construction.read' && permission !== 'hrm.construction.manage') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmComplianceRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-compliance-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrmConstructionCompliance') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-compliance-route-test')]
      export async function listFindings(exec, orgId, actorId, status) {
        state.calls.push({ fn: 'list', args: { orgId, actorId, status } })
        if (state.serviceThrow) throw state.serviceThrow
        return []
      }
      export async function acknowledgeFinding(exec, orgId, actorId, findingId) {
        state.calls.push({ fn: 'ack', args: { orgId, actorId, findingId } })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: findingId }
      }
      export async function resolveFinding(exec, orgId, actorId, findingId, reason) {
        state.calls.push({ fn: 'resolve', args: { orgId, actorId, findingId, reason } })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: findingId }
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-compliance-route-test')]
      const NextResponse = globalThis.openbooksHrmComplianceRouteNextResponse
      export function constructionErrorResponse(error) {
        state.mapped.push({ error })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 422 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmComplianceRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/construction/findings.ts", "mock:service"],
  ["../_lib", "mock:lib"],
]);

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier);
  },
  load(url, _context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url);
  },
});
const findingsRoute = (await import("./compliance-findings/route.ts")) as typeof import("./compliance-findings/route.ts");
hooks.deregister();

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
  routeState.mapped = [];
}

test("a missing feature flag 404s before the service runs", async () => {
  reset();
  routeState.featureOn = false;
  const get = await findingsRoute.GET(new Request("http://openbooks.test/api/hrm/compliance/compliance-findings"));
  assert.equal(get.status, 404);
  assert.deepEqual(routeState.calls, []);
});

test("an unauthenticated caller never reaches the service", async () => {
  reset();
  routeState.gate = { status: 401 };
  const get = await findingsRoute.GET(new Request("http://openbooks.test/api/hrm/compliance/compliance-findings"));
  assert.equal(get.status, 401);
  assert.deepEqual(routeState.calls, []);
});

test("the list reads through the service with the caller's org", async () => {
  reset();
  const get = await findingsRoute.GET(
    new Request("http://openbooks.test/api/hrm/compliance/compliance-findings?status=open"),
  );
  assert.equal(get.status, 200);
  assert.deepEqual(routeState.calls, [{ fn: "list", args: { orgId: "org-1", actorId: "user-1", status: "open" } }]);
});

test("an engine refusal maps with its message intact", async () => {
  reset();
  routeState.serviceThrow = new Error("Compliance finding nope cannot be resolved");
  const put = await findingsRoute.PUT(
    new Request("http://openbooks.test/api/hrm/compliance/compliance-findings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "resolve",
        findingId: "00000000-0000-4000-8000-000000000001",
        reason: "fixed",
      }),
    }),
  );
  assert.equal(put.status, 422);
  assert.equal(routeState.mapped.length, 1);
});

test("an unshaped body never reaches the service", async () => {
  reset();
  const put = await findingsRoute.PUT(
    new Request("http://openbooks.test/api/hrm/compliance/compliance-findings", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "resolve" }),
    }),
  );
  assert.equal(put.status, 400);
  assert.deepEqual(routeState.calls, []);
});
