import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-banking-routes-test");
interface RouteState {
  started: Array<Record<string, unknown>>;
  signedOff: Array<Record<string, unknown>>;
  matched: Array<Record<string, unknown>>;
}

const routeState: RouteState = { started: [], signedOff: [], matched: [] };
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
          const headers = result.replayed === undefined ? {} : { "idempotency-replayed": String(result.replayed) }
          return Response.json(result.body, { status: result.status, headers })
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
    "mock:banking",
    `
      const state = globalThis[Symbol.for('openbooks.v1-banking-routes-test')]
      export async function startReconciliationSession(_context, input) {
        state.started.push(input)
        return { replayed: false, result: { reconciliationId: "rec-1" } }
      }
      export async function signOffReconciliation(_context, input) {
        state.signedOff.push(input)
        return { replayed: false, result: { reconciled: true } }
      }
      export async function matchStatementLine(_context, input) {
        state.matched.push(input)
        return { replayed: false, result: { totals: { difference: "0" } } }
      }
      export async function matchStatementLineWithJournal(_context, input) {
        state.matched.push(input)
        return { replayed: false, result: { matched: true } }
      }
      export async function unmatchStatementLineAction(_context, input) {
        state.matched.push(input)
        return { replayed: false, result: { totals: { difference: "0" } } }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../../lib/application/banking", "mock:banking"],
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

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

test("POST /api/v1/banking/reconciliations passes body fields and the idempotency key through", async () => {
  routeState.started.length = 0;
  const response = await POST(
    new Request("http://openbooks.test/api/v1/banking/reconciliations", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
        "idempotency-key": "banking-key-1",
      },
      body: JSON.stringify({
        accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        throughDate: "2026-01-31",
        statementBalance: "1234.56",
      }),
    }),
  );
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { reconciliationId: "rec-1" });
  assert.deepEqual(routeState.started[0], {
    accountId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    throughDate: "2026-01-31",
    statementBalance: "1234.56",
    idempotencyKey: "banking-key-1",
  });
});

test("POST /api/v1/banking/reconciliations refuses a missing Idempotency-Key", async () => {
  const response = await POST(
    new Request("http://openbooks.test/api/v1/banking/reconciliations", {
      method: "POST",
      headers: { authorization: "Bearer test-key", "content-type": "application/json" },
      body: JSON.stringify({ accountId: "x", throughDate: "2026-01-31", statementBalance: "1.00" }),
    }),
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string };
  assert.equal(body.error, "invalid_input");
});
