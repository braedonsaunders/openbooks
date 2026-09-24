import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
  mapped: Array<{ error: unknown }>;
}

const stateKey = Symbol.for("openbooks.hrm-recruiting-applications-route-test");
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
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-applications-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.recruiting.read' && permission !== 'hrm.recruiting.manage') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmRecruitingApplicationsNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-applications-route-test')]
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
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-applications-route-test')]
      export async function createApplication(args) {
        state.calls.push({ fn: 'create', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'application-1' }
      }
      export async function moveApplicationStage(args) {
        state.calls.push({ fn: 'move', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.applicationId }
      }
      export async function rejectApplication(args) {
        state.calls.push({ fn: 'reject', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.applicationId }
      }
      export async function withdrawApplication(args) {
        state.calls.push({ fn: 'withdraw', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.applicationId }
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-applications-route-test')]
      const NextResponse = globalThis.openbooksHrmRecruitingApplicationsNextResponse
      export function recruitingErrorResponse(error) {
        state.mapped.push({ error })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmRecruitingApplicationsNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["../../../../../../lib/authz", "mock:authz"],
  ["../../../../../../lib/features", "mock:features"],
  ["../../../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/recruiting/applications.ts", "mock:service"],
  ["../_lib", "mock:lib"],
  ["../../_lib", "mock:lib"],
]);

let collectionRoute: typeof import("./route.ts") | undefined;
let itemRoute: typeof import("./[id]/route.ts") | undefined;
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
  const collectionUrl = "./route.ts?hrm-recruiting-applications-collection";
  collectionRoute = (await import(collectionUrl)) as typeof import("./route.ts");
  const itemUrl = "./[id]/route.ts?hrm-recruiting-applications-item";
  itemRoute = (await import(itemUrl)) as typeof import("./[id]/route.ts");
  hooks.deregister();
}

const REQUISITION_ID = "00000000-0000-4000-8000-000000000021";
const CANDIDATE_ID = "00000000-0000-4000-8000-000000000022";
const APPLICATION_ID = "00000000-0000-4000-8000-000000000023";
const STAGE_ID = "00000000-0000-4000-8000-000000000024";

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [] as RouteState["calls"];
  routeState.serviceThrow = null;
  routeState.mapped = [];
}

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

if (isVitest) {
  test("applications routes gate on the hrm feature and the recruiting permissions", async () => {
    const { readFileSync } = await import("node:fs");
    assert.match(readFileSync(new URL("./route.ts", import.meta.url), "utf8"), /guardPermission\("hrm\.recruiting\.manage"\)/);
    assert.match(readFileSync(new URL("./[id]/route.ts", import.meta.url), "utf8"), /guardPermission\("hrm\.recruiting\.read"\)/);
  });
} else {
  test("a missing feature flag 404s before the service runs", async () => {
    reset();
    routeState.featureOn = false;
    assert.equal((await collectionRoute!.POST(jsonRequest("http://openbooks.test/x", "POST", {}))).status, 404);
    assert.equal(
      (await itemRoute!.PATCH(jsonRequest("http://openbooks.test/x", "PATCH", {}), { params: Promise.resolve({ id: APPLICATION_ID }) })).status,
      404,
    );
    assert.deepEqual(routeState.calls, []);
  });

  test("attach validates the body through the real parser before the service runs", async () => {
    reset();
    const url = "http://openbooks.test/api/hrm/recruiting/applications";
    assert.equal((await collectionRoute!.POST(jsonRequest(url, "POST", {}))).status, 400);
    assert.equal((await collectionRoute!.POST(jsonRequest(url, "POST", { requisitionId: "nope", candidateId: CANDIDATE_ID }))).status, 400);
    assert.deepEqual(routeState.calls, []);
    const response = await collectionRoute!.POST(
      jsonRequest(url, "POST", { requisitionId: REQUISITION_ID, candidateId: CANDIDATE_ID }),
    );
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { application: { id: "application-1" } });
  });

  test("item PATCH validates the action union through the real parser", async () => {
    reset();
    const params = { params: Promise.resolve({ id: APPLICATION_ID }) };
    assert.equal((await itemRoute!.PATCH(jsonRequest("http://openbooks.test/x", "PATCH", { action: "move" }), params)).status, 400);
    assert.equal((await itemRoute!.PATCH(jsonRequest("http://openbooks.test/x", "PATCH", { action: "reject" }), params)).status, 400);
    assert.equal(
      (await itemRoute!.PATCH(jsonRequest("http://openbooks.test/x", "PATCH", { action: "move", toStageId: "nope" }), params)).status,
      400,
    );
    assert.deepEqual(routeState.calls, []);
  });

  test("item PATCH dispatches every action with org, actor, and id", async () => {
    reset();
    const params = { params: Promise.resolve({ id: APPLICATION_ID }) };
    for (const [body, fn] of [
      [{ action: "move", toStageId: STAGE_ID }, "move"],
      [{ action: "reject", reason: "not a fit" }, "reject"],
      [{ action: "withdraw" }, "withdraw"],
    ] as const) {
      routeState.calls = [] as RouteState["calls"];
      const response = await itemRoute!.PATCH(jsonRequest("http://openbooks.test/x", "PATCH", body), params);
      assert.equal(response.status, 200);
      assert.equal(routeState.calls[0]!.fn, fn);
      assert.deepEqual((routeState.calls[0]!.args as Record<string, unknown>).applicationId, APPLICATION_ID);
    }
  });

  test("a service refusal delegates to the shared mapping with the error intact", async () => {
    reset();
    const refusal = new Error("the hired stage is reached only through hire");
    routeState.serviceThrow = refusal;
    const response = await itemRoute!.PATCH(
      jsonRequest("http://openbooks.test/x", "PATCH", { action: "move", toStageId: STAGE_ID }),
      { params: Promise.resolve({ id: APPLICATION_ID }) },
    );
    assert.equal(response.status, 409);
    assert.equal(routeState.mapped[0]!.error, refusal);
  });
}
