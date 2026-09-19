import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
  mapped: Array<{ error: unknown; status: number }>;
}

const stateKey = Symbol.for("openbooks.hrm-changerequests-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

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
      const state = globalThis[Symbol.for('openbooks.hrm-changerequests-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.employment.read' && permission !== 'hrm.employment.manage') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-changerequests-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:list-params",
    `
      export function isUuid(value) {
        return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value)
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-changerequests-route-test')]
      export async function createChangeRequestDraft(args) {
        state.calls.push({ fn: 'create', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'request-1', status: 'draft' }
      }
      export async function listChangeRequests(args) {
        state.calls.push({ fn: 'list', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ id: 'request-1', status: 'draft' }]
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-changerequests-route-test')]
      const NextResponse = globalThis.openbooksHrmRouteNextResponse
      export function changeRequestErrorResponse(error) {
        state.mapped.push({ error, status: 409 })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/change-requests.ts", "mock:service"],
  ["./_lib", "mock:lib"],
]);

let collectionRoute: typeof import("./route.ts") | undefined;
if (!isVitest) {
  const hooks = registerHooks({
    resolve(specifier, _context, nextResolve) {
      // The real JSON boundary is pure (Request + schema → value) and runs as-is;
      // only its server-only marker needs a stand-in outside Next.
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
  const routeUrl = "./route.ts?hrm-changerequests-collection";
  collectionRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const EMPLOYMENT_ID = "00000000-0000-4000-8000-000000000021";

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
  routeState.mapped = [];
}

function postRequest(body: unknown): Request {
  return new Request("http://openbooks.test/api/hrm/change-requests", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

if (isVitest) {
  test("collection route gates on the hrm feature and the employment permissions", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    assert.match(source, /guardPermission\("hrm\.employment\.manage"\)/);
    assert.match(source, /guardPermission\("hrm\.employment\.read"\)/);
    assert.match(source, /isFeatureEnabled\(gate\.user\.orgId, "hrm"\)/);
  });
} else {
  test("a missing feature flag 404s before the service runs", async () => {
    reset();
    routeState.featureOn = false;
    const get = await collectionRoute!.GET(
      new Request("http://openbooks.test/api/hrm/change-requests"),
    );
    assert.equal(get.status, 404);
    assert.deepEqual(routeState.calls, []);
    const post = await collectionRoute!.POST(postRequest({ employmentId: EMPLOYMENT_ID, payload: {} }));
    assert.equal(post.status, 404);
    assert.deepEqual(routeState.calls, []);
  });

  test("an unauthenticated caller never reaches the service", async () => {
    reset();
    routeState.gate = { status: 401 };
    const response = await collectionRoute!.POST(postRequest({ employmentId: EMPLOYMENT_ID, payload: {} }));
    assert.equal(response.status, 401);
    assert.deepEqual(routeState.calls, []);
  });

  test("create validates the body before the service runs", async () => {
    reset();
    assert.equal((await collectionRoute!.POST(postRequest({ payload: {} }))).status, 400);
    assert.equal(
      (await collectionRoute!.POST(postRequest({ employmentId: "nope", payload: {} }))).status,
      400,
    );
    assert.equal((await collectionRoute!.POST(postRequest({ employmentId: EMPLOYMENT_ID }))).status, 400);
    assert.deepEqual(routeState.calls, []);
  });

  test("create forwards org, actor, employment, and payload, then 201s", async () => {
    reset();
    const payload = { kind: "hire", effectiveFrom: "2026-09-01" };
    const response = await collectionRoute!.POST(postRequest({ employmentId: EMPLOYMENT_ID, payload }));
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { request: { id: "request-1", status: "draft" } });
    assert.deepEqual(routeState.calls, [
      { fn: "create", args: { orgId: "org-1", actorId: "user-1", employmentId: EMPLOYMENT_ID, payload } },
    ]);
  });

  test("a service refusal delegates to the shared mapping with the error intact", async () => {
    reset();
    const refusal = new Error("a terminal request is terminal");
    routeState.serviceThrow = refusal;
    const response = await collectionRoute!.POST(
      postRequest({ employmentId: EMPLOYMENT_ID, payload: { kind: "hire" } }),
    );
    assert.equal(response.status, 409);
    assert.deepEqual(routeState.mapped.map((m) => m.error), [refusal]);
  });

  test("list forwards filters and returns the service rows", async () => {
    reset();
    const response = await collectionRoute!.GET(
      new Request(`http://openbooks.test/api/hrm/change-requests?employment=${EMPLOYMENT_ID}&status=draft`),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { requests: [{ id: "request-1", status: "draft" }] });
    assert.deepEqual(routeState.calls, [
      { fn: "list", args: { orgId: "org-1", actorId: "user-1", employmentId: EMPLOYMENT_ID, status: "draft" } },
    ]);
  });

  test("list rejects a non-uuid employment filter", async () => {
    reset();
    const response = await collectionRoute!.GET(
      new Request("http://openbooks.test/api/hrm/change-requests?employment=nope"),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(routeState.calls, []);
  });
}
