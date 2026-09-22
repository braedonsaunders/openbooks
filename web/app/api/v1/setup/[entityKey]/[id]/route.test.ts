import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-setup-id-route-test");
interface RouteState {
  updated: { actor: unknown; entityKey: string; body: unknown } | null;
  deleted: { actor: unknown; entityKey: string; id: string } | null;
}
const routeState: RouteState = { updated: null, deleted: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:v1",
    `
      export async function withV1Request(request, label, operation) {
        const result = await operation(
          { user: { orgId: "org-1", id: "user-1" }, keyId: "key-1" },
          { authz: { user: { orgId: "org-1", id: "user-1" }, permissions: ["admin.setup.manage"] } },
        )
        return Response.json(result.body, {
          status: result.status,
          headers: result.replayed === undefined ? {} : { "idempotency-replayed": String(result.replayed) },
        })
      }
      export async function readV1JsonObject(request) { return await request.json() }
      export function requireV1IdempotencyKey(request) {
        const key = request.headers.get("idempotency-key")?.trim()
        if (!key) throw new Error("Idempotency-Key header is required")
        return key
      }
    `,
  ],
  [
    "mock:context",
    `export function assertApplicationPermission(context, permission) {
      if (permission !== "admin.setup.manage") throw new Error("unexpected permission:" + permission)
    }`,
  ],
  [
    "mock:idempotency",
    `export async function executeIdempotent(args) { return { replayed: false, value: await args.execute() } }`,
  ],
  [
    "mock:catalog",
    `export function settleWrite(result) {
      if (result.status >= 300) throw new Error("refusal:" + result.status)
      return result.body
    }`,
  ],
  [
    "mock:write",
    `
      const state = globalThis[Symbol.for('openbooks.v1-setup-id-route-test')]
      export async function updateSetupRecord(actor, entityKey, body) {
        state.updated = { actor, entityKey, body }
        return { status: 200, body: { id: body.id } }
      }
      export async function deleteSetupRecord(actor, entityKey, id) {
        state.deleted = { actor, entityKey, id }
        return { status: 200, body: { deleted: true } }
      }
    `,
  ],
  [
    "mock:setup-read",
    `
      export async function getSetupRecord(_context, input) {
        return { id: input.id, entityKey: input.entityKey }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../../../lib/application/context", "mock:context"],
  ["../../../../../../lib/application/idempotency", "mock:idempotency"],
  ["../../../../../../lib/application/tool-catalog", "mock:catalog"],
  ["../../../../../../lib/application/setup-read", "mock:setup-read"],
  ["../../../../../../lib/setup/write", "mock:write"],
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

const { GET, PATCH, DELETE } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

const request = (method: string, body: unknown, headers: Record<string, string> = {}) => new Request(
  "http://openbooks.test/api/v1/setup/tax-codes/row-1",
  { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) },
);
const params = { params: Promise.resolve({ entityKey: "tax-codes", id: "row-1" }) };

test("GET /api/v1/setup/[entityKey]/[id] reads through getSetupRecord", async () => {
  const response = await GET(
    new Request("http://openbooks.test/api/v1/setup/tax-codes/row-1"),
    params,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "row-1", entityKey: "tax-codes" });
});

test("PATCH /api/v1/setup/[entityKey]/[id] merges the path id into the writer body", async () => {
  routeState.updated = null;
  const response = await PATCH(request("PATCH", { rate: "7" }, { "idempotency-key": "key-1" }), params);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: "row-1" });
  assert.equal(response.headers.get("idempotency-replayed"), "false");
  assert.deepEqual((routeState as RouteState).updated?.entityKey, "tax-codes");
  assert.deepEqual((routeState as RouteState).updated?.body, { rate: "7", id: "row-1" });
});

test("DELETE /api/v1/setup/[entityKey]/[id] deletes through the Setup command", async () => {
  routeState.deleted = null;
  const response = await DELETE(
    new Request("http://openbooks.test/api/v1/setup/tax-codes/row-1", {
      method: "DELETE",
      headers: { "idempotency-key": "key-1" },
    }),
    params,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: true });
  assert.equal(response.headers.get("idempotency-replayed"), "false");
  assert.deepEqual(routeState.deleted, {
    actor: { orgId: "org-1", id: "user-1", permissions: ["admin.setup.manage"] },
    entityKey: "tax-codes",
    id: "row-1",
  });
});

test("PATCH /api/v1/setup/[entityKey]/[id] requires an Idempotency-Key", async () => {
  await assert.rejects(() => PATCH(request("PATCH", { rate: "7" }), params), /Idempotency-Key header is required/);
});
