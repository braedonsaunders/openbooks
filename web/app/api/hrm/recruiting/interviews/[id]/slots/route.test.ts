import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  features: Record<string, boolean>;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
  mapped: Array<{ error: unknown }>;
}

const stateKey = Symbol.for("openbooks.hrm-recruiting-slots-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

const routeState: RouteState = {
  gate: { user: { id: "user-1", orgId: "org-1" } },
  features: { hrm: true, hrmRecruiting: true, hrmInterviewScheduling: true },
  calls: [],
  serviceThrow: null,
  mapped: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-slots-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.recruiting.manage') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmRecruitingSlotsNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-slots-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (!(key in state.features)) throw new Error('unexpected feature ' + key)
        return state.features[key]
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-slots-route-test')]
      export async function proposeSlots(args) {
        state.calls.push({ fn: 'propose', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { slots: [{ id: 'slot-1' }], bookingUrlPath: '/book/token', expiresAt: '2027-10-01T00:00:00Z' }
      }
      export async function listInterviewSlots(args) {
        state.calls.push({ fn: 'list', args })
        if (state.serviceThrow) throw state.serviceThrow
        return []
      }
    `,
  ],
  [
    "mock:lib",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-recruiting-slots-route-test')]
      const NextResponse = globalThis.openbooksHrmRecruitingSlotsNextResponse
      export function recruitingErrorResponse(error) {
        state.mapped.push({ error })
        return NextResponse.json({ error: String((error && error.message) || error) }, { status: 409 })
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmRecruitingSlotsNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../../../lib/authz", "mock:authz"],
  ["../../../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/recruiting/scheduling.ts", "mock:service"],
  ["../../../_lib", "mock:lib"],
]);

let slotsRoute: typeof import("./route.ts") | undefined;
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
  const slotsUrl = "./route.ts?hrm-recruiting-slots";
  slotsRoute = (await import(slotsUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const INTERVIEW_ID = "00000000-0000-4000-8000-000000000041";

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.features = { hrm: true, hrmRecruiting: true, hrmInterviewScheduling: true };
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

function params() {
  return { params: Promise.resolve({ id: INTERVIEW_ID }) };
}

if (isVitest) {
  test("slots routes gate on the scheduling switch and the manage grant", async () => {
    const { readFileSync } = await import("node:fs");
    assert.match(readFileSync(new URL("./route.ts", import.meta.url), "utf8"), /guardPermission\("hrm\.recruiting\.manage"\)/);
    assert.match(readFileSync(new URL("./route.ts", import.meta.url), "utf8"), /hrmInterviewScheduling/);
    assert.match(readFileSync(new URL("./bodies.ts", import.meta.url), "utf8"), /poolId/);
  });
} else {
  test("a switched-off scheduling surface 404s before the service runs", async () => {
    reset();
    routeState.features.hrmInterviewScheduling = false;
    assert.equal(
      (await slotsRoute!.POST(jsonRequest("http://openbooks.test/x", "POST", { poolId: "pool-1" }), params())).status,
      404,
    );
    assert.deepEqual(routeState.calls, []);
  });

  test("propose forwards the pool id when windows ride a pool", async () => {
    reset();
    const response = await slotsRoute!.POST(
      jsonRequest("http://openbooks.test/x", "POST", { poolId: "pool-1" }),
      params(),
    );
    assert.equal(response.status, 201);
    assert.equal(routeState.calls[0]!.fn, "propose");
    const args = routeState.calls[0]!.args as Record<string, unknown>;
    assert.equal(args.poolId, "pool-1");
    assert.equal(args.windows, undefined);
    assert.equal(args.interviewId, INTERVIEW_ID);
  });

  test("propose forwards explicit windows unchanged", async () => {
    reset();
    const windows = [{ startsAt: "2027-10-01T09:00:00Z", endsAt: "2027-10-01T09:30:00Z", timezone: "America/Toronto" }];
    const response = await slotsRoute!.POST(
      jsonRequest("http://openbooks.test/x", "POST", { windows }),
      params(),
    );
    assert.equal(response.status, 201);
    assert.deepEqual((routeState.calls[0]!.args as Record<string, unknown>).windows, windows);
  });

  test("a service refusal delegates to the shared mapping with the error intact", async () => {
    reset();
    const refusal = new Error("propose at least one availability window or name an interviewer pool");
    routeState.serviceThrow = refusal;
    const response = await slotsRoute!.POST(
      jsonRequest("http://openbooks.test/x", "POST", {}),
      params(),
    );
    assert.equal(response.status, 409);
    assert.equal(routeState.mapped[0]!.error, refusal);
    // The error body is checked before it is parsed: the refusal arrives as
    // JSON with an error member, never a parse failure.
    assert.match(String((await response.json()).error), /availability window/);
  });
}
