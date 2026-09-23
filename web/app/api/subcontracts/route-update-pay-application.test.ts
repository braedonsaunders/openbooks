import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Route boundary suite: POST /api/subcontracts action=updatePayApplication
// runs the real route against a scripted database fake and a capturing
// engine double. Malformed lines (non-array, missing identity, unparseable
// amounts) are 422 naming the line — never a 500 from inside the update —
// and engine refusals surface with their message intact.

const stateKey = Symbol.for("openbooks.subcontracts-route-test");

interface SubcontractsRouteState {
  subsidiaryId: string | null;
  updateCalls: Array<Record<string, unknown>>;
  updateError: string | null;
  updateConflict: string | null;
  dbCalls: string[];
}

const routeState: SubcontractsRouteState = {
  subsidiaryId: null,
  updateCalls: [],
  updateError: null,
  updateConflict: null,
  dbCalls: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks)
        return sqlText(chunk);
      return "";
    })
    .join("");
}
(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksSqlTextSubcontracts = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.subcontracts-route-test')]
      const sqlText = globalThis.openbooksSqlTextSubcontracts
      export const db = {
        execute: (query) => {
          const text = sqlText(query)
          state.dbCalls.push(text)
          if (/from vendor_pay_applications/i.test(text) || /join projects p on p\\.id = s\\.project_id/i.test(text)) {
            return Promise.resolve({ rows: [{ subsidiary_id: state.subsidiaryId }] })
          }
          return Promise.resolve({ rows: [] })
        },
      }
    `,
  ],
  [
    "mock:authz",
    `
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
      export function guardSubsidiaryScope() {
        return null
      }
    `,
  ],
  ["mock:features", `export async function isFeatureEnabled() { return true }`],
  [
    "mock:subcontracts-gate",
    `export async function guardSubcontractsFeature() { return null }`,
  ],
  [
    "mock:subsidiaries",
    `export function subsidiaryVisibleFilter() { return { queryChunks: [] } }`,
  ],
  [
    "mock:subcontracts",
    `
      const state = globalThis[Symbol.for('openbooks.subcontracts-route-test')]
      export class SubcontractError extends Error {}
      export class SubcontractConflictError extends SubcontractError {}
      export function parseSubcontractTransitionAction(value) { return value }
      export async function updateVendorPayApplicationLines(input) {
        state.updateCalls.push(input)
        if (state.updateConflict) throw new SubcontractConflictError(state.updateConflict)
        if (state.updateError) throw new SubcontractError(state.updateError)
        return { ok: true }
      }
      // Every other export the route imports, literal so the mock-surface
      // check can read it: each throws if the route reaches it.
      export async function addSubcontractSovLine() { throw new Error("unexpected addSubcontractSovLine") }
      export async function approveSubcontract() { throw new Error("unexpected approveSubcontract") }
      export async function approveSubcontractChangeOrder() { throw new Error("unexpected approveSubcontractChangeOrder") }
      export async function approveVendorPayApplication() { throw new Error("unexpected approveVendorPayApplication") }
      export async function createSubcontract() { throw new Error("unexpected createSubcontract") }
      export async function createSubcontractChangeOrder() { throw new Error("unexpected createSubcontractChangeOrder") }
      export async function createSubcontractPaymentControl() { throw new Error("unexpected createSubcontractPaymentControl") }
      export async function createVendorPayApplication() { throw new Error("unexpected createVendorPayApplication") }
      export async function generateVendorPayApplicationBill() { throw new Error("unexpected generateVendorPayApplicationBill") }
      export async function releaseSubcontractPaymentControl() { throw new Error("unexpected releaseSubcontractPaymentControl") }
      export async function releaseVendorRetainage() { throw new Error("unexpected releaseVendorRetainage") }
      export async function removeSubcontractSovLine() { throw new Error("unexpected removeSubcontractSovLine") }
      export async function submitSubcontract() { throw new Error("unexpected submitSubcontract") }
      export async function submitVendorPayApplication() { throw new Error("unexpected submitVendorPayApplication") }
      export async function transitionSubcontract() { throw new Error("unexpected transitionSubcontract") }
      export async function updateDraftSubcontract() { throw new Error("unexpected updateDraftSubcontract") }
      export async function voidSubcontractChangeOrder() { throw new Error("unexpected voidSubcontractChangeOrder") }
      export async function voidVendorPayApplication() { throw new Error("unexpected voidVendorPayApplication") }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["@openbooks/engine/src/projects/subcontracts.ts", "mock:subcontracts"],
  ["../../../lib/authz", "mock:authz"],
  ["../../../lib/features", "mock:features"],
  ["../../../lib/subcontracts-gate", "mock:subcontracts-gate"],
  ["../../../lib/subsidiaries", "mock:subsidiaries"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) {
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?subcontracts-update-lines-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const APP_ID = "00000000-0000-4000-8000-00000000b001";
const SOV_ID = "00000000-0000-4000-8000-00000000b002";

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/subcontracts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function reset(): void {
  routeState.updateCalls = [];
  routeState.updateError = null;
  routeState.updateConflict = null;
  routeState.dbCalls = [];
}

function updateBody(lines: unknown, expectedRevision: unknown = 1): Record<string, unknown> {
  return { action: "updatePayApplication", payApplicationId: APP_ID, expectedRevision, lines };
}

test("updatePayApplication with missing lines is 422 and never reaches the engine", async () => {
  reset();
  const response = await post({ action: "updatePayApplication", payApplicationId: APP_ID });

  assert.equal(response.status, 422);
  const payload = (await response.json()) as { error?: string };
  assert.match(payload.error ?? "", /lines must be an array/);
  assert.equal(routeState.updateCalls.length, 0);
});

test("updatePayApplication without a revision token is 422 and never reaches the engine", async () => {
  reset();
  const lines = [{ sovLineId: SOV_ID, workCompletedThisPeriod: "10", materialsStoredCurrent: "0" }];
  // A missing token must arrive as a MISSING key (JSON drops undefined),
  // not as the helper's default — that absence is what this refuses.
  const missing = updateBody(lines);
  delete missing.expectedRevision;
  for (const body of [missing, updateBody(lines, 0), updateBody(lines, 1.5), updateBody(lines, "1")]) {
    const response = await post(body);
    assert.equal(response.status, 422, `expectedRevision=${JSON.stringify(body.expectedRevision)}`);
    const payload = (await response.json()) as { error?: string };
    assert.match(payload.error ?? "", /expectedRevision/);
  }
  assert.equal(routeState.updateCalls.length, 0);
});

test("updatePayApplication with a line missing its identity is 422 naming the line", async () => {
  reset();
  const response = await post(
    updateBody([{ workCompletedThisPeriod: "10", materialsStoredCurrent: "0" }]),
  );

  assert.equal(response.status, 422);
  const payload = (await response.json()) as { error?: string };
  assert.match(payload.error ?? "", /line 1/);
  assert.match(payload.error ?? "", /sovLineId/);
  assert.equal(routeState.updateCalls.length, 0);
});

test("updatePayApplication with an unparseable amount is 422 naming the line and its identity", async () => {
  reset();
  const response = await post(
    updateBody([{ sovLineId: SOV_ID, workCompletedThisPeriod: "ten", materialsStoredCurrent: "0" }]),
  );

  assert.equal(response.status, 422);
  const payload = (await response.json()) as { error?: string };
  assert.match(payload.error ?? "", /line 1/);
  assert.match(payload.error ?? "", new RegExp(SOV_ID));
  assert.equal(routeState.updateCalls.length, 0);
});

test("updatePayApplication forwards the token and validated lines to the engine", async () => {
  reset();
  const response = await post(
    updateBody([{ sovLineId: SOV_ID, workCompletedThisPeriod: "10", materialsStoredCurrent: "0" }]),
  );

  assert.equal(response.status, 200);
  assert.equal(routeState.updateCalls.length, 1);
  const call = routeState.updateCalls[0] as {
    expectedRevision: number;
    lines: Array<{ sovLineId: string; workCompletedThisPeriod: string; materialsStoredCurrent: string }>;
  };
  assert.equal(call.expectedRevision, 1);
  assert.deepEqual(call.lines, [
    { sovLineId: SOV_ID, workCompletedThisPeriod: "10.0000", materialsStoredCurrent: "0.0000" },
  ]);
});

test("updatePayApplication surfaces an engine line refusal as 422, not 500", async () => {
  reset();
  routeState.updateError = `line 1 (${SOV_ID}): application line does not belong to this application`;
  const response = await post(
    updateBody([{ sovLineId: SOV_ID, workCompletedThisPeriod: "10", materialsStoredCurrent: "0" }]),
  );

  assert.equal(response.status, 422);
  const payload = (await response.json()) as { error?: string };
  assert.match(payload.error ?? "", /line 1/);
  assert.match(payload.error ?? "", /does not belong to this application/);
});

test("updatePayApplication surfaces a stale token as 409, not 422", async () => {
  reset();
  routeState.updateConflict =
    "This application changed while you were editing (revision 2, you hold 1) — reload it to see the other editor's values, then re-enter your changes";
  const response = await post(
    updateBody([{ sovLineId: SOV_ID, workCompletedThisPeriod: "10", materialsStoredCurrent: "0" }]),
  );

  assert.equal(response.status, 409);
  const payload = (await response.json()) as { error?: string };
  assert.match(payload.error ?? "", /changed while you were editing/);
  assert.match(payload.error ?? "", /reload/);
});
