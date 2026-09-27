import assert from "node:assert/strict";
import { stubModules } from "../../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-settings-company-route-test");
interface RouteState {
  labels: string[];
  readOrg: string | null;
  asserted: string | null;
  updated: { actor: unknown; changes: unknown } | null;
  permissions: string[];
}
const routeState: RouteState = {
  labels: [],
  readOrg: null,
  asserted: null,
  updated: null,
  permissions: ["admin.setup.manage"],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../../lib/api/v1-request": `
      const state = globalThis[Symbol.for('openbooks.v1-settings-company-route-test')]
      export async function withV1Request(request, label, operation) {
        state.labels.push(label)
        const result = await operation(
          { user: { orgId: "org-1", id: "user-1" }, keyId: "key-1" },
          { authz: { user: { orgId: "org-1", id: "user-1" }, permissions: state.permissions } },
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
    "../../../../../lib/application/context": `
      const state = globalThis[Symbol.for('openbooks.v1-settings-company-route-test')]
      export function assertApplicationPermission(context, permission) { state.asserted = permission }
    `,
    "../../../../../lib/application/errors": `export class ApplicationError extends Error {
      constructor(code, message, status, details) { super(message); this.code = code; this.status = status; this.details = details }
    }`,
    "../../../../../lib/authz": `
      const state = globalThis[Symbol.for('openbooks.v1-settings-company-route-test')]
      export function can(authz, permission) { return state.permissions.includes(permission) }
    `,
    "../../../../../lib/application/idempotency": `export async function executeIdempotent(args) { return { replayed: false, value: await args.execute() } }`,
    "../../../../../lib/application/tool-catalog": `export function settleWrite(result) {
      if (result.status >= 300) throw new Error("refusal:" + result.status)
      return result.body
    }`,
    "../../../../../lib/company-settings": `
      const state = globalThis[Symbol.for('openbooks.v1-settings-company-route-test')]
      export async function readCompanySettings(orgId) {
        state.readOrg = orgId
        return { status: 200, body: { org: { name: "Acme" } } }
      }
      export async function updateCompanySettings(actor, changes) {
        state.updated = { actor, changes }
        return { status: 200, body: { ok: true, changed: true } }
      }
    `,
  },
});

const { GET, PATCH } = (await import("./route.ts")) as typeof import("./route.ts");

const json = (body: unknown, headers: Record<string, string> = {}) => new Request("http://openbooks.test/api/v1/settings/company", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

test("GET /api/v1/settings/company reads through readCompanySettings", async () => {
  routeState.permissions = ["admin.setup.manage"];
  const response = await GET(new Request("http://openbooks.test/api/v1/settings/company"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { org: { name: "Acme" } });
  assert.equal(routeState.readOrg, "org-1");
});

test("GET /api/v1/settings/company refuses readers without settings authority", async () => {
  routeState.permissions = ["gl.post"];
  const response = await GET(new Request("http://openbooks.test/api/v1/settings/company"));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "forbidden", code: "forbidden" });
  routeState.permissions = ["admin.setup.manage"];
});

test("PATCH /api/v1/settings/company wraps updateCompanySettings idempotently", async () => {
  routeState.updated = null;
  routeState.asserted = null;
  const response = await PATCH(json({ changes: { name: "Acme Ltd" } }, { "idempotency-key": "key-1" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, changed: true });
  assert.equal(response.headers.get("idempotency-replayed"), "false");
  assert.equal(routeState.asserted, "admin.setup.manage");
  assert.deepEqual(routeState.updated, {
    actor: { orgId: "org-1", id: "user-1" },
    changes: { name: "Acme Ltd" },
  });
});

test("PATCH /api/v1/settings/company also accepts top-level setting keys", async () => {
  routeState.updated = null;
  const response = await PATCH(json({ name: "Acme Ltd" }, { "idempotency-key": "key-1" }));
  assert.equal(response.status, 200);
  assert.deepEqual((routeState as RouteState).updated?.changes, { name: "Acme Ltd" });
});

test("PATCH /api/v1/settings/company requires an Idempotency-Key", async () => {
  await assert.rejects(() => PATCH(json({ changes: { name: "Acme Ltd" } })), /Idempotency-Key header is required/);
});

test("PATCH /api/v1/settings/company refuses empty changes", async () => {
  const response = await PATCH(json({ changes: {} }, { "idempotency-key": "key-1" }));
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), { error: "changes must name at least one setting", code: "invalid_input" });
});
