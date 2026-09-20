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

const stateKey = Symbol.for("openbooks.hrm-recruiting-requisitions-route-test");
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

function gateMock(allowed: string[]): string {
  return `
    const state = globalThis[Symbol.for('openbooks.hrm-recruiting-requisitions-route-test')]
    export async function guardPermission(permission) {
      if (!${JSON.stringify(allowed)}.includes(permission)) {
        throw new Error('unexpected permission ' + permission)
      }
      if (state.gate && 'status' in state.gate) {
        const NextResponse = globalThis.openbooksHrmRecruitingRequisitionsNextResponse
        return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
      }
      return state.gate
    }
  `;
}

const mockSources = new Map<string, string>([
  ["mock:authz", gateMock(["hrm.recruiting.read", "hrm.recruiting.manage"])],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-requisitions-route-test')]
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
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-requisitions-route-test')]
      export async function createRequisition(args) {
        state.calls.push({ fn: 'create', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'requisition-1', requisitionNumber: 'REQ-00001' }
      }
      export async function openRequisition(args) {
        state.calls.push({ fn: 'open', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.requisitionId, status: 'open' }
      }
      export async function holdRequisition(args) {
        state.calls.push({ fn: 'hold', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.requisitionId, status: 'on_hold' }
      }
      export async function resumeRequisition(args) {
        state.calls.push({ fn: 'resume', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.requisitionId, status: 'open' }
      }
      export async function cancelRequisition(args) {
        state.calls.push({ fn: 'cancel', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.requisitionId, status: 'cancelled' }
      }
      export async function listRequisitions(args) {
        state.calls.push({ fn: 'list', args })
        if (state.serviceThrow) throw state.serviceThrow
        return []
      }
      export async function getRequisitionDetail(args) {
        state.calls.push({ fn: 'get', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.requisitionId }
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-requisitions-route-test')]
      const NextResponse = globalThis.openbooksHrmRecruitingRequisitionsNextResponse
      export function recruitingErrorResponse(error) {
        state.mapped.push({ error })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmRecruitingRequisitionsNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["../../../../../../lib/authz", "mock:authz"],
  ["../../../../../../lib/features", "mock:features"],
  ["../../../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/recruiting/requisitions.ts", "mock:service"],
  ["@openbooks/engine/src/hrm/recruiting/recruiting-read.ts", "mock:service"],
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
  const collectionUrl = "./route.ts?hrm-recruiting-requisitions-collection";
  collectionRoute = (await import(collectionUrl)) as typeof import("./route.ts");
  const itemUrl = "./[id]/route.ts?hrm-recruiting-requisitions-item";
  itemRoute = (await import(itemUrl)) as typeof import("./[id]/route.ts");
  hooks.deregister();
}

const SUBSIDIARY_ID = "00000000-0000-4000-8000-000000000021";
const REQUISITION_ID = "00000000-0000-4000-8000-000000000022";

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

const paramsOf = (id: string): { params: Promise<{ id: string }> } => ({ params: Promise.resolve({ id }) });

if (isVitest) {
  test("collection route gates on the hrm feature and the recruiting permissions", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    assert.match(source, /guardPermission\("hrm\.recruiting\.manage"\)/);
    assert.match(source, /guardPermission\("hrm\.recruiting\.read"\)/);
    assert.match(source, /isFeatureEnabled\(gate\.user\.orgId, "hrm"\)/);
  });
} else {
  test("a missing feature flag 404s before the service runs", async () => {
    reset();
    routeState.featureOn = false;
    assert.equal((await collectionRoute!.GET(new Request("http://openbooks.test/api/hrm/recruiting/requisitions"))).status, 404);
    assert.equal((await collectionRoute!.POST(jsonRequest("http://openbooks.test/api/hrm/recruiting/requisitions", "POST", {}))).status, 404);
    assert.equal((await itemRoute!.GET(new Request("http://openbooks.test/x"), paramsOf(REQUISITION_ID))).status, 404);
    assert.deepEqual(routeState.calls, []);
  });

  test("an unauthenticated caller never reaches the service", async () => {
    reset();
    routeState.gate = { status: 401 };
    assert.equal((await collectionRoute!.POST(jsonRequest("http://openbooks.test/api/hrm/recruiting/requisitions", "POST", {}))).status, 401);
    assert.deepEqual(routeState.calls, []);
  });

  test("create validates the body through the real parser before the service runs", async () => {
    reset();
    const url = "http://openbooks.test/api/hrm/recruiting/requisitions";
    assert.equal((await collectionRoute!.POST(jsonRequest(url, "POST", { title: "T" }))).status, 400);
    assert.equal((await collectionRoute!.POST(jsonRequest(url, "POST", { title: "T", employerSubsidiaryId: "nope", headcount: 1 }))).status, 400);
    assert.equal((await collectionRoute!.POST(jsonRequest(url, "POST", { title: "T", employerSubsidiaryId: SUBSIDIARY_ID, headcount: 0 }))).status, 400);
    assert.equal(
      (
        await collectionRoute!.POST(
          jsonRequest(url, "POST", {
            title: "T",
            employerSubsidiaryId: SUBSIDIARY_ID,
            headcount: 1,
            compensation: { min: "1", max: "2", currency: "US", basis: "annual" },
          }),
        )
      ).status,
      400,
    );
    assert.deepEqual(routeState.calls, []);
  });

  test("create forwards org, actor, and body, then 201s", async () => {
    reset();
    const response = await collectionRoute!.POST(
      jsonRequest("http://openbooks.test/api/hrm/recruiting/requisitions", "POST", {
        title: "Backend engineer",
        employerSubsidiaryId: SUBSIDIARY_ID,
        headcount: 2,
      }),
    );
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { requisition: { id: "requisition-1", requisitionNumber: "REQ-00001" } });
    assert.equal(routeState.calls[0]!.fn, "create");
    assert.deepEqual((routeState.calls[0]!.args as Record<string, unknown>).orgId, "org-1");
    assert.deepEqual((routeState.calls[0]!.args as Record<string, unknown>).headcount, 2);
  });

  test("list rejects unknown statuses before the service runs, then lists", async () => {
    reset();
    assert.equal(
      (await collectionRoute!.GET(new Request("http://openbooks.test/api/hrm/recruiting/requisitions?status=archived"))).status,
      400,
    );
    assert.deepEqual(routeState.calls, []);
    const response = await collectionRoute!.GET(
      new Request("http://openbooks.test/api/hrm/recruiting/requisitions?status=open"),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { requisitions: [] });
    assert.deepEqual(routeState.calls, [{ fn: "list", args: { orgId: "org-1", actorId: "user-1", status: "open" } }]);
  });

  test("item PATCH validates the action union through the real parser", async () => {
    reset();
    const badId = await itemRoute!.PATCH(jsonRequest("http://openbooks.test/x", "PATCH", { action: "open" }), paramsOf("nope"));
    assert.equal(badId.status, 400);
    const badAction = await itemRoute!.PATCH(
      jsonRequest("http://openbooks.test/x", "PATCH", { action: " vaporize " }),
      paramsOf(REQUISITION_ID),
    );
    assert.equal(badAction.status, 400);
    const holdNoReason = await itemRoute!.PATCH(
      jsonRequest("http://openbooks.test/x", "PATCH", { action: "hold" }),
      paramsOf(REQUISITION_ID),
    );
    assert.equal(holdNoReason.status, 400);
    assert.deepEqual(routeState.calls, []);
  });

  test("item PATCH dispatches every action with org, actor, and id", async () => {
    reset();
    for (const [action, extra, fn] of [
      ["open", { overEstablishment: true }, "open"],
      ["hold", { reason: "freeze" }, "hold"],
      ["resume", { reason: "lifted" }, "resume"],
      ["cancel", { reason: "cut" }, "cancel"],
    ] as const) {
      routeState.calls = [] as RouteState["calls"];
      const response = await itemRoute!.PATCH(
        jsonRequest("http://openbooks.test/x", "PATCH", { action, ...extra }),
        paramsOf(REQUISITION_ID),
      );
      assert.equal(response.status, 200);
      assert.equal(routeState.calls[0]!.fn, fn);
      assert.deepEqual((routeState.calls[0]!.args as Record<string, unknown>).requisitionId, REQUISITION_ID);
    }
  });

  test("a service refusal delegates to the shared mapping with the error intact", async () => {
    reset();
    const refusal = new Error("the position shows no vacant FTE as of 2026-10-01 — open over establishment explicitly");
    routeState.serviceThrow = refusal;
    const response = await itemRoute!.PATCH(
      jsonRequest("http://openbooks.test/x", "PATCH", { action: "open" }),
      paramsOf(REQUISITION_ID),
    );
    assert.equal(response.status, 409);
    assert.equal(routeState.mapped.length, 1);
    assert.equal(routeState.mapped[0]!.error, refusal);
  });
}
