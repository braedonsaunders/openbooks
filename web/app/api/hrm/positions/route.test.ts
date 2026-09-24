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

const stateKey = Symbol.for("openbooks.hrm-positions-route-test");
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
      const state = globalThis[Symbol.for('openbooks.hrm-positions-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.position.read' && permission !== 'hrm.position.manage') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmPositionsRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-positions-route-test')]
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
      const state = globalThis[Symbol.for('openbooks.hrm-positions-route-test')]
      export async function createPosition(args) {
        state.calls.push({ fn: 'create', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'position-1', positionCode: 'ENG-1042' }
      }
      export async function getVacancyAsOf(args) {
        state.calls.push({ fn: 'vacancy', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { totals: { positions: 0 } }
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-positions-route-test')]
      const NextResponse = globalThis.openbooksHrmPositionsRouteNextResponse
      export function positionErrorResponse(error) {
        state.mapped.push({ error })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmPositionsRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/positions.ts", "mock:service"],
  ["@openbooks/engine/src/hrm/positions-read.ts", "mock:service"],
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
  const routeUrl = "./route.ts?hrm-positions-collection";
  collectionRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const SUBSIDIARY_ID = "00000000-0000-4000-8000-000000000021";

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
  routeState.mapped = [];
}

function postRequest(body: unknown): Request {
  return new Request("http://openbooks.test/api/hrm/positions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a missing feature flag 404s before the service runs", async () => {
  reset();
  routeState.featureOn = false;
  const get = await collectionRoute!.GET(
    new Request("http://openbooks.test/api/hrm/positions"),
  );
  assert.equal(get.status, 404);
  assert.deepEqual(routeState.calls, []);
  const post = await collectionRoute!.POST(postRequest({ positionCode: "X" }));
  assert.equal(post.status, 404);
  assert.deepEqual(routeState.calls, []);
});

test("an unauthenticated caller never reaches the service", async () => {
  reset();
  routeState.gate = { status: 401 };
  const response = await collectionRoute!.POST(postRequest({ positionCode: "X" }));
  assert.equal(response.status, 401);
  assert.deepEqual(routeState.calls, []);
});

test("create validates the body through the real parser before the service runs", async () => {
  reset();
  assert.equal((await collectionRoute!.POST(postRequest({ title: "T" }))).status, 400);
  assert.equal(
    (await collectionRoute!.POST(postRequest({ positionCode: "X", title: "T" }))).status,
    400,
  );
  assert.equal(
    (
      await collectionRoute!.POST(
        postRequest({
          positionCode: "ENG-1042",
          title: "Engineer",
          employerSubsidiaryId: "nope",
          effectiveFrom: "2026-07-01",
          reason: "open",
        }),
      )
    ).status,
    400,
  );
  assert.deepEqual(routeState.calls, []);
});

test("create forwards org, actor, and body, then 201s", async () => {
  reset();
  const body = {
    positionCode: "ENG-1042",
    title: "Engineer",
    employerSubsidiaryId: SUBSIDIARY_ID,
    effectiveFrom: "2026-07-01",
    reason: "open the establishment",
  };
  const response = await collectionRoute!.POST(postRequest(body));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { position: { id: "position-1", positionCode: "ENG-1042" } });
  assert.deepEqual(routeState.calls, [
    {
      fn: "create",
      args: {
        orgId: "org-1",
        actorId: "user-1",
        positionCode: "ENG-1042",
        title: "Engineer",
        departmentId: undefined,
        locationId: undefined,
        employerSubsidiaryId: SUBSIDIARY_ID,
        jobGrade: undefined,
        plannedFte: undefined,
        status: undefined,
        effectiveFrom: "2026-07-01",
        effectiveTo: undefined,
        reason: "open the establishment",
      },
    },
  ]);
});

test("a service refusal delegates to the shared mapping with the error intact", async () => {
  reset();
  const refusal = new Error("position ENG-1042 is still held — unassign first");
  routeState.serviceThrow = refusal;
  const response = await collectionRoute!.POST(
    postRequest({
      positionCode: "ENG-1042",
      title: "Engineer",
      employerSubsidiaryId: SUBSIDIARY_ID,
      effectiveFrom: "2026-07-01",
      reason: "open",
    }),
  );
  assert.equal(response.status, 409);
  assert.equal(routeState.mapped.length, 1);
  assert.equal(routeState.mapped[0]!.error, refusal);
});

test("vacancy rejects bad dates and unknown statuses before the service runs", async () => {
  reset();
  assert.equal(
    (await collectionRoute!.GET(new Request("http://openbooks.test/api/hrm/positions?effectiveDate=nope"))).status,
    400,
  );
  assert.equal(
    (await collectionRoute!.GET(new Request("http://openbooks.test/api/hrm/positions?effectiveDate=2026-07-15&status=draft"))).status,
    400,
  );
  assert.deepEqual(routeState.calls, []);
});

test("vacancy forwards org, actor, date, and status to the read service", async () => {
  reset();
  const response = await collectionRoute!.GET(
    new Request("http://openbooks.test/api/hrm/positions?effectiveDate=2026-07-15&status=open"),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { vacancy: { totals: { positions: 0 } } });
  assert.equal(routeState.calls.length, 1);
  assert.equal(routeState.calls[0]!.fn, "vacancy");
  const args = routeState.calls[0]!.args as Record<string, unknown>;
  assert.equal(args.orgId, "org-1");
  assert.equal(args.actorId, "user-1");
  assert.equal(args.effectiveDate, "2026-07-15");
  assert.equal(args.status, "open");
  assert.match(args.knownAt as string, /^\d{4}-\d{2}-\d{2}T/);
});
