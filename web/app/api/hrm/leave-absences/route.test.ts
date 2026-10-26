import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { LeaveError } from "@openbooks/engine/hrm/leave-errors";

/**
 * Absence-record boundary. mock:authz and the service double isolate the
 * route; the JSON boundary (recordAbsenceBody) and the error mapping
 * (_lib) are REAL, so the reason shape and the refusal statuses below
 * exercise the production code path. isUuid is pure and runs as-is.
 */

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  deniedPermissions: string[];
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-leave-absence-route-test");
const test = nodeTest;

const routeState: RouteState = {
  gate: { user: { id: "user-1", orgId: "org-1" } },
  deniedPermissions: [],
  calls: [],
  serviceThrow: null,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-absence-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.leave.manage') {
          throw new Error('unexpected permission ' + permission)
        }
        const NextResponse = globalThis.openbooksHrmLeaveAbsenceRouteNextResponse
        if (state.gate && 'status' in state.gate) {
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        if ((state.deniedPermissions ?? []).includes(permission)) {
          return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
        }
        return state.gate
      }
      export async function isFeatureEnabled(orgId, key) { if (key !== 'hrm') throw new Error('unexpected feature ' + key); return true }
      export async function guardFeaturePermission(permission, feature) { const gate = await guardPermission(permission); if (gate instanceof globalThis.openbooksHrmLeaveAbsenceRouteNextResponse) return gate; return await isFeatureEnabled(gate.user.orgId, feature) ? gate : globalThis.openbooksHrmLeaveAbsenceRouteNextResponse.json({ error: 'not found' }, { status: 404 }) }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-absence-route-test')]
      export async function recordAbsence(args) {
        state.calls.push({ fn: 'record', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'absence-1', employmentId: args.employmentId, onDate: args.onDate, hours: args.hours, leaveTypeCode: 'VAC', source: 'recorded', reason: args.reason ?? null }
      }
    `,
  ],
]);

(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksHrmLeaveAbsenceRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["@/lib/feature-gates", "mock:authz"],
  ["@openbooks/engine/hrm/attendance", "mock:service"],
]);

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
const absenceRoute: typeof import("./route.ts") | undefined = (await import(
  new URL("./route.ts?hrm-leave-absence", import.meta.url).href
)) as typeof import("./route.ts");
test.after(() => hooks.deregister());

const EMPLOYMENT_ID = "00000000-0000-4000-8000-000000000021";
const TYPE_ID = "00000000-0000-4000-8000-000000000022";

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.deniedPermissions = [];
  routeState.calls = [];
  routeState.serviceThrow = null;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://x/api/hrm/leave-absences", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST forwards the basis to the engine and returns the saved record", async () => {
  reset();
  const res = await absenceRoute!.POST(
    jsonRequest({
      employmentId: EMPLOYMENT_ID,
      leaveTypeId: TYPE_ID,
      onDate: "2026-08-03",
      hours: "8",
      reason: "approved verbally by the owner",
    }),
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { absence: Record<string, unknown> };
  assert.equal(body.absence["id"], "absence-1");
  assert.deepEqual(routeState.calls[0], {
    fn: "record",
    args: {
      orgId: "org-1",
      actorId: "user-1",
      employmentId: EMPLOYMENT_ID,
      onDate: "2026-08-03",
      hours: "8",
      leaveTypeId: TYPE_ID,
      reason: "approved verbally by the owner",
    },
  });
});

test("POST without a basis passes it through — the engine decides the requirement", async () => {
  reset();
  const res = await absenceRoute!.POST(
    jsonRequest({
      employmentId: EMPLOYMENT_ID,
      leaveTypeId: TYPE_ID,
      onDate: "2026-08-03",
      hours: "8",
    }),
  );
  assert.equal(res.status, 200);
  assert.equal((routeState.calls[0]!.args as Record<string, unknown>)["reason"], undefined);
});

test("POST maps the engine basis refusal with message intact — status first, body second", async () => {
  reset();
  routeState.serviceThrow = new LeaveError(
    "INVALID_INPUT",
    "absence 2026-08-03 is back-dated — record the basis in the reason",
  );
  const res = await absenceRoute!.POST(
    jsonRequest({
      employmentId: EMPLOYMENT_ID,
      leaveTypeId: TYPE_ID,
      onDate: "2026-08-03",
      hours: "8",
    }),
  );
  assert.equal(res.status, 400);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /back-dated/);
});

test("POST refuses a malformed body with 400 and never calls the service", async () => {
  reset();
  const res = await absenceRoute!.POST(
    jsonRequest({ employmentId: "nope", leaveTypeId: TYPE_ID, onDate: "2026-08-03", hours: "8" }),
  );
  assert.equal(res.status, 400);
  assert.equal(routeState.calls.length, 0, "the service never runs on a rejected boundary");
});

test("POST without the manage grant is forbidden before the service", async () => {
  reset();
  routeState.deniedPermissions = ["hrm.leave.manage"];
  const res = await absenceRoute!.POST(
    jsonRequest({
      employmentId: EMPLOYMENT_ID,
      leaveTypeId: TYPE_ID,
      onDate: "2026-08-03",
      hours: "8",
      reason: "x",
    }),
  );
  assert.equal(res.status, 403);
  assert.equal(routeState.calls.length, 0, "the service runs only past the boundary");
});
