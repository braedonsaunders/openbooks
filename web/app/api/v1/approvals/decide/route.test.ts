import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-approvals-decide-route-test");
interface RouteState {
  decisions: Array<Record<string, unknown>>;
}

const routeState: RouteState = { decisions: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:v1",
    `
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
  ],
  [
    "mock:approvals",
    `
      const state = globalThis[Symbol.for('openbooks.v1-approvals-decide-route-test')]
      export async function decideApproval(_context, input) {
        state.decisions.push(input)
        return { replayed: false, status: 200, result: { gateId: input.gateId, decision: input.decision } }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../../lib/application/approvals", "mock:approvals"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { POST } = (await import("./route.ts?v1-approvals-decide")) as typeof import("./route.ts");
hooks.deregister();

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
    paymentRunId: undefined,
    decision: "approved",
    comment: "looks good",
    signature: undefined,
    idempotencyKey: "decide-key-1",
  });
});
