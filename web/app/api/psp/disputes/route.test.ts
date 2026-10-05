import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface DisputeRouteState {
  permissions: Set<string>;
  reviewCalls: Array<{ action: string; disputeId: string; reason?: string }>;
  existingDisputes: Set<string>;
}

const stateKey = Symbol.for("openbooks.psp-disputes-route-test");
const routeState: DisputeRouteState = {
  permissions: new Set(),
  reviewCalls: [],
  existingDisputes: new Set(),
};
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.psp-disputes-route-test')]
      export const db = {
        execute(query) {
          const staticText = (chunk) => {
            if (typeof chunk !== 'object' || chunk === null) return ''
            if (Array.isArray(chunk.value)) return chunk.value.join('')
            if (Array.isArray(chunk.queryChunks)) return chunk.queryChunks.map(staticText).join('')
            return ''
          }
          // Bound parameters ride as bare string chunks beside the
          // StringChunk objects; the dispute id is the only uuid among them.
          const params = []
          for (const chunk of query?.queryChunks ?? []) {
            if (typeof chunk === 'string') params.push(chunk)
            else if (chunk && typeof chunk === 'object' && typeof chunk.value === 'string') params.push(chunk.value)
          }
          const text = (query?.queryChunks ?? []).map(staticText).join('')
          if (text.includes('from payment_disputes')) {
            const id = params.find((value) => state.existingDisputes.has(value))
            return { rows: id ? [{ id }] : [] }
          }
          return { rows: [] }
        }
      }
    `,
  ],
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.psp-disputes-route-test')]

      export async function getAuthz() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          permissions: new Set(state.permissions),
          allowedSubsidiaryIds: null,
        }
      }

      export function can(authz, permission) {
        return authz.permissions.has(permission)
      }
    `,
  ],
  [
    "mock:features",
    `
      export async function isFeatureEnabled() { return true }
    `,
  ],
  [
    "mock:automation",
    `
      const state = globalThis[Symbol.for('openbooks.psp-disputes-route-test')]

      export class PspAutomationError extends Error {}

      export async function approveDisputeReview(orgId, disputeId, actorId) {
        state.reviewCalls.push({ action: 'approve', disputeId })
        return { status: 'posted', disputeId, documents: ['doc-1'] }
      }

      export async function rejectDisputeReview(orgId, disputeId, actorId, reason) {
        if (reason === 'explode') throw new PspAutomationError('review is posted; only a queued review can be rejected')
        state.reviewCalls.push({ action: 'reject', disputeId, reason })
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  [
    "@openbooks/engine/src/payments/psp-refund-automation.ts",
    "mock:automation",
  ],
  ["../../../../lib/authz", "mock:authz"],
  ["@/lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["@/lib/features", "mock:features"],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
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

const { POST } = (await import("./route")) as {
  POST: (request: Request) => Promise<Response>;
};

const DISPUTE_ID = "11111111-1111-4111-8111-111111111111";

function post(body: unknown): Promise<Response> {
  return POST(
    new Request("http://localhost/api/psp/disputes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function reset() {
  routeState.permissions = new Set(["banking.reconcile"]);
  routeState.reviewCalls = [];
  routeState.existingDisputes = new Set([DISPUTE_ID]);
}

test("approve posts through the automation and returns its outcome", async () => {
  reset();
  const response = await post({ action: "approve", disputeId: DISPUTE_ID });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "posted",
    disputeId: DISPUTE_ID,
    documents: ["doc-1"],
  });
  assert.deepEqual(routeState.reviewCalls, [
    { action: "approve", disputeId: DISPUTE_ID },
  ]);
});

test("reject records the reason and moves nothing", async () => {
  reset();
  const response = await post({
    action: "reject",
    disputeId: DISPUTE_ID,
    reason: "duplicate of the card network advice",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(routeState.reviewCalls, [
    {
      action: "reject",
      disputeId: DISPUTE_ID,
      reason: "duplicate of the card network advice",
    },
  ]);
});

test("approve of an unknown review is a tenant-opaque 404", async () => {
  reset();
  routeState.existingDisputes = new Set();
  const response = await post({ action: "approve", disputeId: DISPUTE_ID });
  assert.equal(response.status, 404);
  assert.deepEqual(routeState.reviewCalls, []);
});

test("rejecting a resolved review surfaces the engine refusal naming the state", async () => {
  reset();
  const response = await post({
    action: "reject",
    disputeId: DISPUTE_ID,
    reason: "explode",
  });
  assert.equal(response.status, 422);
  const body = (await response.json()) as { error?: string };
  assert.match(body.error ?? "", /only a queued review can be rejected/);
});

test("a reader without banking.reconcile cannot approve", async () => {
  reset();
  routeState.permissions = new Set(["banking.read"]);
  const response = await post({ action: "approve", disputeId: DISPUTE_ID });
  assert.equal(response.status, 403);
  assert.deepEqual(routeState.reviewCalls, []);
});
