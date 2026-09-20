import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { BenefitsError } from "@openbooks/engine/src/hrm/benefits/errors.ts";

/**
 * Election dependent-link boundary: link and unlink ride one POST with a
 * discriminated action; the cross-employment refusal maps through the
 * REAL _lib with its remedy intact.
 */

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-benefits-enrollment-links-route-test");
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
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-enrollment-links-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.benefits.manage') throw new Error('unexpected permission ' + permission)
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmBenefitsEnrollmentLinksRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-enrollment-links-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-enrollment-links-route-test')]
      export async function linkDependent(args) {
        state.calls.push({ fn: 'link', args })
        if (state.serviceThrow) throw state.serviceThrow
      }
      export async function unlinkDependent(args) {
        state.calls.push({ fn: 'unlink', args })
        if (state.serviceThrow) throw state.serviceThrow
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmBenefitsEnrollmentLinksRouteNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../../../lib/authz", "mock:authz"],
  ["../../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/benefits/dependents.ts", "mock:service"],
]);

let linksRoute: typeof import("./route.ts") | undefined;
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
  const routeUrl = "./route.ts?hrm-benefits-enrollment-links";
  linksRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const ENROLLMENT_ID = "00000000-0000-4000-8000-000000000091";
const DEPENDENT_ID = "00000000-0000-4000-8000-000000000092";
const ctx = { params: Promise.resolve({ id: ENROLLMENT_ID }) };

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
}

function jsonRequest(body: unknown): Request {
  return new Request("http://x/api/hrm/enrollments/x/dependents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("POST links and unlinks through the discriminated action", async () => {
  reset();
  const linked = await linksRoute!.POST(jsonRequest({ action: "link", dependentId: DEPENDENT_ID }), ctx);
  assert.equal(linked.status, 200);
  assert.deepEqual(routeState.calls[0], {
    fn: "link",
    args: { orgId: "org-1", actorId: "user-1", enrollmentId: ENROLLMENT_ID, dependentId: DEPENDENT_ID },
  });
  reset();
  const unlinked = await linksRoute!.POST(jsonRequest({ action: "unlink", dependentId: DEPENDENT_ID }), ctx);
  assert.equal(unlinked.status, 200);
  assert.deepEqual(routeState.calls[0]!.fn, "unlink");
});

test("POST refuses a non-uuid dependent before the service", async () => {
  reset();
  assert.equal((await linksRoute!.POST(jsonRequest({ action: "link", dependentId: "nope" }), ctx)).status, 400);
  assert.equal(routeState.calls.length, 0);
});

test("POST maps the cross-employment refusal with remedy intact", async () => {
  reset();
  routeState.serviceThrow = new BenefitsError(
    "REFUSED",
    "the dependent belongs to a different employment than the election — cover a worker's own dependents on their own elections",
  );
  const refused = await linksRoute!.POST(jsonRequest({ action: "link", dependentId: DEPENDENT_ID }), ctx);
  assert.equal(refused.status, 422);
  const body = (await refused.json()) as { error: string };
  assert.match(body.error, /their own elections/);
});
