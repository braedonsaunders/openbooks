import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { BenefitsError } from "@openbooks/engine/src/hrm/benefits/errors.ts";

/**
 * Enrollment lifecycle boundary: approve, change, end, and cancel ride one
 * PATCH with a discriminated action. The REAL parser pins each action's
 * fields; refusals map through the REAL _lib.
 */

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-benefits-enrollment-id-route-test");
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

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-enrollment-id-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.benefits.manage') throw new Error('unexpected permission ' + permission)
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmBenefitsEnrollmentIdRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-enrollment-id-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-enrollment-id-route-test')]
      const record = (fn, args) => {
        state.calls.push({ fn, args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.enrollmentId, status: fn }
      }
      export async function approveEnrollment(args) { return record('approved', args) }
      export async function changeEnrollment(args) { return record('changed', args) }
      export async function endEnrollment(args) { return record('ended', args) }
      export async function cancelEnrollment(args) { return record('cancelled', args) }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmBenefitsEnrollmentIdRouteNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/benefits/enrollments.ts", "mock:service"],
]);

let idRoute: typeof import("./route.ts") | undefined;
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
  const routeUrl = "./route.ts?hrm-benefits-enrollment-id";
  idRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const ENROLLMENT_ID = "00000000-0000-4000-8000-000000000051";
const ctx = { params: Promise.resolve({ id: ENROLLMENT_ID }) };

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
}

function patchRequest(body: unknown): Request {
  return new Request("http://x/api/hrm/enrollments/x", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("PATCH approves through the real parser", async () => {
  reset();
  const res = await idRoute!.PATCH(patchRequest({ action: "approve" }), ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(routeState.calls[0], {
    fn: "approved",
    args: { orgId: "org-1", actorId: "user-1", enrollmentId: ENROLLMENT_ID },
  });
});

test("PATCH changes with date, tier, and reason", async () => {
  reset();
  const res = await idRoute!.PATCH(
    patchRequest({ action: "change", changeDate: "2026-04-01", coverageLevelKey: "family", reason: "new child" }),
    ctx,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(routeState.calls[0], {
    fn: "changed",
    args: {
      orgId: "org-1",
      actorId: "user-1",
      enrollmentId: ENROLLMENT_ID,
      changeDate: "2026-04-01",
      coverageLevelKey: "family",
      reason: "new child",
    },
  });
});

test("PATCH ends and cancels with reasons", async () => {
  reset();
  const ended = await idRoute!.PATCH(patchRequest({ action: "end", endedOn: "2026-06-15", reason: "left plan" }), ctx);
  assert.equal(ended.status, 200);
  assert.deepEqual(routeState.calls[0]!.fn, "ended");
  reset();
  const cancelled = await idRoute!.PATCH(patchRequest({ action: "cancel", reason: "withdrew" }), ctx);
  assert.equal(cancelled.status, 200);
  assert.deepEqual(routeState.calls[0]!.fn, "cancelled");
});

test("PATCH refuses reason-less and dateless bodies with 400", async () => {
  reset();
  assert.equal((await idRoute!.PATCH(patchRequest({ action: "end", reason: "  " }), ctx)).status, 400);
  assert.equal((await idRoute!.PATCH(patchRequest({ action: "change", reason: "x" }), ctx)).status, 400);
  assert.equal((await idRoute!.PATCH(patchRequest({ action: "frobnicate" }), ctx)).status, 400);
  assert.equal(routeState.calls.length, 0, "the service never runs on a rejected boundary");
});

test("PATCH maps a bad-state cancel to 409 with message intact", async () => {
  reset();
  routeState.serviceThrow = new BenefitsError(
    "BAD_STATE",
    "enrolment is active — only a not-yet-active enrolment is cancelled; end an active one",
  );
  const refused = await idRoute!.PATCH(patchRequest({ action: "cancel", reason: "oops" }), ctx);
  assert.equal(refused.status, 409);
  const body = (await refused.json()) as { error: string };
  assert.match(body.error, /end an active one/);
});
