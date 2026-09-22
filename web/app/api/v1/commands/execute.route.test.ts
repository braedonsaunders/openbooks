import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-command-exec-test");
interface RouteState {
  executed: Array<{ name: string; input: unknown }>;
}

const routeState: RouteState = { executed: [] };
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
    "mock:errors",
    `
      export class ApplicationError extends Error {
        constructor(code, message, status, details) {
          super(message)
          this.code = code
          this.status = status
          this.details = details
        }
      }
    `,
  ],
  [
    "mock:tools",
    `
      const state = globalThis[Symbol.for('openbooks.v1-command-exec-test')]
      const postJournal = {
        name: "post_journal",
        readOnly: false,
      }
      export function applicationTool(name) {
        return name === "post_journal" ? postJournal : undefined
      }
      export async function executeApplicationTool(definition, context, input) {
        state.executed.push({ name: definition.name, input })
        return { ok: true, status: "posted" }
      }
    `,
  ],
  ["mock:visible", `export function applicationToolVisible() { return true }`],
  ["mock:features", `export async function resolvedFeatureState() { return {} }`],
]);

const mockUrls = new Map<string, string>([
  ["../../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../../lib/application/errors", "mock:errors"],
  ["../../../../../lib/application/tool-catalog", "mock:tools"],
  ["../../../../../lib/assistant/registry", "mock:visible"],
  ["../../../../../lib/features", "mock:features"],
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

const { POST } = (await import("./[name]/route.ts?v1-command-exec")) as typeof import("./[name]/route.ts");
hooks.deregister();

function post(name: string, body: unknown, idempotencyKey?: string): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/v1/commands/${name}`, {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
        ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ name }) },
  );
}

test("POST /api/v1/commands/:name executes a visible catalog command", async () => {
  routeState.executed.length = 0;
  const response = await post("post_journal", { documentId: "11111111-1111-1111-1111-111111111111" }, "cmd-key-1");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, status: "posted" });
  assert.equal(routeState.executed[0]?.name, "post_journal");
  assert.equal(
    (routeState.executed[0]?.input as { idempotencyKey?: string }).idempotencyKey,
    "cmd-key-1",
  );
});

test("POST /api/v1/commands/:name refuses an unknown command by name", async () => {
  const response = await post("not_a_command", {}, "cmd-key-2");
  assert.equal(response.status, 404);
  const body = await response.json() as { error: string; message: string };
  assert.equal(body.error, "not_found");
  assert.match(body.message, /not_a_command/);
});
