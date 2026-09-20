import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { sealJson } from "@openbooks/engine/src/platform/secrets.ts";

process.env.OPENBOOKS_DATA_KEY ??=
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

const stateKey = Symbol.for("openbooks.xero-oauth-callback-test");
interface CallbackState {
  tenants: { tenantId: string; tenantName: string }[];
  connection: Record<string, unknown>;
  updated: Record<string, unknown> | null;
  identityError: string | null;
}
const secrets = sealJson({ clientId: "xero-client", clientSecret: "xero-secret" });
const state: CallbackState = {
  tenants: [
    { tenantId: "first-tenant", tenantName: "First" },
    { tenantId: "stored-tenant", tenantName: "Stored" },
  ],
  connection: {
    id: "conn-1",
    orgId: "org-1",
    source: "xero",
    secrets,
    config: {},
    displayName: "Xero",
    status: "pending",
  },
  updated: null,
  identityError: null,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      export async function guardPermission() {
        return { user: { orgId: "org-1", id: "user-1" }, permissions: new Set(), allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    "mock:connection",
    `
      const state = globalThis[Symbol.for("openbooks.xero-oauth-callback-test")]
      export async function getConnection() {
        if (state.identityError) {
          const error = new Error("invalid input syntax for type uuid")
          error.code = state.identityError
          throw error
        }
        return state.connection
      }
    `,
  ],
  [
    "mock:xero",
    `
      const state = globalThis[Symbol.for("openbooks.xero-oauth-callback-test")]
      export async function exchangeCode() {
        return { accessToken: "at", refreshToken: "rt", expiresAt: "2099-01-01T00:00:00.000Z" }
      }
      export async function listConnections() { return state.tenants }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for("openbooks.xero-oauth-callback-test")]
      export const schema = { connections: { id: "id", orgId: "orgId" }, auditLog: {} }
      export const db = {
        async transaction(fn) {
          let updated = null
          const tx = {
            select() {
              const chain = { from() { return chain }, where() { return chain }, for() { return [state.connection] } }
              return chain
            },
            update() {
              const chain = {
                set(row) { updated = { ...state.connection, ...row }; state.updated = updated; return chain },
                where() { return chain },
                returning() { return [updated] },
              }
              return chain
            },
            insert() { return { values() { return undefined } } },
          }
          return fn(tx)
        },
      }
    `,
  ],
  [
    "mock:audit",
    `export function connectionAuditChanges() { return { event: "oauth_connected" } }`,
  ],
  [
    "mock:email-tokens",
    `export function appBaseUrl() { return "https://books.example"; }`,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const mocks: Record<string, string> = {
      "../../../../../../../lib/authz": "mock:authz",
      "@openbooks/engine/src/sync/connection.ts": "mock:connection",
      "@openbooks/engine/src/connectors/xero.ts": "mock:xero",
      "@openbooks/engine/src/platform/db.ts": "mock:db",
      "@openbooks/schema/src/connections.ts": "mock:audit",
      "@openbooks/engine/src/flows/email-tokens.ts": "mock:email-tokens",
    };
    const url = mocks[specifier];
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    return source === undefined
      ? nextLoad(url, context)
      : { format: "module", shortCircuit: true, source };
  },
});

const xero_oauth_callbackUrl = './route.ts?xero-oauth-callback'
const { GET } = (await import(xero_oauth_callbackUrl)) as typeof import('./route.ts');
const xero_oauth_callback_flowUrl = '../../_flow.ts?xero-oauth-callback-flow'
const { CONNECTION_OAUTH_COOKIE, mintConnectionOauthState } = (await import(xero_oauth_callback_flowUrl)) as typeof import('../../_flow.ts');
hooks.deregister();

const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

function reset(): void {
  state.tenants = [
    { tenantId: "first-tenant", tenantName: "First" },
    { tenantId: "stored-tenant", tenantName: "Stored" },
  ];
  state.connection = {
    id: "conn-1",
    orgId: "org-1",
    source: "xero",
    secrets,
    config: {},
    displayName: "Xero",
    status: "pending",
  };
  state.updated = null;
  state.identityError = null;
}

