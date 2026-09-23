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

const stateKey = Symbol.for("openbooks.hrm-exit-item-route-test");
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
      const state = globalThis[Symbol.for('openbooks.hrm-exit-item-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.retention.read' && permission !== 'hrm.performance.manage') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmExitItemRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-exit-item-route-test')]
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
      const state = globalThis[Symbol.for('openbooks.hrm-exit-item-route-test')]
      export async function getExitRecord(args) {
        state.calls.push({ fn: 'detail', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.exitId }
      }
      export async function updateExitRecord(args) {
        state.calls.push({ fn: 'update', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.exitId }
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-exit-item-route-test')]
      const NextResponse = globalThis.openbooksHrmExitItemRouteNextResponse
      export function performanceErrorResponse(error) {
        state.mapped.push({ error })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmExitItemRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["../../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/performance/exits.ts", "mock:service"],
  ["../../review-cycles/_lib", "mock:lib"],
]);

let itemRoute: typeof import("./route.ts") | undefined;
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
  const routeUrl = "./route.ts?hrm-exit-item";
  itemRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const EXIT_ID = "00000000-0000-4000-8000-000000000091";
const params = { params: Promise.resolve({ id: EXIT_ID }) };

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
  routeState.mapped = [];
}

function patchRequest(body: unknown): Request {
  return new Request(`http://openbooks.test/api/hrm/exit-records/${EXIT_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

if (isVitest) {
  test("exit item route gates reads on retention and writes on manage", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    assert.match(source, /guardPermission\("hrm\.retention\.read"\)/);
    assert.match(source, /guardPermission\("hrm\.performance\.manage"\)/);
  });
} else {
  test("an unknown id never reaches the service", async () => {
    reset();
    const bad = { params: Promise.resolve({ id: "nope" }) };
    assert.equal((await itemRoute!.GET(new Request("http://openbooks.test/x"), bad)).status, 400);
    assert.equal((await itemRoute!.PATCH(patchRequest({ reasonKind: "resignation" }), bad)).status, 400);
    assert.deepEqual(routeState.calls, []);
  });

  test("detail resolves through the retention gate", async () => {
    reset();
    const response = await itemRoute!.GET(new Request("http://openbooks.test/x"), params);
    assert.equal(response.status, 200);
    assert.deepEqual(routeState.calls, [
      { fn: "detail", args: { orgId: "org-1", actorId: "user-1", exitId: EXIT_ID } },
    ]);
  });

  test("correction forwards the revision with only the supplied fields", async () => {
    reset();
    const response = await itemRoute!.PATCH(
      patchRequest({ expectedRevision: 3, wouldRehire: true, notes: "missed" }),
      params,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(routeState.calls, [
      {
        fn: "update",
        args: {
          orgId: "org-1",
          actorId: "user-1",
          exitId: EXIT_ID,
          expectedRevision: 3,
          wouldRehire: true,
          notes: "missed",
        },
      },
    ]);
  });

  test("a correction without the read revision never reaches the service", async () => {
    reset();
    const response = await itemRoute!.PATCH(patchRequest({ notes: "missed" }), params);
    assert.equal(response.status, 400);
    assert.deepEqual(routeState.calls, []);
  });

  test("corrections refuse hostile payloads at the real boundary", async () => {
    reset();
    for (const body of ["{not json", "null", "[1,2]", '"text"', "42"]) {
      const refused = await itemRoute!.PATCH(
        new Request(`http://openbooks.test/api/hrm/exit-records/${EXIT_ID}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body,
        }),
        params,
      );
      assert.equal(refused.status, 400, `boundary accepted hostile payload: ${body}`);
    }
    assert.deepEqual(routeState.calls, []);
  });

  test("a service refusal delegates to the shared mapping with the error intact", async () => {
    reset();
    const refusal = new Error("exit interview needs both the held date and the interviewer");
    routeState.serviceThrow = refusal;
    const response = await itemRoute!.PATCH(
      patchRequest({ expectedRevision: 1, interviewHeldOn: "2026-07-01" }),
      params,
    );
    assert.equal(response.status, 409);
    assert.equal(routeState.mapped[0]!.error, refusal);
  });
}
