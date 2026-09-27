import assert from "node:assert/strict";
import { stubModules } from "../../../../testing/stub-modules";
import test from "node:test";
import { z } from "zod";

const stateKey = Symbol.for("openbooks.v1-command-exec-test");
const zodKey = Symbol.for("openbooks.v1-command-exec-zod");
interface RouteState {
  executed: Array<{ name: string; input: unknown }>;
}

const routeState: RouteState = { executed: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;
(globalThis as typeof globalThis & Record<symbol, unknown>)[zodKey] = z;

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
    "../../../../../lib/application/errors": `
      export class ApplicationError extends Error {
        constructor(code, message, status, details) {
          super(message)
          this.code = code
          this.status = status
          this.details = details
        }
      }
    `,
    "../../../../../lib/application/tool-catalog": `
      const state = globalThis[Symbol.for('openbooks.v1-command-exec-test')]
      const z = globalThis[Symbol.for('openbooks.v1-command-exec-zod')]
      const postJournal = {name:"post_journal",readOnly:false,inputSchema:z.object({documentId:z.string().uuid(),idempotencyKey:z.string().min(8)})}
      export function applicationTool(name) { return name === "post_journal" ? postJournal : undefined }
      export async function executeApplicationTool(definition, context, input) { state.executed.push({name:definition.name,input}); return {ok:true,status:"posted"} }
    `,
    "../../../../../lib/assistant/registry": `export function applicationToolVisible() { return true }`,
    "../../../../../lib/features": `export async function resolvedFeatureState() { return {} }`,
  },
});

const { POST } = (await import("./[name]/route.ts")) as typeof import("./[name]/route.ts");

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
