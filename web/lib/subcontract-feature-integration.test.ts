import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";


interface TransitionRouteState {
  transitionCalls: number;
}

const transitionRouteState: TransitionRouteState = { transitionCalls: 0 };
const transitionRouteStateKey = Symbol.for("openbooks.subcontract-transition-route-test");
(globalThis as typeof globalThis & Record<symbol, unknown>)[transitionRouteStateKey] = transitionRouteState;

const transitionRouteMockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, permissions: new Set(['*']), allowedSubsidiaryIds: null }
      }
      export function guardSubsidiaryScope() { return null }
    `,
  ],
  ["mock:subsidiaries", "export function subsidiaryVisibleFilter() { return '' }"],
  ["mock:feature-gate", "export async function guardSubcontractsFeature() { return null }"],
  ["mock:features", "export async function isFeatureEnabled() { return true }"],
  [
    "mock:db",
    `
      export const db = {
        async execute() { throw new Error('database work should not run for invalid transitions') },
        async transaction() { throw new Error('transaction work should not run for invalid transitions') },
      }
    `,
  ],
  [
    "mock:subcontracts",
    `
      const state = globalThis[Symbol.for('openbooks.subcontract-transition-route-test')]
      // The pure parser and its error class are re-exported from the REAL
      // engine module, so the route is judged by the rule the product actually
      // applies — a hand copy could drift while this file stayed green. The
      // DB-backed functions stay stubbed: this route test never calls them.
      export { parseSubcontractTransitionAction, SubcontractConflictError, SubcontractError } from ${JSON.stringify(
        new URL('../../engine/src/projects/subcontracts.ts', import.meta.url).href,
      )}
      export async function transitionSubcontract() { state.transitionCalls += 1 }
      export function addSubcontractSovLine() {}
      export function approveSubcontract() {}
      export function approveSubcontractChangeOrder() {}
      export function approveVendorPayApplication() {}
      export function createSubcontract() {}
      export function createSubcontractChangeOrder() {}
      export function createSubcontractPaymentControl() {}
      export function createVendorPayApplication() {}
      export function generateVendorPayApplicationBill() {}
      export function releaseSubcontractPaymentControl() {}
      export function releaseVendorRetainage() {}
      export function removeSubcontractSovLine() {}
      export function submitSubcontract() {}
      export function submitVendorPayApplication() {}
      export function updateDraftSubcontract() {}
      export function updateVendorPayApplicationLines() {}
      export function voidSubcontractChangeOrder() {}
      export function voidVendorPayApplication() {}
    `,
  ],
]);

// Neither '@/lib/api/json', the decimal classifier, nor the money kernel is
// mocked: hand doubles cannot produce the refusals the real modules enforce
// (the removed canonicalDecimal stub answered '0.0000' for every input).
const transitionRouteMockUrls = new Map<string, string>([
  ["../../../lib/authz", "mock:authz"],
  ["../../../lib/subcontracts-gate", "mock:feature-gate"],
  ["../../../lib/subsidiaries", "mock:subsidiaries"],
  ["../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["@openbooks/engine/src/projects/subcontracts.ts", "mock:subcontracts"],
]);

const transitionRouteHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // The real '@/lib/api/json' imports 'server-only', which is inert here.
    if (specifier === "server-only") return { url: "data:text/javascript,export {}", shortCircuit: true };
    const mocked = transitionRouteMockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = transitionRouteMockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const transitionRouteUrl = new URL("../app/api/subcontracts/route.ts?subcontract-transition-route-test", import.meta.url).href;
const { POST: postSubcontractAction } = await import(transitionRouteUrl);
transitionRouteHooks.deregister();

test("subcontract API maps invalid transition validation to HTTP 400 before the engine call", async () => {
  transitionRouteState.transitionCalls = 0;
  const response = await postSubcontractAction(
    new Request("http://openbooks.test/api/subcontracts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "transitionSubcontract", id: "subcontract-1", transition: "approve" }),
    }),
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid subcontract transition action" });
  assert.equal(transitionRouteState.transitionCalls, 0, "invalid input must not reach the transition engine");
});
