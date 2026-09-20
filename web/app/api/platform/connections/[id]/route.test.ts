import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.connection-patch-route-test");
const routeState = {
  persisted: 0,
  deleteRows: [] as Array<{ id: string }>,
  deletes: 0,
  audits: 0,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return String(query ?? "");
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
        return sqlText(chunk);
      }
      return String(chunk ?? "");
    })
    .join("");
}
(globalThis as typeof globalThis & Record<string, unknown>).connectionIdSqlText =
  sqlText;

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
      const sqlText = globalThis.connectionIdSqlText
      export const db = {
        async transaction(callback) {
          state.persisted += 1
          const tx = {
            async execute(query) {
              const text = sqlText(query)
              if (text.includes("delete from connections")) {
                state.deletes += 1
                return { rows: state.deleteRows }
              }
              if (text.includes("insert into audit_log")) {
                state.audits += 1
                return { rows: [] }
              }
              return { rows: [] }
            },
          }
          return callback(tx)
        },
      }
      export const schema = { connections: {} }
    `,
  ],
  [
    "mock:connection",
    `
      export function sourceType() {
        return {
          source: "qbo",
          secretFields: [],
          configFields: [{ key: "environment" }, { key: "url" }, { key: "host" }],
        }
      }
      export function validateSourceConfig() { return null }
      export function validateSourceSecret() { return null }
      export async function getConnection() {
        return {
          id: "connection-1",
          source: "qbo",
          displayName: "QBO",
          authKind: "oauth2",
          status: "active",
          config: { environment: "sandbox" },
          secrets: "sealed",
          mirrorEnabled: false,
          mirrorSchedule: "daily",
          postedChangePolicy: "review_required",
        }
      }
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
    `export function connectionAuditChanges() { return { event: "connection_deleted" } }`,
  ],
  [
    "mock:storage",
    `export function storageIdentityError() { return false }`,
  ],
  [
    "mock:drizzle",
    `
      export function sql(strings, ...values) {
        return { queryChunks: strings.flatMap((part, index) => index < values.length ? [part, values[index]] : [part]) }
      }
      export function and() { return {} }
      export function eq() { return {} }
    `,
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
                        : specifier === "drizzle-orm"
                          ? "mock:drizzle"
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

const { PATCH, DELETE } = (await import("./route.ts?connection-id-url")) as typeof import("./route.ts");
hooks.deregister();

const refused = [
  ["loopback IPv4", { url: "http://127.0.0.1/" }],
  ["localhost", { url: "http://localhost:8069" }],
  ["metadata", { url: "http://169.254.169.254/latest/meta-data/" }],
  ["loopback IPv6", { url: "http://[::1]/" }],
  ["file scheme", { url: "file:///etc/passwd" }],
  ["NetSuite host loopback", { host: "https://127.0.0.1" }],
  ["IPv4-mapped IPv6 hex", { url: "http://[::ffff:7f00:1]/" }],
  ["IPv4-mapped IPv6 dotted", { url: "http://[::ffff:127.0.0.1]/" }],
] as const;

function patch(config: Record<string, unknown>): Promise<Response> {
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
    const response = await patch({ ...config });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { errorCode?: string; error?: string };
    assert.equal(body.errorCode, "CONNECTOR_URL_REFUSED");
    assert.match(String(body.error), /loopback|link-local|metadata|http/i);
    assert.equal(routeState.persisted, 0, "must not persist a refused connector URL");
  });
}

for (const key of ["realmId", "tenantId", "companyId", "companyName"] as const) {
  test(`PATCH refuses callback-owned ${key} by name`, async () => {
    routeState.persisted = 0;
    const response = await patch({ environment: "sandbox", [key]: "attacker-bound" });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { errorCode?: string; error?: string };
    assert.equal(body.errorCode, "OAUTH_IDENTITY_REFUSED");
    assert.match(String(body.error), new RegExp(key));
    assert.equal(routeState.persisted, 0, "must not merge callback-owned OAuth identity");
  });
}

test("DELETE matching zero rows is a failure with no audit", async () => {
  routeState.deleteRows = [];
  routeState.deletes = 0;
  routeState.audits = 0;
  const response = await DELETE(
    new Request("http://openbooks.test/api/platform/connections/connection-1", {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: "connection-1" }) },
  );
  assert.equal(response.status, 404);
  const body = (await response.json()) as { ok?: boolean; error?: string };
  assert.notEqual(body.ok, true);
  assert.equal(routeState.deletes, 1);
  assert.equal(routeState.audits, 0, "zero-row delete must not write an audit event");
});

test("DELETE matching a row writes audit and reports ok", async () => {
  routeState.deleteRows = [{ id: "connection-1" }];
  routeState.deletes = 0;
  routeState.audits = 0;
  const response = await DELETE(
    new Request("http://openbooks.test/api/platform/connections/connection-1", {
      method: "DELETE",
    }),
    { params: Promise.resolve({ id: "connection-1" }) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(routeState.deletes, 1);
  assert.equal(routeState.audits, 1);
});
