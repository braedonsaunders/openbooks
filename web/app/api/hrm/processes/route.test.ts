import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-processes-route-test");
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
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const processesRealUrl = new URL("../../../../../engine/src/hrm/processes.ts", import.meta.url).href;
const processesReadRealUrl = new URL("../../../../../engine/src/hrm/processes-read.ts", import.meta.url).href;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-processes-route-test')]
      export async function guardPermission(permission) {
        if (!permission.startsWith('hrm.process.')) {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmProcessRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-processes-route-test')]
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
    "mock:processes-service",
    `
      // Re-export the real module so error classes keep their identity;
      // only the DB-touching service functions are stubbed (explicit
      // exports win over export *).
      export * from '${processesRealUrl}'
      const state = globalThis[Symbol.for('openbooks.hrm-processes-route-test')]
      export async function openProcess(args) {
        state.calls.push({ fn: 'open', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'process-1', status: 'open' }
      }
      export async function completeProcessStep(args) {
        state.calls.push({ fn: 'completeStep', args })
        if (state.serviceThrow) throw state.serviceThrow
        return undefined
      }
      export async function skipProcessStep(args) {
        state.calls.push({ fn: 'skipStep', args })
        if (state.serviceThrow) throw state.serviceThrow
        return undefined
      }
      export async function completeProcess(args) {
        state.calls.push({ fn: 'completeProcess', args })
        if (state.serviceThrow) throw state.serviceThrow
        return undefined
      }
      export async function cancelProcess(args) {
        state.calls.push({ fn: 'cancelProcess', args })
        if (state.serviceThrow) throw state.serviceThrow
        return undefined
      }
    `,
  ],
  [
    "mock:processes-read-service",
    `
      export * from '${processesReadRealUrl}'
      const state = globalThis[Symbol.for('openbooks.hrm-processes-route-test')]
      export async function listProcesses(args) {
        state.calls.push({ fn: 'list', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ id: 'process-1', status: 'open' }]
      }
      export async function getProcess(args) {
        state.calls.push({ fn: 'get', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'process-1', status: 'open' }
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmProcessRouteNextResponse = NextResponse;

// Every depth the processes routes import at: the collection, the record,
// and the nested action routes each spell the same modules differently.
const authzDepths = [
  "../../../../lib/authz",
  "../../../../../lib/authz",
  "../../../../../../lib/authz",
  "../../../../../../../lib/authz",
];
const featureDepths = [
  "../../../../lib/features",
  "../../../../../lib/features",
  "../../../../../../lib/features",
  "../../../../../../../lib/features",
];
const listParamDepths = [
  "../../../../lib/list-params",
  "../../../../../lib/list-params",
  "../../../../../../lib/list-params",
  "../../../../../../../lib/list-params",
];

const mockUrls = new Map<string, string>([
  ...authzDepths.map((specifier) => [specifier, "mock:authz"] as const),
  ...featureDepths.map((specifier) => [specifier, "mock:features"] as const),
  ...listParamDepths.map((specifier) => [specifier, "mock:list-params"] as const),
  ["@openbooks/engine/src/hrm/processes.ts", "mock:processes-service"],
  ["@openbooks/engine/src/hrm/processes-read.ts", "mock:processes-read-service"],
]);

type RouteModule = Record<
  string,
  ((req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>) | undefined
>;

async function loadRoute(path: string): Promise<RouteModule> {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      // The real JSON boundary is pure (Request + schema → value) and runs
      // as-is; only its server-only marker needs a stand-in outside Next. A
      // test double that cannot produce the refusal is not a test of the
      // refusal, so parseJsonBody is never mocked here.
      if (specifier === "server-only") {
        return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
      }
      // The real error mapping must see the real error classes: _lib.ts
      // keeps its own engine import while every route reads the stubbed
      // service, so instanceof keeps working end to end.
      const parent = (context as { parentURL?: string }).parentURL ?? "";
      if (parent.endsWith("/_lib.ts")) return nextResolve(specifier);
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
  try {
    return (await import(path)) as RouteModule;
  } finally {
    hooks.deregister();
  }
}

let collectionRoute: RouteModule | undefined;
let recordRoute: RouteModule | undefined;
let completeRoute: RouteModule | undefined;
let cancelRoute: RouteModule | undefined;
let stepCompleteRoute: RouteModule | undefined;
let stepSkipRoute: RouteModule | undefined;
if (!isVitest) {
  collectionRoute = await loadRoute("./route.ts?hrm-processes-collection");
  recordRoute = await loadRoute("./[id]/route.ts?hrm-processes-record");
  completeRoute = await loadRoute("./[id]/complete/route.ts?hrm-processes-complete");
  cancelRoute = await loadRoute("./[id]/cancel/route.ts?hrm-processes-cancel");
  stepCompleteRoute = await loadRoute("./steps/[stepId]/complete/route.ts?hrm-processes-step-complete");
  stepSkipRoute = await loadRoute("./steps/[stepId]/skip/route.ts?hrm-processes-step-skip");
}

const EMPLOYMENT_ID = "00000000-0000-4000-8000-000000000021";
const PROCESS_ID = "00000000-0000-4000-8000-000000000022";
const STEP_ID = "00000000-0000-4000-8000-000000000023";
const FILE_ID = "00000000-0000-4000-8000-000000000024";

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ctx(params: Record<string, string>): { params: Promise<Record<string, string>> } {
  return { params: Promise.resolve(params) };
}

function rawRequest(url: string, body: string): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

if (isVitest) {
  test("processes routes gate on the hrm feature and the process permissions", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of [
      "./route.ts",
      "./[id]/route.ts",
      "./[id]/complete/route.ts",
      "./[id]/cancel/route.ts",
      "./steps/[stepId]/complete/route.ts",
      "./steps/[stepId]/skip/route.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      assert.match(source, /guardPermission\("hrm\.process\.(read|manage)"\)/);
      assert.match(source, /isFeatureEnabled\(gate\.user\.orgId, "hrm"\)/);
    }
  });
} else {
  test("a missing feature flag 404s before any service runs", async () => {
    reset();
    routeState.featureOn = false;
    const get = await collectionRoute!.GET!(new Request("http://openbooks.test/api/hrm/processes"));
    assert.equal(get.status, 404);
    const post = await collectionRoute!.POST!(
      jsonRequest("http://openbooks.test/api/hrm/processes", {
        employmentId: EMPLOYMENT_ID,
        kind: "onboarding",
        effectiveDate: "2026-09-01",
      }),
    );
    assert.equal(post.status, 404);
    assert.deepEqual(routeState.calls, []);
  });

  test("an unauthenticated caller never reaches the service", async () => {
    reset();
    routeState.gate = { status: 401 };
    const response = await collectionRoute!.POST!(
      jsonRequest("http://openbooks.test/api/hrm/processes", {
        employmentId: EMPLOYMENT_ID,
        kind: "onboarding",
        effectiveDate: "2026-09-01",
      }),
    );
    assert.equal(response.status, 401);
    assert.deepEqual(routeState.calls, []);
  });

  test("open validates the body through the real parser before the service runs", async () => {
    reset();
    // Missing employmentId, unknown kind, and a non-date are all refused at
    // the boundary — the service never sees them.
    assert.equal(
      (await collectionRoute!.POST!(jsonRequest("http://openbooks.test/api/hrm/processes", {
        kind: "onboarding",
        effectiveDate: "2026-09-01",
      }))).status,
      400,
    );
    assert.equal(
      (await collectionRoute!.POST!(jsonRequest("http://openbooks.test/api/hrm/processes", {
        employmentId: EMPLOYMENT_ID,
        kind: "orientation",
        effectiveDate: "2026-09-01",
      }))).status,
      400,
    );
    assert.equal(
      (await collectionRoute!.POST!(jsonRequest("http://openbooks.test/api/hrm/processes", {
        employmentId: EMPLOYMENT_ID,
        kind: "onboarding",
        effectiveDate: "September",
      }))).status,
      400,
    );
    assert.deepEqual(routeState.calls, []);
  });

  test("open forwards org, actor, employment, kind, and date, then 201s", async () => {
    reset();
    const response = await collectionRoute!.POST!(
      jsonRequest("http://openbooks.test/api/hrm/processes", {
        employmentId: EMPLOYMENT_ID,
        kind: "onboarding",
        effectiveDate: "2026-09-01",
      }),
    );
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { process: { id: "process-1", status: "open" } });
    assert.deepEqual(routeState.calls, [
      {
        fn: "open",
        args: {
          orgId: "org-1",
          actorId: "user-1",
          employmentId: EMPLOYMENT_ID,
          kind: "onboarding",
          effectiveDate: "2026-09-01",
        },
      },
    ]);
  });

  test("list rejects unknown segments and filters nothing server-side", async () => {
    reset();
    const bad = await collectionRoute!.GET!(new Request("http://openbooks.test/api/hrm/processes?segment=someday"));
    assert.equal(bad.status, 400);
    assert.deepEqual(routeState.calls, []);
    const ok = await collectionRoute!.GET!(new Request("http://openbooks.test/api/hrm/processes?segment=overdue"));
    assert.equal(ok.status, 200);
    assert.deepEqual(routeState.calls, [{ fn: "list", args: { orgId: "org-1", actorId: "user-1", segment: "overdue" } }]);
  });

  test("record fetch validates the id before the service runs", async () => {
    reset();
    const bad = await recordRoute!.GET!(new Request("http://openbooks.test/api/hrm/processes/nope"), ctx({ id: "nope" }));
    assert.equal(bad.status, 400);
    assert.deepEqual(routeState.calls, []);
    const ok = await recordRoute!.GET!(
      new Request(`http://openbooks.test/api/hrm/processes/${PROCESS_ID}`),
      ctx({ id: PROCESS_ID }),
    );
    assert.equal(ok.status, 200);
    assert.deepEqual(routeState.calls, [
      { fn: "get", args: { orgId: "org-1", actorId: "user-1", processId: PROCESS_ID } },
    ]);
  });

  test("step complete forwards an optional attachment; skip requires a reason", async () => {
    reset();
    const done = await stepCompleteRoute!.POST!(
      jsonRequest("http://openbooks.test/api/hrm/processes/steps/x/complete", { attachmentId: FILE_ID }),
      ctx({ stepId: STEP_ID }),
    );
    assert.equal(done.status, 200);
    assert.deepEqual(routeState.calls, [
      { fn: "completeStep", args: { orgId: "org-1", actorId: "user-1", stepId: STEP_ID, attachmentId: FILE_ID } },
    ]);
    // A blank skip reason is refused at the boundary with the real parser.
    const blank = await stepSkipRoute!.POST!(
      jsonRequest("http://openbooks.test/api/hrm/processes/steps/x/skip", { reason: "  " }),
      ctx({ stepId: STEP_ID }),
    );
    assert.equal(blank.status, 400);
    assert.equal(routeState.calls.length, 1);
    const skipped = await stepSkipRoute!.POST!(
      jsonRequest("http://openbooks.test/api/hrm/processes/steps/x/skip", { reason: "desk ready" }),
      ctx({ stepId: STEP_ID }),
    );
    assert.equal(skipped.status, 200);
    assert.deepEqual(routeState.calls[1], {
      fn: "skipStep",
      args: { orgId: "org-1", actorId: "user-1", stepId: STEP_ID, reason: "desk ready" },
    });
  });

  test("complete refuses hostile payloads at the real boundary before the service runs", async () => {
    reset();
    // Complete takes no body, but it still parses one: malformed JSON and
    // non-object payloads are refused at the shared boundary — the service
    // never sees them. The parser here is the real parseJsonBody (never
    // mocked above), so this is a test of the refusal, not of a double.
    for (const body of ["{not json", "null", "[1,2]", '"text"', "42"]) {
      const refused = await completeRoute!.POST!(
        rawRequest(`http://openbooks.test/api/hrm/processes/${PROCESS_ID}/complete`, body),
        ctx({ id: PROCESS_ID }),
      );
      assert.equal(refused.status, 400, `boundary accepted hostile payload: ${body}`);
    }
    assert.deepEqual(routeState.calls, []);
    const done = await completeRoute!.POST!(
      jsonRequest(`http://openbooks.test/api/hrm/processes/${PROCESS_ID}/complete`, {}),
      ctx({ id: PROCESS_ID }),
    );
    assert.equal(done.status, 200);
    assert.deepEqual(routeState.calls, [
      { fn: "completeProcess", args: { orgId: "org-1", actorId: "user-1", processId: PROCESS_ID } },
    ]);
  });

  test("complete and cancel reach the service with the record id", async () => {
    reset();
    const done = await completeRoute!.POST!(
      jsonRequest(`http://openbooks.test/api/hrm/processes/${PROCESS_ID}/complete`, {}),
      ctx({ id: PROCESS_ID }),
    );
    assert.equal(done.status, 200);
    const cancelled = await cancelRoute!.POST!(
      jsonRequest(`http://openbooks.test/api/hrm/processes/${PROCESS_ID}/cancel`, { reason: "hire withdrawn" }),
      ctx({ id: PROCESS_ID }),
    );
    assert.equal(cancelled.status, 200);
    assert.deepEqual(routeState.calls, [
      { fn: "completeProcess", args: { orgId: "org-1", actorId: "user-1", processId: PROCESS_ID } },
      { fn: "cancelProcess", args: { orgId: "org-1", actorId: "user-1", processId: PROCESS_ID, reason: "hire withdrawn" } },
    ]);
  });

  test("a service refusal reaches the caller with its message intact", async () => {
    reset();
    const { HrmProcessError } = await import("@openbooks/engine/src/hrm/processes.ts");
    routeState.serviceThrow = new HrmProcessError(
      "DUPLICATE_OPEN",
      "an open onboarding process already exists for this employment — complete or cancel it before opening another",
    );
    const response = await collectionRoute!.POST!(
      jsonRequest("http://openbooks.test/api/hrm/processes", {
        employmentId: EMPLOYMENT_ID,
        kind: "onboarding",
        effectiveDate: "2026-09-01",
      }),
    );
    // 409 names the conflict shape; the body carries the remedy verbatim.
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error:
        "an open onboarding process already exists for this employment — complete or cancel it before opening another",
    });
  });
}
