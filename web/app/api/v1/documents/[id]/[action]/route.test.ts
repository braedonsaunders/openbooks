import assert from "node:assert/strict";
import { stubModules } from "../../../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-document-action-route-test");
interface Call {
  fn: string;
  input: Record<string, unknown>;
}
interface RouteState {
  calls: Call[];
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
    "../../../../../../lib/application/errors": `
      export class ApplicationError extends Error {
        constructor(code, message, status, details) {
          super(message)
          this.code = code
          this.status = status
          this.details = details
        }
      }
    `,
    "../../../../../../lib/application/documents": `
      const state = globalThis[Symbol.for('openbooks.v1-document-action-route-test')]
      export async function advanceDocumentLifecycle(_context, input) {
        state.calls.push({ fn: "advance", input })
        return { replayed: false, status: 200, result: { ok: true, action: input.action } }
      }
      export async function voidDocument(_context, input) {
        state.calls.push({ fn: "void", input })
        return { replayed: false, status: 200, result: { ok: true, action: "void" } }
      }
      export async function correctPostedDocument(_context, input) {
        state.calls.push({ fn: "correct", input })
        return { replayed: false, status: 200, result: { ok: true, action: "correct" } }
      }
    `,
  },
});

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");

function post(id: string, action: string, body?: unknown, idempotencyKey = "doc-action-key-1"): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/v1/documents/${id}/${action}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id, action }) },
  );
}

test("POST submit dispatches to advanceDocumentLifecycle", async () => {
  routeState.calls.length = 0;
  const response = await post("doc-1", "submit");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, action: "submit" });
  assert.deepEqual(routeState.calls, [
    { fn: "advance", input: { documentId: "doc-1", action: "submit", idempotencyKey: "doc-action-key-1" } },
  ]);
});

test("POST post dispatches to advanceDocumentLifecycle", async () => {
  routeState.calls.length = 0;
  const response = await post("doc-2", "post");
  assert.equal(response.status, 200);
  assert.deepEqual(routeState.calls[0], {
    fn: "advance",
    input: { documentId: "doc-2", action: "post", idempotencyKey: "doc-action-key-1" },
  });
});

test("POST void dispatches to voidDocument with reason and reversal date", async () => {
  routeState.calls.length = 0;
  const response = await post("doc-3", "void", { reason: "duplicate", reversalDate: "2026-09-01" });
  assert.equal(response.status, 200);
  assert.deepEqual(routeState.calls[0], {
    fn: "void",
    input: {
      documentId: "doc-3",
      reason: "duplicate",
      reversalDate: "2026-09-01",
      reversalPeriodId: null,
      idempotencyKey: "doc-action-key-1",
    },
  });
});

test("POST correct dispatches to correctPostedDocument", async () => {
  routeState.calls.length = 0;
  const correction = { lines: [] };
  const response = await post("doc-4", "correct", { correction });
  assert.equal(response.status, 200);
  assert.deepEqual(routeState.calls[0], {
    fn: "correct",
    input: { documentId: "doc-4", correction, idempotencyKey: "doc-action-key-1" },
  });
});

test("POST unknown action refuses with 404 and reaches no writer", async () => {
  routeState.calls.length = 0;
  const response = await post("doc-5", "approve", {});
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: string; message: string };
  assert.equal(body.error, "not_found");
  assert.match(body.message, /approve/);
  assert.equal(routeState.calls.length, 0);
});
