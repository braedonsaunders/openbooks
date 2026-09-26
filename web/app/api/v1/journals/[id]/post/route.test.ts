import assert from "node:assert/strict";
import { stubModules } from "../../../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-journal-post-route-test");
interface RouteState {
  calls: Array<Record<string, unknown>>;
}

const routeState: RouteState = { calls: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../../../lib/api/v1-request": `
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
    "../../../../../../lib/application/documents": `
      const state = globalThis[Symbol.for('openbooks.v1-journal-post-route-test')]
      export async function postJournalDocument(_context, input) {
        state.calls.push(input)
        return { replayed: false, status: 200, result: { id: input.documentId, status: "posted" } }
      }
    `,
  },
});

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");

function post(id: string, idempotencyKey?: string): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/v1/journals/${id}/post`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
    }),
    { params: Promise.resolve({ id }) },
  );
}

test("POST /api/v1/journals/:id/post posts via postJournalDocument", async () => {
  routeState.calls.length = 0;
  const response = await post("journal-1", "journal-key-1");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "journal-1", status: "posted" });
  assert.deepEqual(routeState.calls, [
    { documentId: "journal-1", idempotencyKey: "journal-key-1" },
  ]);
});

test("POST /api/v1/journals/:id/post requires an idempotency key", async () => {
  routeState.calls.length = 0;
  const response = await post("journal-2");
  assert.equal(response.status, 400);
  assert.equal(routeState.calls.length, 0);
});
