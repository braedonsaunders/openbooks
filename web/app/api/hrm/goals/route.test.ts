import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  authz: { user: { id: string; orgId: string } } | null;
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
  mapped: Array<{ error: unknown }>;
}

const stateKey = Symbol.for("openbooks.hrm-goals-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

const routeState: RouteState = {
  authz: { user: { id: "user-1", orgId: "org-1" } },
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
      const state = globalThis[Symbol.for('openbooks.hrm-goals-route-test')]
      export async function getAuthz() {
        return state.authz
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-goals-route-test')]
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
      const state = globalThis[Symbol.for('openbooks.hrm-goals-route-test')]
      export async function createGoal(args) {
        state.calls.push({ fn: 'create', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'goal-1', title: args.title }
      }
    `,
  ],
  [
    "mock:read",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-goals-route-test')]
      export async function listGoals(args) {
        state.calls.push({ fn: 'list', args })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ id: 'goal-1' }]
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-goals-route-test')]
      const NextResponse = globalThis.openbooksHrmGoalsRouteNextResponse
      export function performanceErrorResponse(error) {
        state.mapped.push({ error })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmGoalsRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/performance/goals.ts", "mock:service"],
  ["@openbooks/engine/src/hrm/performance/performance-read.ts", "mock:read"],
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
  const routeUrl = "./route.ts?hrm-goals-collection";
  collectionRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const EMPLOYMENT_ID = "00000000-0000-4000-8000-000000000061";

function reset(): void {
  routeState.authz = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
  routeState.mapped = [];
}

function postRequest(body: unknown): Request {
  return new Request("http://openbooks.test/api/hrm/goals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

if (isVitest) {
  test("goals routes carry identity without a permission shortcut", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    assert.match(source, /getAuthz\(\)/);
    assert.doesNotMatch(source, /guardPermission/);
  });
} else {
  test("list narrows by employment and rejects bad ids before the service runs", async () => {
    reset();
    assert.equal(
      (await collectionRoute!.GET(new Request("http://openbooks.test/api/hrm/goals?employmentId=nope"))).status,
      400,
    );
    assert.deepEqual(routeState.calls, []);
    const narrowed = await collectionRoute!.GET(
      new Request(`http://openbooks.test/api/hrm/goals?employmentId=${EMPLOYMENT_ID}`),
    );
    assert.equal(narrowed.status, 200);
    assert.deepEqual(routeState.calls, [
      { fn: "list", args: { orgId: "org-1", actorId: "user-1", employmentId: EMPLOYMENT_ID } },
    ]);
  });

  test("create validates the body through the real parser before the service runs", async () => {
    reset();
    assert.equal((await collectionRoute!.POST(postRequest({ title: "X" }))).status, 400);
    assert.equal(
      (await collectionRoute!.POST(postRequest({ employmentId: EMPLOYMENT_ID, title: "  ", dueOn: "2030-12-31" }))).status,
      400,
    );
    assert.deepEqual(routeState.calls, []);
  });

  test("create refuses hostile payloads at the real boundary", async () => {
    reset();
    for (const body of ["{not json", "null", "[1,2]", '"text"', "42"]) {
      const refused = await collectionRoute!.POST(
        new Request("http://openbooks.test/api/hrm/goals", {
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
      postRequest({ employmentId: EMPLOYMENT_ID, title: "Ship it", dueOn: "2026-12-31" }),
    );
    assert.equal(response.status, 201);
    assert.deepEqual(routeState.calls[0]!.args, {
      orgId: "org-1",
      actorId: "user-1",
      employmentId: EMPLOYMENT_ID,
      title: "Ship it",
      description: null,
      dueOn: "2026-12-31",
      weight: null,
      cycleId: null,
    });
  });

  test("a service refusal delegates to the shared mapping with the error intact", async () => {
    reset();
    const refusal = new Error("only an active goal takes progress");
    routeState.serviceThrow = refusal;
    const response = await collectionRoute!.GET(new Request("http://openbooks.test/api/hrm/goals"));
    assert.equal(response.status, 409);
    assert.equal(routeState.mapped[0]!.error, refusal);
  });
}
