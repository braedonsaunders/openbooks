import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface DisputeRouteState {
  permissions: Set<string>;
  reviewCalls: Array<{ action: string; disputeId: string; reason?: string }>;
  existingDisputes: Set<string>;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  reviewScopes: Array<ReadonlySet<string> | null>;
  outcome: string;
  refusal: boolean;
}

const stateKey = Symbol.for("openbooks.psp-disputes-route-test");
const routeState: DisputeRouteState = {
  permissions: new Set(),
  reviewCalls: [],
  existingDisputes: new Set(),
  allowedSubsidiaryIds: null,
  reviewScopes: [],
  outcome: "posted",
  refusal: false,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.psp-disputes-route-test')]
      export const db = {
        execute(query, mode) {
          const inMode = (result) => (mode === 'objects' ? result.rows : result)
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
            return Promise.resolve({ rows: id ? [{ id }] : [] }).then(inMode)
          }
          return Promise.resolve({ rows: [] }).then(inMode)
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
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
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

      export async function approveDisputeReview(orgId, disputeId, actorId, scope) {
        state.reviewScopes.push(scope)
        if(state.refusal)throw new PspAutomationError('This review is resolved; reopen its posted financial record to inspect it.')
        state.reviewCalls.push({action:'submit',disputeId})
        return {status:state.outcome,disputeId,documents:state.outcome==='posted'?['doc-1']:[]}
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/platform/database", "mock:db"],
  ["@openbooks/engine/payments/refund-automation", "mock:automation"],
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
  routeState.allowedSubsidiaryIds = null;
  routeState.reviewScopes = [];
  routeState.outcome = "posted";
  routeState.refusal = false;
}

test("native submission receives the authenticated legal-entity scope", async () => {
  reset();
  const scope = new Set(["22222222-2222-4222-8222-222222222222"]);
  routeState.allowedSubsidiaryIds = scope;
  assert.equal((await post({ action: "submit", disputeId: DISPUTE_ID })).status, 200);
  assert.deepEqual(routeState.reviewScopes, [scope]);
});

test("an ungated native submission returns the posted outcome", async () => {
  reset();
  const response = await post({ action: "submit", disputeId: DISPUTE_ID });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "posted",
    disputeId: DISPUTE_ID,
    documents: ["doc-1"],
  });
  assert.deepEqual(routeState.reviewCalls, [{ action: "submit", disputeId: DISPUTE_ID }]);
});

test("a tenant-gated submission remains pending with an accepted response", async () => {
  reset();
  routeState.outcome = "pending_review";
  const response = await post({ action: "submit", disputeId: DISPUTE_ID });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    status: "pending_review",
    disputeId: DISPUTE_ID,
    documents: [],
  });
});

test("module decisions cannot bypass tenant Flow gates", async () => {
  reset();
  for (const action of ["approve", "reject"]) {
    assert.equal(
      (await post({ action, disputeId: DISPUTE_ID, reason: "Provider advice reviewed" })).status,
      400,
    );
  }
  assert.deepEqual(routeState.reviewCalls, []);
});

test("an unknown review is a tenant-opaque refusal before submission", async () => {
  reset();
  routeState.existingDisputes.clear();
  assert.equal((await post({ action: "submit", disputeId: DISPUTE_ID })).status, 404);
  assert.deepEqual(routeState.reviewCalls, []);
});

test("a resolved review preserves the native lifecycle refusal", async () => {
  reset();
  routeState.refusal = true;
  const response = await post({ action: "submit", disputeId: DISPUTE_ID });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /review is resolved/);
});

test("a reader without banking.reconcile cannot submit", async () => {
  reset();
  routeState.permissions = new Set(["banking.read"]);
  assert.equal((await post({ action: "submit", disputeId: DISPUTE_ID })).status, 403);
  assert.deepEqual(routeState.reviewCalls, []);
});
