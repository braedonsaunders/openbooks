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

const stateKey = Symbol.for("openbooks.hrm-exit-records-route-test");
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
      const state = globalThis[Symbol.for('openbooks.hrm-exit-records-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.retention.read' && permission !== 'hrm.performance.manage') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmExitRecordsRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-exit-records-route-test')]
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
      const state = globalThis[Symbol.for('openbooks.hrm-exit-records-route-test')]
      export async function listExitRecords(args) {
        state.calls.push({ fn: 'list', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ id: 'exit-1' }]
      }
      export async function recordExit(args) {
        state.calls.push({ fn: 'record', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'exit-1' }
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-exit-records-route-test')]
      const NextResponse = globalThis.openbooksHrmExitRecordsRouteNextResponse
      export function performanceErrorResponse(error) {
        state.mapped.push({ error })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmExitRecordsRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/performance/exits.ts", "mock:service"],
  ["../review-cycles/_lib", "mock:lib"],
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
  const routeUrl = "./route.ts?hrm-exit-records-collection";
  collectionRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const EMPLOYMENT_ID = "00000000-0000-4000-8000-000000000081";

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
  routeState.mapped = [];
}

function postRequest(body: unknown): Request {
  return new Request("http://openbooks.test/api/hrm/exit-records", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

if (isVitest) {
  test("exit records gate reads on retention and writes on manage", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    assert.match(source, /guardPermission\("hrm\.retention\.read"\)/);
    assert.match(source, /guardPermission\("hrm\.performance\.manage"\)/);
  });
} else {
  test("listing reads through the retention gate and narrows by employment", async () => {
    reset();
    const response = await collectionRoute!.GET(
      new Request(`http://openbooks.test/api/hrm/exit-records?employmentId=${EMPLOYMENT_ID}`),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(routeState.calls, [
      { fn: "list", args: { orgId: "org-1", actorId: "user-1", employmentId: EMPLOYMENT_ID } },
    ]);
  });

  test("recording validates the body through the real parser before the service runs", async () => {
    reset();
    assert.equal((await collectionRoute!.POST(postRequest({ employmentId: EMPLOYMENT_ID }))).status, 400);
    // Interview date without interviewer passes the boundary (the service
    // refuses the unpaired interview by name); a bad reason does not.
    assert.equal(
      (
        await collectionRoute!.POST(
          postRequest({ employmentId: EMPLOYMENT_ID, reasonKind: "fired", isVoluntary: false }),
        )
      ).status,
      400,
    );
    assert.deepEqual(routeState.calls, []);
  });

  test("record routes refuse hostile payloads at the real boundary", async () => {
    reset();
    for (const body of ["{not json", "null", "[1,2]", '"text"', "42"]) {
      const refused = await collectionRoute!.POST(
        new Request("http://openbooks.test/api/hrm/exit-records", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        }),
      );
      assert.equal(refused.status, 400, `boundary accepted hostile payload: ${body}`);
    }
    assert.deepEqual(routeState.calls, []);
  });

  test("record forwards org, actor, and body, then 201s", async () => {
    reset();
    const response = await collectionRoute!.POST(
      postRequest({ employmentId: EMPLOYMENT_ID, reasonKind: "resignation", isVoluntary: true }),
    );
    assert.equal(response.status, 201);
    assert.equal(routeState.calls[0]!.fn, "record");
    const args = routeState.calls[0]!.args as Record<string, unknown>;
    assert.equal(args.orgId, "org-1");
    assert.equal(args.actorId, "user-1");
    assert.equal(args.employmentId, EMPLOYMENT_ID);
    assert.equal(args.reasonKind, "resignation");
  });

  test("a service refusal delegates to the shared mapping with the error intact", async () => {
    reset();
    const refusal = new Error("employment is active, not terminated");
    routeState.serviceThrow = refusal;
    const response = await collectionRoute!.POST(
      postRequest({ employmentId: EMPLOYMENT_ID, reasonKind: "resignation", isVoluntary: true }),
    );
    assert.equal(response.status, 409);
    assert.equal(routeState.mapped[0]!.error, refusal);
  });
}
