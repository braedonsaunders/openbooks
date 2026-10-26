import assert from "node:assert/strict";
import { canonicalEngineSpecifier } from "../../../../../testing/engine-resolve-hooks.ts";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { LeaveError } from "@openbooks/engine/hrm/leave-errors";

/**
 * Absence-detail boundary behind the calendar entry. Readers and
 * recorders both open it; the engine re-checks the employment. The error
 * mapping (_lib) is REAL; isUuid is pure and runs as-is.
 */

interface RouteState {
  gate: { user: { id: string; orgId: string }; permissions: Set<string> } | { status: number };
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-leave-absence-detail-route-test");
const test = nodeTest;

const routeState: RouteState = {
  gate: { user: { id: "user-1", orgId: "org-1" }, permissions: new Set(["hrm.leave.read"]) },
  calls: [],
  serviceThrow: null,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-absence-detail-route-test')]
      export async function getAuthz() { const gate = state.gate; return gate && 'status' in gate ? null : gate }
      export const can = (authz, perm) => authz.permissions.has('*') || authz.permissions.has(perm);
      export async function guardPermission(permission) {
        const NextResponse = globalThis.openbooksHrmLeaveAbsenceDetailRouteNextResponse
        if (state.gate && 'status' in state.gate) {
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        if (!can(state.gate, permission)) {
          return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
        }
        return state.gate
      }
    `,
  ],
  ["mock:features", `export async function isFeatureEnabled() { return true }`],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-leave-absence-detail-route-test')]
      export async function getAbsence(args) {
        state.calls.push({ fn: 'detail', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.absenceId, onDate: '2026-08-03', hours: '8', leaveTypeCode: 'VAC', source: 'recorded', reason: 'approved verbally by the owner' }
      }
    `,
  ],
]);

(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksHrmLeaveAbsenceDetailRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["@/lib/authz", "mock:authz"],
  ["@/lib/features", "mock:features"],
  ["@/lib/feature-gates", "mock:authz"],
  ["@openbooks/engine/hrm/attendance", "mock:service"],
]);

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    const mocked =
      mockUrls.get(specifier) ?? mockUrls.get(canonicalEngineSpecifier(specifier) ?? "");
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier);
  },
  load(url, _context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url);
  },
});
const detailRoute: typeof import("./route.ts") | undefined = (await import(
  new URL("./route.ts?hrm-leave-absence-detail", import.meta.url).href
)) as typeof import("./route.ts");
test.after(() => hooks.deregister());

const ABSENCE_ID = "00000000-0000-4000-8000-0000000000d1";

function reset(permissions: string[] = ["hrm.leave.read"]): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" }, permissions: new Set(permissions) };
  routeState.calls = [];
  routeState.serviceThrow = null;
}

const ctx = { params: Promise.resolve({ id: ABSENCE_ID }) };

test("GET opens the absence day behind the employment gate", async () => {
  reset();
  const res = await detailRoute!.GET(
    new Request(`http://x/api/hrm/leave-absences/${ABSENCE_ID}`),
    ctx,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as { absence: Record<string, unknown> };
  assert.equal(body.absence["id"], ABSENCE_ID);
  assert.deepEqual(routeState.calls[0], {
    fn: "detail",
    args: { orgId: "org-1", actorId: "user-1", absenceId: ABSENCE_ID },
  });
});

test("GET admits a manage-only recorder through the same drawer", async () => {
  reset(["hrm.leave.manage"]);
  const res = await detailRoute!.GET(
    new Request(`http://x/api/hrm/leave-absences/${ABSENCE_ID}`),
    ctx,
  );
  assert.equal(res.status, 200);
  assert.equal(routeState.calls.length, 1);
});

test("GET refuses a non-uuid id with 400 before the service", async () => {
  reset();
  const res = await detailRoute!.GET(new Request("http://x/api/hrm/leave-absences/nope"), {
    params: Promise.resolve({ id: "nope" }),
  });
  assert.equal(res.status, 400);
  assert.equal(routeState.calls.length, 0, "the service never runs on a rejected boundary");
});

test("GET maps an unknown absence to 404 with the message intact", async () => {
  reset();
  routeState.serviceThrow = new LeaveError(
    "NOT_FOUND",
    "absence not found in this organization — check the absence id",
  );
  const res = await detailRoute!.GET(
    new Request(`http://x/api/hrm/leave-absences/${ABSENCE_ID}`),
    ctx,
  );
  assert.equal(res.status, 404);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /not found/);
});
