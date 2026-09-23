import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Boundary suite: the hrm_feedback_request adapter runs against a scripted
// feedback service. Only a missing person identity lists nothing — any other
// service failure propagates with its message intact instead of
// masquerading as "no work".

const stateKey = Symbol.for("openbooks.hrm-feedback-adapter-test");

interface FeedbackAdapterState {
  featuresOn: boolean;
  service: "requests" | "no-identity" | "boom";
  serviceCalls: number;
  HrmAuthorizationError?: new (message?: string) => Error;
}

const adapterState: FeedbackAdapterState = {
  featuresOn: true,
  service: "requests",
  serviceCalls: 0,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  adapterState;

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
    "mock:feedback",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-feedback-adapter-test')]
      export async function feedbackFeatureEnabled() {
        return state.featuresOn
      }
      export async function listOpenRequestsForParty() {
        state.serviceCalls += 1
        if (state.service === 'no-identity') {
          throw new state.HrmAuthorizationError('no person identity')
        }
        if (state.service === 'boom') {
          throw new Error('feedback store unreachable')
        }
        return [{ id: 'req-1', recordedAt: '2026-08-01T00:00:00Z' }]
      }
    `,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (typeof specifier !== "string") return nextResolve(specifier, context);
    if (specifier.endsWith("/platform/db.ts")) {
      return { url: "mock:db", shortCircuit: true };
    }
    // Resolved without a parentURL condition: the adapter reaches the
    // service through a relative specifier, and the test file itself
    // imports it only dynamically below, so there is nothing to collide
    // with.
    if (specifier === "../../hrm/performance/feedback.ts") {
      return { url: "mock:feedback", shortCircuit: true };
    }
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

// The real identity error: the mock service throws THIS class (never a
// hand copy) so the adapter is judged by the rule the product applies.
// Assigned onto the live state object (never replaced) so reset() below
// keeps steering the same object the mocks read.
const { HrmAuthorizationError } = (await import("../../hrm/authorization.ts")) as typeof import("../../hrm/authorization.ts");
Object.assign(adapterState, { HrmAuthorizationError });

const adapterUrl = "./hrm-feedback-request.ts?hrm-feedback-adapter-test";
const { hrmFeedbackRequestAdapter } = (await import(adapterUrl)) as typeof import("./hrm-feedback-request.ts");
hooks.deregister();

const CTX = { orgId: "org-1", actorId: "user-1", asOf: "2026-08-01T00:00:00Z" };

function reset(service: FeedbackAdapterState["service"]): void {
  adapterState.featuresOn = true;
  adapterState.service = service;
  adapterState.serviceCalls = 0;
}

test("a missing person identity lists nothing without calling the database", async () => {
  reset("no-identity");
  assert.deepEqual(await hrmFeedbackRequestAdapter.list(CTX), []);
  assert.equal(adapterState.serviceCalls, 1);
});

test("any other service failure propagates with its message intact", async () => {
  reset("boom");
  await assert.rejects(hrmFeedbackRequestAdapter.list(CTX), /feedback store unreachable/);
});

test("open requests map to link-only items", async () => {
  reset("requests");
  const items = await hrmFeedbackRequestAdapter.list(CTX);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, "hrm_feedback_request:req-1");
  assert.deepEqual(items[0]!.actions, []);
});

test("any disabled surface feature short-circuits before the service", async () => {
  reset("requests");
  adapterState.featuresOn = false;
  assert.deepEqual(await hrmFeedbackRequestAdapter.list(CTX), []);
  assert.equal(adapterState.serviceCalls, 0);
});