async function callback(init: { state: string; cookie?: string | null }): Promise<Response> {
  const url = new URL("https://evil.example/api/platform/connections/oauth/xero/callback");
  url.searchParams.set("code", "auth-code");
  url.searchParams.set("state", init.state);
  const headers: Record<string, string> = { host: "evil.example", "x-forwarded-host": "evil.example" };
  if (init.cookie) headers.cookie = `${CONNECTION_OAUTH_COOKIE}=${init.cookie}`;
  return GET(new Request(url, { headers }));
}

test("Xero callback bounce and redirect_uri use appBaseUrl, not the request Host", async () => {
  reset();
  const res = await GET(
    new Request("https://evil.example/api/platform/connections/oauth/xero/callback?error=access_denied", {
      headers: { host: "evil.example" },
    }),
  );
  assert.equal(res.headers.get("location"), "https://books.example/sync?oauth=denied");
});

test("a reusable sealed org/connection pair without the cookie nonce is badstate", async () => {
  reset();
  const reusable = sealJson({ orgId: "org-1", connectionId: "conn-1" });
  const res = await callback({ state: reusable, cookie: "unrelated-nonce" });
  assert.equal(res.headers.get("location"), "https://books.example/sync?oauth=badstate");
  assert.equal(state.updated, null);
});

test("a matching cookie is required; replay after the cookie is cleared is badstate", async () => {
  reset();
  state.tenants = [{ tenantId: "only", tenantName: "Only" }];
  const { state: sealed, nonce } = mintConnectionOauthState("org-1", "conn-1");
  const first = await callback({ state: sealed, cookie: nonce });
  assert.equal(first.headers.get("location"), "https://books.example/sync?oauth=connected");
  const replay = await callback({ state: sealed });
  assert.equal(replay.headers.get("location"), "https://books.example/sync?oauth=badstate");
});

test("Xero callback refuses an ambiguous first-tenant bind by name", async () => {
  reset();
  const { state: sealed, nonce } = mintConnectionOauthState("org-1", "conn-1");
  const res = await callback({ state: sealed, cookie: nonce });
  assert.equal(res.headers.get("location"), "https://books.example/sync?oauth=ambiguous");
  assert.equal(state.updated, null);
});

test("Xero callback pins a prior stored tenantId instead of tenants[0]", async () => {
  reset();
  state.connection = { ...state.connection, config: { tenantId: "stored-tenant" } };
  const { state: sealed, nonce } = mintConnectionOauthState("org-1", "conn-1");
  const res = await callback({ state: sealed, cookie: nonce });
  assert.equal(res.headers.get("location"), "https://books.example/sync?oauth=connected");
  assert.equal((state.updated?.config as { tenantId?: string } | undefined)?.tenantId, "stored-tenant");
});

test("a Postgres 22P02 connection id in state is notfound, not an unhandled 500", async () => {
  reset();
  state.identityError = "22P02";
  const { state: sealed, nonce } = mintConnectionOauthState("org-1", "not-a-uuid");
  const res = await callback({ state: sealed, cookie: nonce });
  assert.equal(res.headers.get("location"), "https://books.example/sync?oauth=notfound");
  assert.equal(state.updated, null);
});

test("the Xero callback never reads origin from the request URL", () => {
  assert.match(routeSource, /connectionOauthRedirectUri\('xero'\)/);
  assert.match(routeSource, /connectionOauthBounce/);
  assert.match(routeSource, /pinProviderChoice/);
  assert.doesNotMatch(routeSource, /new URL\(`\/sync\?oauth=\$\{status\}`, req\.url\)/);
  assert.doesNotMatch(routeSource, /url\.origin/);
  assert.doesNotMatch(routeSource, /trustedRequestOrigin/);
  assert.match(routeSource, /pinProviderChoice\(tenants,/);
  assert.match(routeSource, /storageIdentityError/);
});
