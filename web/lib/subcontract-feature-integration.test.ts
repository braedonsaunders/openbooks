import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

interface TransitionRouteState {
  transitionCalls: number;
}

const transitionRouteState: TransitionRouteState = { transitionCalls: 0 };
const transitionRouteStateKey = Symbol.for("openbooks.subcontract-transition-route-test");
(globalThis as typeof globalThis & Record<symbol, unknown>)[transitionRouteStateKey] = transitionRouteState;

const transitionRouteMockSources = new Map<string, string>([
  [
    "mock:json",
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    "mock:authz",
    `
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
  ["mock:feature-gate", "export async function guardSubcontractsFeature() { return null }"],
  ["mock:features", "export async function isFeatureEnabled() { return true }"],
  ["mock:exact-decimal", "export function canonicalDecimal() { return '0.0000' }"],
  ["mock:money", "export function normalizeMoney(value) { return value }"],
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
      export class SubcontractError extends Error {}
      export function parseSubcontractTransitionAction(value) {
        if (typeof value !== 'string' || !['substantially_complete', 'close', 'void'].includes(value)) {
          throw new SubcontractError('Invalid subcontract transition action')
        }
        return value
      }
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

const transitionRouteMockUrls = new Map<string, string>([
  ["@/lib/api/json", "mock:json"],
  ["../../../lib/authz", "mock:authz"],
  ["../../../lib/subcontracts-gate", "mock:feature-gate"],
  ["../../../lib/features", "mock:features"],
  ["../../../lib/exact-decimal", "mock:exact-decimal"],
  ["@openbooks/engine/src/db.ts", "mock:db"],
  ["@openbooks/engine/src/money.ts", "mock:money"],
  ["@openbooks/engine/src/subcontracts.ts", "mock:subcontracts"],
]);

const transitionRouteHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
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

test("subcontract API validates transition actions before dispatch instead of falling back to void", () => {
  const route = source("app/api/subcontracts/route.ts");
  const start = route.indexOf('case "transitionSubcontract": {');
  const next = route.indexOf('case "addChangeOrder": {', start);
  assert.ok(start >= 0 && next > start, "transitionSubcontract branch is defined");
  const branch = route.slice(start, next);
  const parser = branch.indexOf("parseSubcontractTransitionAction(body.transition)");
  const dispatch = branch.indexOf("await transitionSubcontract");
  assert.ok(parser >= 0 && parser < dispatch, "transition validation precedes engine dispatch");
  assert.match(branch, /error instanceof SubcontractError/);
  assert.match(branch, /NextResponse\.json\(\{ error: error\.message \}, \{ status: 400 \}\)/);
  assert.match(branch, /action: transition/);
  assert.doesNotMatch(branch, /action: body\.transition/);
});

test("direct subcontracts join both project committed-cost rollups without double-counting linked POs", () => {
  const helper = source("../engine/src/subcontract-commitments.ts");
  const costing = source("lib/project-costing.ts");
  const financials = source("../engine/src/project-financials.ts");
  assert.match(helper, /original_commitment[\s\S]+changes\.approved[\s\S]+apps\.billed/);
  assert.match(helper, /status in \('active', 'substantially_complete'\)/);
  assert.match(helper, /purchase_order_id is null/);
  assert.match(costing, /directSubcontractOpenCommitment/);
  assert.match(financials, /directSubcontractOpenCommitment/);
});

test("subcontract payment controls gate run creation and final vendor-payment posting", () => {
  const payments = source("../engine/src/payments.ts");
  const occurrences = payments.match(/assertSubcontractPaymentCleared/g) ?? [];
  assert.ok(occurrences.length >= 3, "expected import plus run-creation and final-posting gates");
  assert.match(payments, /for \(const bill of payable\)[\s\S]+assertSubcontractPaymentCleared/);
  assert.match(payments, /doc\.kind === "vendor_payment"[\s\S]+assertSubcontractPaymentCleared/);
});

test("subcontract API applies AP permission tiers", () => {
  const route = source("app/api/subcontracts/route.ts");
  assert.match(route, /approvalActions[\s\S]+"ap\.approve"/);
  assert.match(route, /postingActions[\s\S]+"ap\.post"/);
  assert.match(route, /paymentActions[\s\S]+"ap\.pay"/);
  assert.match(route, /guardSubcontractsFeature/);
});

test("subcontract API persists money through canonicalDecimal and normalizeMoney", () => {
  const route = source("app/api/subcontracts/route.ts");
  assert.match(route, /canonicalDecimal/);
  assert.match(route, /normalizeMoney/);
  assert.match(route, /originalCommitment/);
  assert.match(route, /scheduledValue/);
  assert.match(route, /Draw amount/);
  assert.doesNotMatch(route, /createSubcontract\(\{ \.\.\.body, orgId, userId \}/);
});
