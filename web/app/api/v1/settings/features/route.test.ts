import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.v1-settings-features-route-test");
interface RouteState {
  applied: { orgId: string; actorId: string; changes: unknown } | null;
  appliedResult: { ok: true; before: unknown; after: unknown } | { ok: false; error: string; key?: string };
  normalized: { ok: true; changes: Record<string, boolean> } | { ok: false; error: string; key?: string };
  normalizedInput: unknown;
}
const routeState: RouteState = {
  applied: null,
  appliedResult: { ok: true, before: {}, after: { projects: true } },
  normalized: { ok: true, changes: { projects: true } },
  normalizedInput: null,
};
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
    "mock:errors",
    `
      export class ApplicationError extends Error {
        constructor(code, message, status, details) { super(message); this.code = code; this.status = status; this.details = details }
      }
      export function conflict(message, details) { throw new Error("conflict:" + message) }
      export function notFound(resource) { throw new Error("not_found:" + resource) }
    `,
  ],
  [
    "mock:idempotency",
    `export async function executeIdempotent(args) { return { replayed: false, value: await args.execute() } }`,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.v1-settings-features-route-test')]
      export function normalizeFeatureChanges(input) { state.normalizedInput = input; return state.normalized }
      export async function applyFeatureChanges(orgId, actorId, changes) {
        state.applied = { orgId, actorId, changes }
        return state.appliedResult
      }
    `,
  ],
  [
    "mock:setup-read",
    `
      export async function listApplicationFeatures() {
        return { features: [{ key: "projects", enabled: true }] }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../../lib/api/v1-request", "mock:v1"],
  ["../../../../../lib/application/context", "mock:context"],
  ["../../../../../lib/application/errors", "mock:errors"],
  ["../../../../../lib/application/idempotency", "mock:idempotency"],
  ["../../../../../lib/application/setup-read", "mock:setup-read"],
  ["../../../../../lib/features-admin", "mock:features"],
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

const { GET, POST } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

const post = (body: unknown, headers: Record<string, string> = {}) => new Request("http://openbooks.test/api/v1/settings/features", {
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

test("GET /api/v1/settings/features lists through listApplicationFeatures", async () => {
  const response = await GET(new Request("http://openbooks.test/api/v1/settings/features"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { features: [{ key: "projects", enabled: true }] });
});

test("POST /api/v1/settings/features applies normalized changes", async () => {
  routeState.normalized = { ok: true, changes: { projects: true } };
  routeState.appliedResult = { ok: true, before: { projects: false }, after: { projects: true } };
  routeState.applied = null;
  const response = await POST(post({ features: { projects: true } }, { "idempotency-key": "key-1" }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    before: { projects: false },
    after: { projects: true },
  });
  assert.equal(response.headers.get("idempotency-replayed"), "false");
  assert.deepEqual(routeState.applied, { orgId: "org-1", actorId: "user-1", changes: { projects: true } });
});

test("POST /api/v1/settings/features also accepts a top-level feature map", async () => {
  routeState.normalized = { ok: true, changes: { projects: true } };
  routeState.appliedResult = { ok: true, before: {}, after: { projects: true } };
  routeState.normalizedInput = null;
  await POST(post({ projects: true }, { "idempotency-key": "key-1" }));
  assert.deepEqual(routeState.normalizedInput, { projects: true });
});

test("POST /api/v1/settings/features refuses unknown feature keys without applying", async () => {
  routeState.normalized = { ok: false, error: "invalid-feature", key: "nope" };
  routeState.applied = null;
  await assert.rejects(
    () => POST(post({ features: { nope: true } }, { "idempotency-key": "key-1" })),
    /invalid-feature/,
  );
  assert.equal(routeState.applied, null);
});

test("POST /api/v1/settings/features surfaces command refusals by name", async () => {
  routeState.normalized = { ok: true, changes: { subsidiaries: false } };
  routeState.appliedResult = { ok: false, error: "feature-blocked", key: "subsidiaries" };
  await assert.rejects(
    () => POST(post({ features: { subsidiaries: false } }, { "idempotency-key": "key-1" })),
    /conflict:feature-blocked/,
  );
});
