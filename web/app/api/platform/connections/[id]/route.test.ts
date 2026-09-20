import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.connection-patch-route-test");
const routeState = { persisted: 0 };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      export async function guardPermission() {
        return { user: { orgId: "org-1", id: "user-1" } }
      }
    `,
  ],
  [
    "mock:json",
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        return { ok: true, data: await request.json() }
      }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for("openbooks.connection-patch-route-test")]
      export const db = {
        async transaction() {
          state.persisted += 1
          throw new Error("PATCH must not persist a refused connector URL")
        },
      }
      export const schema = { connections: {} }
    `,
  ],
  [
    "mock:connection",
    `
      export function sourceType() { return { source: "odoo", secretFields: [] } }
      export function validateSourceConfig() { return null }
      export function validateSourceSecret() { return null }
      export async function getConnection() { return { id: "connection-1" } }
    `,
  ],
  [
    "mock:secrets",
    `
      export function sealJson() { return "sealed" }
      export function unsealJson() { return {} }
    `,
  ],
  [
    "mock:business-date",
    `export async function businessToday() { return "2026-09-20" }`,
  ],
  [
    "mock:mirror",
    `export function nextMirrorAt() { return new Date() }`,
  ],
  [
    "mock:audit",
    `export function connectionAuditChanges() { return {} }`,
  ],
  [
    "mock:storage",
    `export function storageIdentityError() { return false }`,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    const mocked =
      specifier === "@/lib/api/json"
        ? "mock:json"
        : specifier === "../../../../../lib/authz"
          ? "mock:authz"
          : specifier === "@openbooks/engine/src/platform/db.ts"
            ? "mock:db"
            : specifier === "@openbooks/engine/src/sync/connection.ts"
              ? "mock:connection"
              : specifier === "@openbooks/engine/src/platform/secrets.ts"
                ? "mock:secrets"
                : specifier === "@openbooks/engine/src/platform/business-date.ts"
                  ? "mock:business-date"
                  : specifier === "@openbooks/engine/src/sync/mirror-schedule.ts"
                    ? "mock:mirror"
                    : specifier === "@openbooks/schema/src/connections.ts"
                      ? "mock:audit"
                      : specifier === "../_storage-identity"
                        ? "mock:storage"
                        : undefined;
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined)
      return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { PATCH } = (await import("./route.ts?connection-patch-url")) as typeof import("./route.ts");
hooks.deregister();

const refused = [
  ["loopback IPv4", { url: "http://127.0.0.1/" }],
  ["localhost", { url: "http://localhost:8069" }],
  ["metadata", { url: "http://169.254.169.254/latest/meta-data/" }],
  ["loopback IPv6", { url: "http://[::1]/" }],
  ["file scheme", { url: "file:///etc/passwd" }],
  ["NetSuite host loopback", { host: "https://127.0.0.1" }],
] as const;

function call(config: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request("http://openbooks.test/api/platform/connections/connection-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config }),
    }),
    { params: Promise.resolve({ id: "connection-1" }) },
  );
}

for (const [name, config] of refused) {
  test(`PATCH refuses a ${name} connector URL with 400`, async () => {
    routeState.persisted = 0;
    const response = await call({ ...config });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { errorCode?: string; error?: string };
    assert.equal(body.errorCode, "CONNECTOR_URL_REFUSED");
    assert.match(String(body.error), /loopback|link-local|metadata|http/i);
    assert.equal(routeState.persisted, 0, "must not persist a refused connector URL");
  });
}
