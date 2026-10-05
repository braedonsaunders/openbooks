import assert from "node:assert/strict";
import { stubModules } from "../../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-approvals-decide-route-test");
interface RouteState {
  decisions: Array<Record<string, unknown>>;
}

const routeState: RouteState = { decisions: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../../lib/api/v1-request": `
      export async function withV1Request(request, label, operation) {
        try {
          const result = await operation(
            { user: { orgId: "org-1" }, keyId: "key-1" },
            { authz: { user: { orgId: "org-1" } } },
          )
          return Response.json(result.body, { status: result.status })
        } catch (error) {
          return Response.json(
            { error: error.code ?? "internal_error", message: error.message },
            { status: error.status ?? 500 },
          )
        }
      }
      export async function readV1JsonObject(request) {
        return await request.json()
      }
      export function requireV1IdempotencyKey(request) {
        const key = request.headers.get("idempotency-key")
        if (!key) {
          const error = new Error("Idempotency-Key header is required")
          error.code = "invalid_input"
          error.status = 400
          throw error
        }
        return key
      }
    `,
    "../../../../../lib/application/approvals": `
      const state = globalThis[Symbol.for('openbooks.v1-approvals-decide-route-test')]
      export async function decideApproval(_context, input) {
        state.decisions.push(input)
        return { replayed: false, status: 200, result: { gateId: input.gateId, decision: input.decision } }
      }
    `,
  },
});

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");

test("POST /api/v1/approvals/decide records the decision with the idempotency key", async () => {
  routeState.decisions.length = 0;
  const response = await POST(
    new Request("http://openbooks.test/api/v1/approvals/decide", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
        "idempotency-key": "decide-key-1",
      },
      body: JSON.stringify({ gateId: "gate-1", decision: "approved", comment: "looks good" }),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { gateId: "gate-1", decision: "approved" });
  assert.deepEqual(routeState.decisions[0], {
    gateId: "gate-1",
    documentId: undefined,
    decision: "approved",
    comment: "looks good",
    signature: undefined,
    idempotencyKey: "decide-key-1",
  });
});
