import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
  mapped: unknown[];
}

const stateKey = Symbol.for("openbooks.hrm-changerequest-id-test");
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
    `
      const state = globalThis[Symbol.for('openbooks.hrm-changerequest-id-test')]
      export async function guardPermission(permission) {
        if (!['hrm.employment.read', 'hrm.employment.manage'].includes(permission)) {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmIdRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-changerequest-id-test')]
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
      const state = globalThis[Symbol.for('openbooks.hrm-changerequest-id-test')]
      export async function getChangeRequest(args) {
        state.calls.push({ fn: 'get', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.requestId, status: 'draft' }
      }
      export async function updateChangeRequestPayload(args) {
        state.calls.push({ fn: 'patch', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.requestId, status: 'draft' }
      }
      export async function submitChangeRequest(args) {
        state.calls.push({ fn: 'submit', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.requestId, status: 'pending_approval' }
      }
      export async function withdrawChangeRequest(args) {
        state.calls.push({ fn: 'withdraw', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.requestId, status: 'withdrawn' }
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-changerequest-id-test')]
      const NextResponse = globalThis.openbooksHrmIdRouteNextResponse
      export function changeRequestErrorResponse(error) {
        state.mapped.push(error)
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmIdRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["@/lib/api/json", "mock:json"],
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["../../../../../lib/list-params", "mock:list-params"],
  ["../../../../../../lib/authz", "mock:authz"],
  ["../../../../../../lib/features", "mock:features"],
  ["../../../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/change-requests.ts", "mock:service"],
  ["../_lib", "mock:lib"],
  ["../../_lib", "mock:lib"],
]);

let idRoute: typeof import("./route.ts") | undefined;
let submitRoute: typeof import("./submit/route.ts") | undefined;
let withdrawRoute: typeof import("./withdraw/route.ts") | undefined;
if (!isVitest) {
  const hooks = registerHooks({
    resolve(specifier, _context, nextResolve) {
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
  const idUrl = "./route.ts?hrm-changerequest-id";
  const submitUrl = "./submit/route.ts?hrm-changerequest-submit";
  const withdrawUrl = "./withdraw/route.ts?hrm-changerequest-withdraw";
  idRoute = (await import(idUrl)) as typeof import("./route.ts");
  submitRoute = (await import(submitUrl)) as typeof import("./submit/route.ts");
  withdrawRoute = (await import(withdrawUrl)) as typeof import("./withdraw/route.ts");
  hooks.deregister();
}

const REQUEST_ID = "00000000-0000-4000-8000-000000000031";
const ctx = { params: Promise.resolve({ id: REQUEST_ID }) };

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
  routeState.mapped = [];
}

if (isVitest) {
  test("record routes gate on the hrm feature and employment permissions", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["./route.ts", "./submit/route.ts", "./withdraw/route.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.match(source, /isFeatureEnabled\(gate\.user\.orgId, "hrm"\)/);
    }
  });
} else {
  test("record read returns the service row", async () => {
    reset();
    const response = await idRoute!.GET(new Request("http://openbooks.test/x"), ctx);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { request: { id: REQUEST_ID, status: "draft" } });
    assert.deepEqual(routeState.calls, [
      { fn: "get", args: { orgId: "org-1", actorId: "user-1", requestId: REQUEST_ID } },
    ]);
  });

  test("record routes reject non-uuid ids and honor the feature flag", async () => {
    reset();
    const badCtx = { params: Promise.resolve({ id: "nope" }) };
    assert.equal((await idRoute!.GET(new Request("http://openbooks.test/x"), badCtx)).status, 400);
    assert.equal((await submitRoute!.POST(new Request("http://openbooks.test/x", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), badCtx)).status, 400);
    assert.deepEqual(routeState.calls, []);
    routeState.featureOn = false;
    assert.equal((await idRoute!.GET(new Request("http://openbooks.test/x"), ctx)).status, 404);
    assert.equal((await withdrawRoute!.POST(new Request("http://openbooks.test/x", { method: "POST" }), ctx)).status, 404);
    assert.deepEqual(routeState.calls, []);
  });

  test("patch forwards the payload and maps refusals", async () => {
    reset();
    const payload = { kind: "hire", effectiveFrom: "2026-09-01" };
    const response = await idRoute!.PATCH(
      new Request("http://openbooks.test/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload }),
      }),
      ctx,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(routeState.calls, [
      { fn: "patch", args: { orgId: "org-1", actorId: "user-1", requestId: REQUEST_ID, payload } },
    ]);
    const refusal = new Error("frozen");
    routeState.serviceThrow = refusal;
    const mapped = await idRoute!.PATCH(
      new Request("http://openbooks.test/x", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload }),
      }),
      ctx,
    );
    assert.equal(mapped.status, 409);
    assert.deepEqual(routeState.mapped, [refusal]);
  });

  test("submit forwards the reason; withdraw needs no body", async () => {
    reset();
    const submitted = await submitRoute!.POST(
      new Request("http://openbooks.test/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "go" }),
      }),
      ctx,
    );
    assert.equal(submitted.status, 200);
    assert.deepEqual(await submitted.json(), { request: { id: REQUEST_ID, status: "pending_approval" } });
    assert.deepEqual(routeState.calls, [
      { fn: "submit", args: { orgId: "org-1", actorId: "user-1", requestId: REQUEST_ID, reason: "go" } },
    ]);
    const withdrawn = await withdrawRoute!.POST(new Request("http://openbooks.test/x", { method: "POST" }), ctx);
    assert.equal(withdrawn.status, 200);
    assert.deepEqual(await withdrawn.json(), { request: { id: REQUEST_ID, status: "withdrawn" } });
  });
}
