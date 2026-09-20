import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { BenefitsError } from "@openbooks/engine/src/hrm/benefits/errors.ts";

/**
 * Dependent collection boundary: GET lists one employment's, POST creates.
 * The cross-employment link refusal maps through the REAL _lib.
 */

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-benefits-dependents-route-test");
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
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-dependents-route-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.benefits.read' && permission !== 'hrm.benefits.manage') {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmBenefitsDependentsRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-dependents-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrm') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-dependents-route-test')]
      export async function createDependent(args) {
        state.calls.push({ fn: 'create', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'dependent-1' }
      }
    `,
  ],
  [
    "mock:read",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-benefits-dependents-route-test')]
      export const db = {}
      export async function listDependents(exec, orgId, actorId, employmentId) {
        state.calls.push({ fn: 'list', args: { orgId, actorId, employmentId } })
        if (state.serviceThrow) throw state.serviceThrow
        return [{ id: 'dependent-1' }]
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmBenefitsDependentsRouteNextResponse =
  NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/benefits/dependents.ts", "mock:service"],
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
  const routeUrl = "./route.ts?hrm-benefits-dependents-collection";
  collectionRoute = (await import(routeUrl)) as typeof import("./route.ts");
  hooks.deregister();
}

const EMPLOYMENT_ID = "00000000-0000-4000-8000-000000000061";

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
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

test("GET lists one employment's dependents", async () => {
  reset();
  const res = await collectionRoute!.GET(new Request(`http://x/api/hrm/dependents?employmentId=${EMPLOYMENT_ID}`));
  assert.equal(res.status, 200);
  assert.deepEqual(routeState.calls[0], {
    fn: "list",
    args: { orgId: "org-1", actorId: "user-1", employmentId: EMPLOYMENT_ID },
  });
});

test("GET refuses a missing employment id before the service", async () => {
  reset();
  assert.equal((await collectionRoute!.GET(new Request("http://x/api/hrm/dependents"))).status, 400);
  assert.equal(routeState.calls.length, 0);
});

test("POST creates through the real body parser", async () => {
  reset();
  const res = await collectionRoute!.POST(
    jsonRequest("http://x/api/hrm/dependents", {
      employmentId: EMPLOYMENT_ID,
      relationship: "spouse",
      displayName: "Alex Partner",
    }),
  );
  assert.equal(res.status, 200);
  assert.deepEqual(routeState.calls[0], {
    fn: "create",
    args: {
      orgId: "org-1",
      actorId: "user-1",
      employmentId: EMPLOYMENT_ID,
      relationship: "spouse",
      displayName: "Alex Partner",
      birthDate: null,
    },
  });
});

test("POST refuses an unknown relationship with 400", async () => {
  reset();
  assert.equal(
    (
      await collectionRoute!.POST(
        jsonRequest("http://x/api/hrm/dependents", { employmentId: EMPLOYMENT_ID, relationship: "cousin", displayName: "Sam" }),
      )
    ).status,
    400,
  );
  assert.equal(routeState.calls.length, 0);
});

test("POST maps computed refusals with message intact", async () => {
  reset();
  routeState.serviceThrow = new BenefitsError(
    "REFUSED",
    "Benefits access requires the hrm.benefits.manage permission — ask an administrator to grant it in /admin/roles.",
  );
  const refused = await collectionRoute!.POST(
    jsonRequest("http://x/api/hrm/dependents", { employmentId: EMPLOYMENT_ID, relationship: "child", displayName: "Sam" }),
  );
  assert.equal(refused.status, 422);
  const body = (await refused.json()) as { error: string };
  assert.match(body.error, /hrm\.benefits\.manage/);
});
