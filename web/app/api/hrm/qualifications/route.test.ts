import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { HrmQualificationError } from "@openbooks/engine/src/hrm/qualifications/errors.ts";

/**
 * Qualification route gates (HR-14): the feature-off 404 fires before
 * any service runs, an unauthenticated caller never reaches it, and
 * engine refusals map with their message intact. Module doubles cover
 * only the network boundary (authz, features) and the engine services
 * (DB-owned, covered by the integration file); the zod bodies and the
 * error mapper run as-is.
 */

interface RouteState {
  gate: { user: { id: string; orgId: string } } | { status: number };
  perms: string[];
  featureOn: boolean;
  calls: Array<{ fn: string; args: unknown }>;
  serviceThrow: unknown;
}

const stateKey = Symbol.for("openbooks.hrm-qualifications-route-test");
type TestFn = typeof nodeTest;
const test: TestFn = nodeTest;

const routeState: RouteState = {
  gate: { user: { id: "user-1", orgId: "org-1" } },
  perms: ["hrm.certifications.read", "hrm.certifications.manage", "hrm.self.read"],
  featureOn: true,
  calls: [],
  serviceThrow: null,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-qualifications-route-test')]
      const ALLOWED = ['hrm.certifications.read', 'hrm.certifications.manage', 'hrm.self.read']
      export async function guardPermission(permission) {
        if (!ALLOWED.includes(permission)) {
          throw new Error('unexpected permission ' + permission)
        }
        if (state.gate && 'status' in state.gate) {
          const NextResponse = globalThis.openbooksHrmQualificationsRouteNextResponse
          return NextResponse.json({ error: 'denied' }, { status: state.gate.status })
        }
        // The real gate answers 403 without the grant; the route decides.
        if (!state.perms.includes(permission)) {
          const NextResponse = globalThis.openbooksHrmQualificationsRouteNextResponse
          return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
        }
        return state.gate
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-qualifications-route-test')]
      export async function isFeatureEnabled(orgId, key) {
        if (key !== 'hrmCertifications') throw new Error('unexpected feature ' + key)
        return state.featureOn
      }
    `,
  ],
  [
    "mock:ledger",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-qualifications-route-test')]
      function maybeThrow() {
        if (state.serviceThrow) throw state.serviceThrow
      }
      export async function listQualifications(exec, args) {
        state.calls.push({ fn: 'list', args })
        maybeThrow()
        return []
      }
      export async function recordQualification(exec, args) {
        state.calls.push({ fn: 'record', args })
        maybeThrow()
        return { id: 'q-1' }
      }
      export async function verifyQualification(exec, args) {
        state.calls.push({ fn: 'verify', args })
        maybeThrow()
        return { id: args.qualificationId }
      }
      export async function renewQualification(exec, args) {
        state.calls.push({ fn: 'renew', args })
        maybeThrow()
        return { id: 'q-2' }
      }
      export async function revokeQualification(exec, args) {
        state.calls.push({ fn: 'revoke', args })
        maybeThrow()
        return { id: args.qualificationId }
      }
      export async function attachEvidence(exec, args) {
        state.calls.push({ fn: 'attach', args })
        maybeThrow()
        return { id: args.qualificationId }
      }
    `,
  ],
  [
    "mock:gating",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-qualifications-route-test')]
      export async function checkAssignment(exec, args) {
        state.calls.push({ fn: 'check', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { ok: true, warnings: [] }
      }
    `,
  ],
  [
    "mock:requirements",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-qualifications-route-test')]
      export async function listRequirements(exec, args) {
        state.calls.push({ fn: 'listRequirements', args })
        if (state.serviceThrow) throw state.serviceThrow
        return []
      }
      export async function setRequirement(exec, args) {
        state.calls.push({ fn: 'setRequirement', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 'r-1' }
      }
    `,
  ],
  [
    "mock:db",
    `
      export const db = {}
      export const schema = {}
      export const pool = {}
      export const env = {}
      export function withOrgTransaction(_orgId, work) { return work() }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withBypassContext(_opts, work) { return work() }
      export function registerRequestOrgResolver() {}
      export function currentRequestOrgResolver() { return null }
      export function ambientTenantOrgId() { return null }
    `,
  ],
  [
    "mock:types",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-qualifications-route-test')]
      export async function createQualificationType(exec, args) {
        state.calls.push({ fn: 'createType', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: 't-1' }
      }
      export async function listQualificationTypes(exec, args) {
        state.calls.push({ fn: 'listTypes', args })
        if (state.serviceThrow) throw state.serviceThrow
        return []
      }
      export async function updateQualificationType(exec, args) {
        state.calls.push({ fn: 'updateType', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { id: args.typeId }
      }
      export async function declareCategory(exec, args) {
        state.calls.push({ fn: 'declareCategory', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { extraCategories: [args.category], alertLeadDays: [30, 14, 7, 1] }
      }
      export async function loadSettings(exec, orgId) {
        state.calls.push({ fn: 'loadSettings', args: { orgId } })
        if (state.serviceThrow) throw state.serviceThrow
        return { extraCategories: [], alertLeadDays: [30, 14, 7, 1] }
      }
      export async function setAlertSchedule(exec, args) {
        state.calls.push({ fn: 'setAlertSchedule', args })
        if (state.serviceThrow) throw state.serviceThrow
        return { extraCategories: [], alertLeadDays: args.leadDays }
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmQualificationsRouteNextResponse = NextResponse;

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../../lib/authz", "mock:authz"],
  ["../../../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["../../../../../lib/features", "mock:features"],
  ["../../../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/hrm/qualifications/qualifications.ts", "mock:ledger"],
  ["@openbooks/engine/src/hrm/qualifications/gating.ts", "mock:gating"],
  ["@openbooks/engine/src/hrm/qualifications/requirements.ts", "mock:requirements"],
  ["@openbooks/engine/src/hrm/qualifications/types.ts", "mock:types"],
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
]);

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
const ledgerRoute = (await import("./route.ts")) as typeof import("./route.ts");
const checkRoute = (await import("./check/route.ts")) as typeof import("./check/route.ts");
const requirementsRoute = (await import("../qualification-requirements/route.ts")) as typeof import("../qualification-requirements/route.ts");
const verifyRoute = (await import("./[id]/verify/route.ts")) as typeof import("./[id]/verify/route.ts");
const revokeRoute = (await import("./[id]/revoke/route.ts")) as typeof import("./[id]/revoke/route.ts");
const renewRoute = (await import("./[id]/renew/route.ts")) as typeof import("./[id]/renew/route.ts");
const evidenceRoute = (await import("./[id]/evidence/route.ts")) as typeof import("./[id]/evidence/route.ts");
const typesRoute = (await import("../qualification-types/route.ts")) as typeof import("../qualification-types/route.ts");
hooks.deregister();

function reset(): void {
  routeState.gate = { user: { id: "user-1", orgId: "org-1" } };
  routeState.perms = ["hrm.certifications.read", "hrm.certifications.manage", "hrm.self.read"];
  routeState.featureOn = true;
  routeState.calls = [];
  routeState.serviceThrow = null;
}

const UUID = "00000000-0000-4000-8000-000000000001";
const UUID2 = "00000000-0000-4000-8000-000000000002";

test("a missing feature flag 404s before the service runs", async () => {
  reset();
  routeState.featureOn = false;
  const get = await ledgerRoute.GET(new Request("http://openbooks.test/api/hrm/qualifications"));
  assert.equal(get.status, 404);
  assert.deepEqual(routeState.calls, []);
});

test("an unauthenticated caller never reaches the service", async () => {
  reset();
  routeState.gate = { status: 401 };
  const get = await ledgerRoute.GET(new Request("http://openbooks.test/api/hrm/qualifications"));
  assert.equal(get.status, 401);
  assert.deepEqual(routeState.calls, []);
});

test("record carries the caller's org and actor into the service", async () => {
  reset();
  const post = await ledgerRoute.POST(
    new Request("http://openbooks.test/api/hrm/qualifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ employmentId: UUID, typeId: UUID2, issuedOn: "2026-09-21" }),
    }),
  );
  assert.equal(post.status, 201);
  assert.deepEqual(routeState.calls, [
    {
      fn: "record",
      args: { orgId: "org-1", actorId: "user-1", employmentId: UUID, typeId: UUID2, issuedOn: "2026-09-21" },
    },
  ]);
});

test("an engine refusal maps with its message intact", async () => {
  reset();
  routeState.serviceThrow = new HrmQualificationError("expiry 2026-01-01 is before issue 2026-09-21 — fix the dates and record again.");
  const post = await ledgerRoute.POST(
    new Request("http://openbooks.test/api/hrm/qualifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ employmentId: UUID, typeId: UUID2, issuedOn: "2026-09-21" }),
    }),
  );
  assert.equal(post.status, 422);
  const body = (await post.json()) as { error: string };
  assert.match(body.error, /before issue/);
});

test("an unshaped body never reaches the service", async () => {
  reset();
  const post = await ledgerRoute.POST(
    new Request("http://openbooks.test/api/hrm/qualifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ employmentId: UUID }),
    }),
  );
  assert.equal(post.status, 400);
  assert.deepEqual(routeState.calls, []);
});

test("the gate check reads through with the caller's org", async () => {
  reset();
  const post = await checkRoute.POST(
    new Request("http://openbooks.test/api/hrm/qualifications/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ employmentId: UUID, subjectKind: "project", subjectId: UUID2 }),
    }),
  );
  assert.equal(post.status, 200);
  assert.deepEqual(routeState.calls, [
    { fn: "check", args: { orgId: "org-1", actorId: "user-1", employmentId: UUID, subjectKind: "project", subjectId: UUID2 } },
  ]);
});

test("verify and revoke carry the path id into the service", async () => {
  reset();
  const params = Promise.resolve({ id: "q-9" });
  const verify = await verifyRoute.POST(
    new Request("http://openbooks.test/api/hrm/qualifications/q-9/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    { params },
  );
  assert.equal(verify.status, 200);
  const revoke = await revokeRoute.POST(
    new Request("http://openbooks.test/api/hrm/qualifications/q-9/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "fraud" }),
    }),
    { params: Promise.resolve({ id: "q-9" }) },
  );
  assert.equal(revoke.status, 200);
  assert.deepEqual(routeState.calls, [
    { fn: "verify", args: { orgId: "org-1", actorId: "user-1", qualificationId: "q-9" } },
    { fn: "revoke", args: { orgId: "org-1", actorId: "user-1", qualificationId: "q-9", reason: "fraud" } },
  ]);
  const renew = await renewRoute.POST(
    new Request("http://openbooks.test/api/hrm/qualifications/q-9/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issuedOn: "2026-09-21" }),
    }),
    { params: Promise.resolve({ id: "q-9" }) },
  );
  assert.equal(renew.status, 201);
});

test("evidence attach admits the holder through the self grant", async () => {
  reset();
  routeState.perms = ["hrm.self.read"];
  const post = await evidenceRoute.POST(
    new Request("http://openbooks.test/api/hrm/qualifications/q-9/evidence", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fileId: UUID }),
    }),
    { params: Promise.resolve({ id: "q-9" }) },
  );
  assert.equal(post.status, 200);
  assert.deepEqual(routeState.calls, [
    { fn: "attach", args: { orgId: "org-1", actorId: "user-1", qualificationId: "q-9", fileId: UUID } },
  ]);
});

test("requirements set refuses an unreadable shape before the service", async () => {
  reset();
  const post = await requirementsRoute.POST(
    new Request("http://openbooks.test/api/hrm/qualification-requirements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subjectKind: "project", subjectId: UUID, typeId: UUID2, severity: "block" }),
    }),
  );
  assert.equal(post.status, 201);
  const bad = await requirementsRoute.POST(
    new Request("http://openbooks.test/api/hrm/qualification-requirements", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subjectKind: "planet", subjectId: UUID, typeId: UUID2 }),
    }),
  );
  assert.equal(bad.status, 400);
});

