import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { BenefitsError } from "@openbooks/engine/src/hrm/benefits/errors.ts";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";

/**
 * Enrollment collection boundary: GET lists (employment, mine, filters),
 * POST elects or waives through the REAL discriminated body. The grant
 * follows the action — self-service rides read, on-behalf rides manage.
 */

interface RouteState {
  grants: Set<string>;
  gateStatus: number | null;
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-benefits-enrollments-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;

const routeState: RouteState = {
  grants: new Set(["hrm.benefits.read", "hrm.benefits.manage"]),
  gateStatus: null,
  featureOn: true,
  calls: [],
  serviceThrow: null,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-enrollments-route-test')]
      export async function guardPermission(permission) {
        if (!state.grants.has(permission)) {
          const NextResponse = globalThis.openbooksHrmBenefitsEnrollmentsRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: 403 })
        }
        if (state.gateStatus) {
          const NextResponse = globalThis.openbooksHrmBenefitsEnrollmentsRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gateStatus })
        }
        return { user: { id: 'user-1', orgId: 'org-1' } }
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-enrollments-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-enrollments-route-test')]
      export async function electEnrollment(args) {
        state.calls.push({ fn: 'elect', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'enrollment-1', status: 'active' }
      }
      export async function waiveEnrollment(args) {
        state.calls.push({ fn: 'waive', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'enrollment-2', status: 'waived' }
      }
    `,
  ],
  [
    "mock:read",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-enrollments-route-test')]
      export const db = {}
      export async function listEnrollments(exec, orgId, actorId, filter) {
        state.calls.push({ fn: 'list', args: { orgId, actorId, filter } })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ id: 'enrollment-1' }]
      }
      export async function myEnrollments(exec, orgId, actorId) {
        state.calls.push({ fn: 'mine', args: { orgId, actorId } })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ id: 'enrollment-9' }]
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmBenefitsEnrollmentsRouteNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/benefits/enrollments.ts", "mock:service"],
  ["@openbooks/engine/src/hrm/benefits/benefits-read.ts", "mock:read"],
  ["@openbooks/engine/src/platform/db.ts", "mock:read"],
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
  const routeUrl = "./route.ts?hrm-benefits-enrollments-collection";
  collectionRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const EMPLOYMENT_ID = "00000000-0000-4000-8000-000000000041";
const PLAN_ID = "00000000-0000-4000-8000-000000000042";
const WINDOW_ID = "00000000-0000-4000-8000-000000000043";

function reset(): void {
  routeState.grants = new Set(["hrm.benefits.read", "hrm.benefits.manage"]);
  routeState.gateStatus = null;
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
}

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const electBody = {
  action: "elect",
  employmentId: EMPLOYMENT_ID,
  planId: PLAN_ID,
  windowId: WINDOW_ID,
  effectiveFrom: "2026-03-01",
};

test("GET lists one employment with filter pass-through", async () => {
  reset();
  const res = await collectionRoute!.GET(
    new Request(`http://x/api/hrm/enrollments?employmentId=${EMPLOYMENT_ID}&status=active`),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(routeState.calls[0], {
    fn: "list",
    args: { orgId: "org-1", actorId: "user-1", filter: { employmentId: EMPLOYMENT_ID, status: "active" } },
  });
});

test("GET mine reads the self-service inbox with no caller-supplied worker", async () => {
  reset();
  const res = await collectionRoute!.GET(new Request("http://x/api/hrm/enrollments?employmentId=mine"));
  assert.equal(res.status, 200);
  assert.deepEqual(routeState.calls[0], { fn: "mine", args: { orgId: "org-1", actorId: "user-1" } });
});

test("GET refuses unknown status and non-uuid ids before the service", async () => {
  reset();
  assert.equal(
    (await collectionRoute!.GET(new Request(`http://x/api/hrm/enrollments?employmentId=${EMPLOYMENT_ID}&status=taken`))).status,
    400,
  );
  assert.equal((await collectionRoute!.GET(new Request("http://x/api/hrm/enrollments?employmentId=nope"))).status, 400);
  assert.equal(routeState.calls.length, 0, "the service never runs on a rejected boundary");
});

test("POST elects on-behalf with the manage grant", async () => {
  reset();
  const res = await collectionRoute!.POST(jsonRequest("http://x/api/hrm/enrollments", electBody));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { enrollment: { id: string } };
  assert.equal(body.enrollment.id, "enrollment-1");
  assert.deepEqual(routeState.calls[0]!.fn, "elect");
});

test("POST elects self-service with the read grant alone", async () => {
  reset();
  routeState.grants = new Set(["hrm.benefits.read"]);
  const res = await collectionRoute!.POST(
    jsonRequest("http://x/api/hrm/enrollments", { ...electBody, selfService: true }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual((routeState.calls[0]!.args as { selfService: boolean }).selfService, true);
});

test("POST waives through the discriminated body", async () => {
  reset();
  const res = await collectionRoute!.POST(
    jsonRequest("http://x/api/hrm/enrollments", {
      action: "waive",
      employmentId: EMPLOYMENT_ID,
      planId: PLAN_ID,
      windowId: WINDOW_ID,
      effectiveFrom: "2026-03-01",
      reason: "covered by spouse",
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(routeState.calls[0]!.fn, "waive");
});

test("POST refuses a malformed body with 400 and never calls the service", async () => {
  reset();
  assert.equal((await collectionRoute!.POST(jsonRequest("http://x/api/hrm/enrollments", "{oops"))).status, 400);
  assert.equal(
    (await collectionRoute!.POST(jsonRequest("http://x/api/hrm/enrollments", { action: "elect" }))).status,
    400,
  );
  assert.equal(routeState.calls.length, 0);
});

test("POST maps the overlap refusal and the self-scope denial", async () => {
  reset();
  routeState.serviceThrow = new BenefitsError(
    "REFUSED",
    "this employment already holds this plan over those dates — change or end the existing enrolment instead of electing twice",
  );
  const refused = await collectionRoute!.POST(jsonRequest("http://x/api/hrm/enrollments", electBody));
  assert.equal(refused.status, 422);
  const body = (await refused.json()) as { error: string };
  assert.match(body.error, /change or end the existing enrolment/);
  reset();
  routeState.serviceThrow = new HrmAuthorizationError(
    "Benefit elections read and elect only against your own employment — ask a manager holding hrm.benefits.manage to act on your behalf.",
  );
  const denied = await collectionRoute!.POST(
    jsonRequest("http://x/api/hrm/enrollments", { ...electBody, selfService: true }),
  );
  assert.equal(denied.status, 403);
});
