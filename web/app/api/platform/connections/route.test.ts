import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.connection-create-route-test");
const routeState = { persisted: 0, restricted: false, listReads: 0 };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for("openbooks.connection-create-route-test")]
      export async function guardPermission() {
        return { user: { orgId: "org-1", id: "user-1" }, allowedSubsidiaryIds: state.restricted ? new Set(["sub-a"]) : null }
      }
      export function guardUnrestrictedScope(authz) {
        return authz.allowedSubsidiaryIds === null
          ? null
          : new Response(JSON.stringify({ error: "requires unrestricted subsidiary access" }), { status: 403 })
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
    "mock:connection",
    `
      export function sourceType(source) {
        if (source === "odoo" || source === "netsuite" || source === "qbo") {
          return {
            source,
            displayName: source,
            authKind: source === "qbo" ? "oauth2" : "token",
            secretFields: [],
            configFields: [
              { key: "url" },
              { key: "host" },
              { key: "database" },
              { key: "environment" },
            ],
          }
        }
        return undefined
      }
      export function validateSourceConfig() { return null }
      export function validateSourceSecret() { return null }
      export const SOURCE_TYPES = []
      export async function listConnections() { globalThis[Symbol.for("openbooks.connection-create-route-test")].listReads += 1; return [] }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for("openbooks.connection-create-route-test")]
      export const db = {
        async execute() { state.listReads += 1; return { rows: [] } },
        async transaction() {
          state.persisted += 1
          throw new Error("create must not persist a refused connector URL")
        },
      }
      export const schema = { connections: {}, auditLog: {} }
    `,
  ],
  [
    "mock:secrets",
    `export function sealJson() { return "sealed" }`,
  ],
  [
    "mock:business-date",
    `export async function businessToday() { return "2026-09-20" }`,
  ],
  [
    "mock:audit",
    `export function connectionAuditChanges() { return {} }`,
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
        : specifier === "../../../../lib/authz"
          ? "mock:authz"
          : specifier === "@openbooks/engine/src/sync/connection.ts"
            ? "mock:connection"
            : specifier === "@openbooks/engine/src/platform/db.ts"
              ? "mock:db"
              : specifier === "@openbooks/engine/src/platform/secrets.ts"
                ? "mock:secrets"
                : specifier === "@openbooks/engine/src/platform/business-date.ts"
                  ? "mock:business-date"
                  : specifier === "@openbooks/schema/src/connections.ts"
                    ? "mock:audit"
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

const connection_create_urlUrl = './route.ts?connection-create-url'
const { GET, POST } = (await import(connection_create_urlUrl)) as typeof import('./route.ts');
hooks.deregister();

const refused = [
  ["loopback IPv4", "odoo", { url: "http://127.0.0.1/" }],
  ["localhost", "odoo", { url: "http://localhost:8069" }],
  ["metadata", "odoo", { url: "http://169.254.169.254/latest/meta-data/" }],
  ["loopback IPv6", "odoo", { url: "http://[::1]/" }],
  ["file scheme", "odoo", { url: "file:///etc/passwd" }],
  ["NetSuite host loopback", "netsuite", { host: "https://127.0.0.1" }],
  ["IPv4-mapped IPv6 hex", "odoo", { url: "http://[::ffff:7f00:1]/" }],
  ["IPv4-mapped IPv6 dotted", "odoo", { url: "http://[::ffff:127.0.0.1]/" }],
  ["RFC1918 10.0.0.1", "odoo", { url: "http://10.0.0.1/" }],
  ["IPv6 ULA fd00::1", "odoo", { url: "http://[fd00::1]/" }],
  ["unspecified 0.0.0.0", "odoo", { url: "http://0.0.0.0/" }],
] as const;

for (const [name, source, config] of refused) {
  test(`create refuses a ${name} connector URL with 400`, async () => {
    routeState.persisted = 0;
    const response = await POST(
      new Request("http://openbooks.test/api/platform/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source, config }),
      }),
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as { errorCode?: string; error?: string };
    assert.equal(body.errorCode, "CONNECTOR_URL_REFUSED");
    assert.match(String(body.error), /loopback|link-local|metadata|http/i);
    assert.equal(routeState.persisted, 0, "must not persist a refused connector URL");
  });
}

const oauthKeys = ["realmId", "tenantId", "companyId", "companyName"] as const;

for (const key of oauthKeys) {
  test(`create refuses callback-owned ${key} by name`, async () => {
    routeState.persisted = 0;
    const response = await POST(
      new Request("http://openbooks.test/api/platform/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "qbo",
          config: { environment: "sandbox", [key]: "attacker-bound" },
        }),
      }),
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as { errorCode?: string; error?: string };
    assert.equal(body.errorCode, "OAUTH_IDENTITY_REFUSED");
    assert.match(String(body.error), new RegExp(key));
    assert.equal(routeState.persisted, 0, "must not persist callback-owned OAuth identity");
  });
}

test("restricted connector managers cannot list org-wide connection and run metadata", async () => {
  routeState.restricted = true;
  routeState.listReads = 0;
  const response = await GET();
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
  assert.equal(routeState.listReads, 0, "the org-wide connector registry and run metadata are not queried");
});

test("restricted connector managers cannot create org-wide connections", async () => {
  routeState.restricted = true;
  routeState.persisted = 0;
  const response = await POST(new Request("http://openbooks.test/api/platform/connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "odoo", config: { url: "https://1.1.1.1" } }),
  }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
  assert.equal(routeState.persisted, 0);
  routeState.restricted = false;
});
