import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  authz: { user: { id: string; orgId: string } } | null;
  canRead: boolean;
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
  mapped: Array<{ error: unknown }>;
}

const stateKey = Symbol.for("openbooks.hrm-review-cycles-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

const routeState: RouteState = {
  gate: { user: { id: "user-1", orgId: "org-1" } },
  authz: { user: { id: "user-1", orgId: "org-1" } },
  canRead: true,
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
      const state = globalThis[Symbol.for('openbooks.hrm-review-cycles-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.performance.manage') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmReviewCyclesRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
      export async function getAuthz() {
        return state.authz
      }
      export function can(authz, permission) {
        if (permission !== 'hrm.performance.read') throw new Error('unexpected can ' + permission)
        return state.canRead
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-review-cycles-route-test')]
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
        return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-review-cycles-route-test')]
      export async function createCycle(args) {
        state.calls.push({ fn: 'create', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'cycle-1', name: args.name }
      }
    `,
  ],
  [
    "mock:read",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-review-cycles-route-test')]
      export async function listCycleProgress(args) {
        state.calls.push({ fn: 'progress', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ id: 'cycle-1', scoped: true }]
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-review-cycles-route-test')]
      const NextResponse = globalThis.openbooksHrmReviewCyclesRouteNextResponse
      export function performanceErrorResponse(error) {
        state.mapped.push({ error })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmReviewCyclesRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/performance/review-cycles.ts", "mock:service"],
  ["@openbooks/engine/src/hrm/performance/performance-read.ts", "mock:read"],
  ["./_lib", "mock:lib"],
]);

let collectionRoute: typeof import("./route.ts") | undefined;
if (!isVitest) {
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
  const routeUrl = "./route.ts?hrm-review-cycles-collection";
  collectionRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const TEMPLATE_ID = "00000000-0000-4000-8000-000000000001";

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.authz = { user: { id: "user-1", orgId: "org-1" } };
  routeState.canRead = true;
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
  routeState.mapped = [];
}

function postRequest(body: unknown): Request {
  return new Request("http://openbooks.test/api/hrm/review-cycles", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a missing feature flag 404s before the service runs", async () => {
  reset();
  routeState.featureOn = false;
  const get = await collectionRoute!.GET();
  assert.equal(get.status, 404);
  assert.deepEqual(routeState.calls, []);
  const post = await collectionRoute!.POST(postRequest({ name: "X" }));
  assert.equal(post.status, 404);
  assert.deepEqual(routeState.calls, []);
});

test("an unauthenticated caller never reaches the service", async () => {
  reset();
  routeState.authz = null;
  routeState.gate = { status: 401 };
  assert.equal((await collectionRoute!.GET()).status, 401);
  assert.equal((await collectionRoute!.POST(postRequest({ name: "X" }))).status, 401);
  assert.deepEqual(routeState.calls, []);
});

test("listing fans out to the privacy-scoped loader with the caller's identity", async () => {
  reset();
  const response = await collectionRoute!.GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { cycles: [{ id: "cycle-1", scoped: true }] });
  assert.deepEqual(routeState.calls, [
    { fn: "progress", args: { orgId: "org-1", actorId: "user-1" } },
  ]);
});

test("create validates the body through the real parser before the service runs", async () => {
  reset();
  assert.equal((await collectionRoute!.POST(postRequest({ name: "X" }))).status, 400);
  assert.equal(
    (await collectionRoute!.POST(postRequest({ templateId: "nope", name: "X", periodStartOn: "2026-01-01", periodEndOn: "2026-06-30" }))).status,
    400,
  );
  assert.deepEqual(routeState.calls, []);
});

test("create refuses hostile payloads at the real boundary", async () => {
  reset();
  for (const body of ["{not json", "null", "[1,2]", '"text"', "42"]) {
    const refused = await collectionRoute!.POST(
      new Request("http://openbooks.test/api/hrm/review-cycles", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    assert.equal(refused.status, 400, `boundary accepted hostile payload: ${body}`);
  }
  assert.deepEqual(routeState.calls, []);
});

test("create forwards org, actor, and body, then 201s", async () => {
  reset();
  const response = await collectionRoute!.POST(
    postRequest({ templateId: TEMPLATE_ID, name: "FY26", periodStartOn: "2026-01-01", periodEndOn: "2026-06-30" }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(routeState.calls[0]!.args, {
    orgId: "org-1",
    actorId: "user-1",
    templateId: TEMPLATE_ID,
    name: "FY26",
    periodStartOn: "2026-01-01",
    periodEndOn: "2026-06-30",
    selfDueOn: null,
    managerDueOn: null,
    appliesTo: {},
  });
});

test("a service refusal delegates to the shared mapping with the error intact", async () => {
  reset();
  const refusal = new Error("template carries no required question");
  routeState.serviceThrow = refusal;
  const response = await collectionRoute!.POST(
    postRequest({ templateId: TEMPLATE_ID, name: "FY26", periodStartOn: "2026-01-01", periodEndOn: "2026-06-30" }),
  );
  assert.equal(response.status, 409);
  assert.equal(routeState.mapped.length, 1);
  assert.equal(routeState.mapped[0]!.error, refusal);
});