test("type creation carries code and category into the service", async () => {
  reset();
  const post = await typesRoute.POST(
    new Request("http://openbooks.test/api/hrm/qualification-types", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "OSHA30", name: "OSHA 30", category: "certification" }),
    }),
  );
  assert.equal(post.status, 201);
  assert.deepEqual(routeState.calls, [
    { fn: "createType", args: { orgId: "org-1", actorId: "user-1", code: "OSHA30", name: "OSHA 30", category: "certification" } },
  ]);
});

test("F3-37: record, verify, renew and revoke refuse a read-only role before the service runs", async () => {
  reset();
  routeState.perms = ["hrm.certifications.read", "hrm.self.read"];
  const params = { params: Promise.resolve({ id: "q-9" }) };
  const record = await ledgerRoute.POST(
    new Request("http://openbooks.test/api/hrm/qualifications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ employmentId: UUID, typeId: UUID2, issuedOn: "2026-09-21" }),
    }),
  );
  assert.equal(record.status, 403);
  const verify = await verifyRoute.POST(
    new Request("http://openbooks.test/api/hrm/qualifications/q-9/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }),
    params,
  );
  assert.equal(verify.status, 403);
  const renew = await renewRoute.POST(
    new Request("http://openbooks.test/api/hrm/qualifications/q-9/renew", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issuedOn: "2026-09-21" }),
    }),
    params,
  );
  assert.equal(renew.status, 403);
  const revoke = await revokeRoute.POST(
    new Request("http://openbooks.test/api/hrm/qualifications/q-9/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "fraud" }),
    }),
    params,
  );
  assert.equal(revoke.status, 403);
  assert.deepEqual(routeState.calls, [], "no write reached the service without the manage grant");
});
