import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Boundary suite: submitting an own draft from the inbox runs the same
// reason-code classification check as the submit route, on the draft's
// stored action and reason code, before the submit service is called.

const stateKey = Symbol.for("openbooks.hrm-change-request-adapter-test");

interface AdapterState {
  refuse: boolean;
  validated: unknown[];
  submitted: unknown[];
}

const adapterState: AdapterState = { refuse: false, validated: [], submitted: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = adapterState;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      export const db = {
        execute: () => Promise.reject(new Error("unexpected database read")),
        transaction: () => Promise.reject(new Error("unexpected database transaction")),
      }
      export const schema = {}
      export const pool = {}
      export const env = {}
      export async function withBypassContext(work) { return work() }
      export async function withBypass(work) { return work() }
      export async function withOrg(_orgId, work) { return work() }
      export async function withOrgContext(_orgId, work) { return work() }
      export async function withOrgTransaction(_orgId, work) { return work() }
      export function registerRequestOrgResolver() {}
      export function currentRequestOrgResolver() { return null }
      export function ambientTenantOrgId() { return null }
    `,
  ],
  [
    "mock:change-requests",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-change-request-adapter-test')]
      export async function listChangeRequests() { return [] }
      export async function getChangeRequest(query) {
        return { id: query.requestId, action: 'promotion', reasonCode: 'MERIT' }
      }
      export async function submitChangeRequest(query) {
        state.submitted.push(query)
        return { id: query.requestId }
      }
    `,
  ],
  [
    "mock:gates",
    `
      export async function decideGate() { throw new Error("not under test") }
      export async function delegateGate() { throw new Error("not under test") }
    `,
  ],
  [
    "mock:worklist",
    `
      export async function worklistApprovals() { return [] }
    `,
  ],
  [
    "mock:action-reasons",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-change-request-adapter-test')]
      export async function validateSubmitActionReason(input) {
        state.validated.push(input)
        if (state.refuse) throw new Error('this org requires an action and a reason code on every change request')
      }
    `,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (typeof specifier !== "string") return nextResolve(specifier, context);
    if (specifier.endsWith("/platform/db.ts")) return { url: "mock:db", shortCircuit: true };
    if (specifier === "../../hrm/change-requests.ts") return { url: "mock:change-requests", shortCircuit: true };
    if (specifier === "../../flows/gates.ts") return { url: "mock:gates", shortCircuit: true };
    if (specifier === "../../flows/approval-worklist.ts") return { url: "mock:worklist", shortCircuit: true };
    if (specifier === "../../automations/action-reasons.ts") return { url: "mock:action-reasons", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const adapterUrl = "./hrm-change-request.ts?hrm-change-request-adapter-test";
const { hrmChangeRequestAdapter } = (await import(adapterUrl)) as typeof import("./hrm-change-request.ts");
hooks.deregister();

const CTX = { orgId: "org-1", actorId: "user-1", asOf: "2026-08-01T00:00:00Z", allowedSubsidiaryIds: null };

test("an inbox submit classifies the stored draft before submitting it", async () => {
  Object.assign(adapterState, { refuse: false, validated: [], submitted: [] });
  await hrmChangeRequestAdapter.act!(CTX as never, "own:req-1", "submit", "Annual merit");
  assert.deepEqual(adapterState.validated, [
    { orgId: "org-1", action: "promotion", reasonCode: "MERIT", reason: "Annual merit" },
  ]);
  assert.equal(adapterState.submitted.length, 1);
});

test("a classification refusal stops the inbox submit before the service runs", async () => {
  Object.assign(adapterState, { refuse: true, validated: [], submitted: [] });
  await assert.rejects(
    hrmChangeRequestAdapter.act!(CTX as never, "own:req-1", "submit", "Annual merit"),
    /requires an action and a reason code/,
  );
  assert.deepEqual(adapterState.submitted, []);
});
