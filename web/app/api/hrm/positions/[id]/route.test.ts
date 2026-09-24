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

const stateKey = Symbol.for("openbooks.hrm-position-route-test");
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
      const state = globalThis[Symbol.for('openbooks.hrm-position-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.position.read' && permission !== 'hrm.position.manage') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmPositionRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-position-route-test')]
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
      const state = globalThis[Symbol.for('openbooks.hrm-position-route-test')]
      export async function revisePosition(args) {
        state.calls.push({ fn: 'revise', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'position-1' }
      }
      export async function closePosition(args) {
        state.calls.push({ fn: 'close', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'position-1' }
      }
      export async function writePositionFunding(args) {
        state.calls.push({ fn: 'fund', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { funding: { id: 'funding-1' }, preflight: null }
      }
      export async function getPositionAsOf(args) {
        state.calls.push({ fn: 'detail', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'position-1' }
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-position-route-test')]
      const NextResponse = globalThis.openbooksHrmPositionRouteNextResponse
      export function positionErrorResponse(error) {
        state.mapped.push({ error })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmPositionRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["../../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/hrm/positions.ts", "mock:service"],
  ["@openbooks/engine/src/hrm/positions-read.ts", "mock:service"],
  ["../_lib", "mock:lib"],
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
  const routeUrl = "./route.ts?hrm-position-item";
  itemRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const POSITION_ID = "00000000-0000-4000-8000-000000000031";
const PERIOD_ID = "00000000-0000-4000-8000-000000000032";
const params = { params: Promise.resolve({ id: POSITION_ID }) };

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
  routeState.mapped = [];
}

function patchRequest(body: unknown): Request {
  return new Request(`http://openbooks.test/api/hrm/positions/${POSITION_ID}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

if (isVitest) {
  test("item route gates on the hrm feature and the position permissions", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
    assert.match(source, /guardPermission\("hrm\.position\.manage"\)/);
    assert.match(source, /guardPermission\("hrm\.position\.read"\)/);
    assert.match(source, /isFeatureEnabled\(gate\.user\.orgId, "hrm"\)/);
  });
} else {
  test("an unknown id never reaches the service", async () => {
    reset();
    const bad = { params: Promise.resolve({ id: "nope" }) };
    assert.equal((await itemRoute!.GET(new Request("http://openbooks.test/x"), bad)).status, 400);
    assert.equal((await itemRoute!.PATCH(patchRequest({ action: "close" }), bad)).status, 400);
    assert.deepEqual(routeState.calls, []);
  });

  test("detail forwards org, actor, position, and date to the read service", async () => {
    reset();
    const response = await itemRoute!.GET(
      new Request(`http://openbooks.test/api/hrm/positions/${POSITION_ID}?effectiveDate=2026-07-15`),
      params,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { position: { id: "position-1" } });
    assert.equal(routeState.calls.length, 1);
    assert.equal(routeState.calls[0]!.fn, "detail");
    const args = routeState.calls[0]!.args as Record<string, unknown>;
    assert.equal(args.orgId, "org-1");
    assert.equal(args.actorId, "user-1");
    assert.equal(args.positionId, POSITION_ID);
    assert.equal(args.effectiveDate, "2026-07-15");
    assert.match(args.knownAt as string, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("patch validates the action-discriminated body before the service runs", async () => {
    reset();
    assert.equal((await itemRoute!.PATCH(patchRequest({}), params)).status, 400);
    assert.equal((await itemRoute!.PATCH(patchRequest({ action: "revise" }), params)).status, 400);
    assert.equal(
      (await itemRoute!.PATCH(patchRequest({ action: "close" }), params)).status,
      400,
    );
    assert.equal(
      (await itemRoute!.PATCH(patchRequest({ action: "close", effectiveDate: "15-07-2026", reason: "x" }), params)).status,
      400,
    );
    assert.deepEqual(routeState.calls, []);
    assert.deepEqual(routeState.mapped, []);
  });

  test("close forwards position, date, and reason", async () => {
    reset();
    const response = await itemRoute!.PATCH(
      patchRequest({ action: "close", effectiveDate: "2026-07-15", reason: "retire" }),
      params,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(routeState.calls, [
      {
        fn: "close",
        args: {
          orgId: "org-1",
          actorId: "user-1",
          positionId: POSITION_ID,
          effectiveDate: "2026-07-15",
          reason: "retire",
        },
      },
    ]);
  });

  test("fund forwards the plan and returns funding with its preflight", async () => {
    reset();
    const response = await itemRoute!.PATCH(
      patchRequest({ action: "fund", periodId: PERIOD_ID, fundedFte: "1.5000", reason: "plan" }),
      params,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { funding: { id: "funding-1" }, preflight: null });
    assert.deepEqual(routeState.calls, [
      {
        fn: "fund",
        args: {
          orgId: "org-1",
          actorId: "user-1",
          positionId: POSITION_ID,
          periodId: PERIOD_ID,
          fundedFte: "1.5000",
          fundingSourceId: undefined,
          amount: undefined,
          currency: undefined,
          reason: "plan",
        },
      },
    ]);
  });

  test("a service refusal delegates to the shared mapping with the error intact", async () => {
    reset();
    const refusal = new Error("the position changed while the write was applying");
    routeState.serviceThrow = refusal;
    const response = await itemRoute!.PATCH(
      patchRequest({ action: "revise", plannedFte: "2.0000", reason: "grow" }),
      params,
    );
    assert.equal(response.status, 409);
    assert.equal(routeState.mapped.length, 1);
    assert.equal(routeState.mapped[0]!.error, refusal);
  });
}
