import assert from "node:assert/strict";
import test from "node:test";
import { NextResponse } from "next/server";
import { BenefitsError } from "@openbooks/engine/src/hrm/benefits/errors.ts";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { stubModules } from "../../../../../testing/stub-modules";

const orgId = "00000000-0000-4000-8000-000000000001";
const actorId = "00000000-0000-4000-8000-000000000002";
const programId = "00000000-0000-4000-8000-000000000003";
const itemId = "00000000-0000-4000-8000-000000000004";
const state = {
  permissions: new Set<string>(), enabled: true, orgId, actorId, response: NextResponse,
  calls: [] as Array<{ command: string; input: unknown }>,
  gates: [] as Array<{ permission: string; feature: string }>,
  invalidations: [] as string[], refusal: null as Error | null,
};
const stateKey = Symbol.for("openbooks.benefit-transaction-policy-route");
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;
stubModules({ extra: {
  "@/lib/feature-gates": `
    const s = globalThis[Symbol.for('openbooks.benefit-transaction-policy-route')];
    export async function guardFeaturePermission(permission, feature) {
      s.gates.push({permission, feature});
      if (!s.permissions.has(permission)) return s.response.json({error:'forbidden'}, {status:403});
      if (!s.enabled) return s.response.json({error:'not_found'}, {status:404});
      return {user:{orgId:s.orgId,id:s.actorId}};
    }`,
  "@openbooks/engine/hrm/benefits": `
    const s = globalThis[Symbol.for('openbooks.benefit-transaction-policy-route')];
    export async function getBenefitTransactionPolicy(input) {
      s.calls.push({command:'read',input}); if (s.refusal) throw s.refusal;
      return {programRevision:4,policy:null};
    }
    export async function saveBenefitTransactionPolicy(input) {
      s.calls.push({command:'write',input}); if (s.refusal) throw s.refusal;
      return {programRevision:5,policy:input.policy};
    }`,
  "@/lib/analytics/preview-invalidation": `
    export async function invalidateAnalyticsPreviews(orgId) {
      globalThis[Symbol.for('openbooks.benefit-transaction-policy-route')].invalidations.push(orgId);
    }`,
} });

const addresses = [
  { name: "Setup aggregate", path: `/api/hrm/benefit-transaction-rules/${programId}`, route: await import("./route") },
  { name: "program rules", path: `/api/hrm/benefit-programs/${programId}/transaction-rules`, route: await import("../../benefit-programs/[id]/transaction-rules/route") },
];
const validBody = () => ({
  expectedRevision: 4, reason: "Reviewed equipment transaction policy",
  documentKind: "sales_order", dateBasis: "document_date", groupingSegmentId: null,
  itemIds: [itemId], positions: [{ key: "operator", name: "Operator", weight: "1.0000" }],
  responsibilities: [], limits: [],
});
function reset() {
  Object.assign(state, {
    permissions: new Set(["hrm.benefits.read", "hrm.benefits.manage"]), enabled: true,
    calls: [], gates: [], invalidations: [], refusal: null,
  });
}
function request(path: string, method: string, body?: unknown) {
  return new Request(`http://openbooks.test${path}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const context = (id = programId) => ({ params: Promise.resolve({ id }) });

for (const address of addresses) {
  test(`${address.name} declares read and manage permissions before calling the native policy command`, async () => {
    for (const method of ["GET", "PATCH"] as const) {
      reset();
      state.permissions.delete(method === "GET" ? "hrm.benefits.read" : "hrm.benefits.manage");
      const response = await address.route[method](request(address.path, method, method === "PATCH" ? validBody() : undefined), context());
      assert.equal(response.status, 403);
      assert.deepEqual(state.gates, [{ permission: method === "GET" ? "hrm.benefits.read" : "hrm.benefits.manage", feature: "hrm" }]);
      assert.deepEqual(state.calls, []);
      reset(); state.enabled = false;
      assert.equal((await address.route[method](request(address.path, method, method === "PATCH" ? validBody() : undefined), context())).status, 404);
      assert.deepEqual(state.calls, []);
    }
  });

  test(`${address.name} uses the real UUID and bounded policy parser before any write`, async () => {
    reset();
    assert.equal((await address.route.GET(request(address.path, "GET"), context("not-an-id"))).status, 400);
    const invalidBodies = [
      { ...validBody(), expectedRevision: 0 }, { ...validBody(), reason: " " },
      { ...validBody(), itemIds: [] }, { ...validBody(), groupingSegmentId: "foreign-name" },
      { ...validBody(), positions: Array.from({ length: 101 }, () => validBody().positions[0]) },
      { ...validBody(), limits: [{ groupId: itemId, kind: "none", amount: "1" }] },
      { ...validBody(), responsibilities: [{ groupId: itemId, positionKey: "operator", employmentId: actorId, effectiveFrom: "2026-02-30", effectiveTo: null }] },
    ];
    for (const body of invalidBodies) {
      const response = await address.route.PATCH(request(address.path, "PATCH", body), context());
      assert.equal(response.status, 400, await response.clone().text());
    }
    const oversized = await address.route.PATCH(request(address.path, "PATCH", { ...validBody(), reason: "x".repeat(1024 * 1024) }), context());
    assert.equal(oversized.status, 413);
    assert.deepEqual(state.calls, []);
    assert.deepEqual(state.invalidations, []);
  });

  test(`${address.name} forwards the verified actor, program, revision and exact policy through one command`, async () => {
    reset();
    const read = await address.route.GET(request(address.path, "GET"), context());
    assert.equal(read.status, 200);
    assert.deepEqual(state.calls, [{ command: "read", input: { orgId, actorId, programId } }]);
    reset();
    const body = validBody();
    const response = await address.route.PATCH(request(address.path, "PATCH", { ...body, orgId: itemId, actorId: itemId, programId: itemId }), context());
    assert.equal(response.status, 200, await response.clone().text());
    const { expectedRevision, reason, ...policy } = body;
    assert.deepEqual(state.calls, [{ command: "write", input: { orgId, actorId, programId, expectedRevision, reason, policy } }]);
    assert.deepEqual((await response.json()).record, { programRevision: 5, policy });
    assert.equal(state.gates.length, 1, "each address has one route factory gate");
    assert.deepEqual(state.invalidations, [orgId]);
  });

  test(`${address.name} preserves native revision and subject-scope refusals without a successful write response`, async () => {
    for (const [refusal, status, message] of [
      [new BenefitsError("REFUSED", "The program changed since you opened it — reload its current rules before saving."), 422, /reload its current rules/],
      [new HrmAuthorizationError("The employment is not visible in this organization."), 404, /not_found/],
    ] as const) {
      reset(); state.refusal = refusal;
      const response = await address.route.PATCH(request(address.path, "PATCH", validBody()), context());
      assert.equal(response.status, status);
      assert.match((await response.json()).error, message);
      assert.equal(state.calls.length, 1);
      assert.deepEqual(state.invalidations, []);
    }
  });
}
