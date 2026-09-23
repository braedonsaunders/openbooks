import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sealJson } from "@openbooks/engine/src/platform/secrets.ts";

process.env.OPENBOOKS_DATA_KEY ??=
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

const stateKey = Symbol.for("openbooks.qbo-oauth-callback-test");
const secrets = sealJson({ clientId: "qbo-client", clientSecret: "qbo-secret" });
const state = {
  connection: {
    id: "conn-1",
    orgId: "org-1",
    source: "qbo",
    secrets,
    config: { environment: "sandbox" },
    displayName: "QBO",
    status: "pending",
  },
  updated: null as Record<string, unknown> | null,
  accessToken: "at",
  companyInfo: [{ CompanyName: "Demo" }] as { CompanyName?: string }[],
  companyInfoError: null as Error | null,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      export function guardUnrestrictedScope(authz) { return authz.allowedSubsidiaryIds == null ? null : new Response(JSON.stringify({ error: "requires unrestricted subsidiary access" }), { status: 403 }) }
      export async function guardPermission() {
        return { user: { orgId: "org-1", id: "user-1" }, permissions: new Set(), allowedSubsidiaryIds: null }
      }
    `,
  ],
  [
    "mock:connection",
    `
      const state = globalThis[Symbol.for("openbooks.qbo-oauth-callback-test")]
      export async function getConnection() { return state.connection }
    `,
  ],
  [
    "mock:qbo",
    `
      const state = globalThis[Symbol.for("openbooks.qbo-oauth-callback-test")]
      export async function exchangeCode() {
        return { accessToken: state.accessToken, refreshToken: "rt", expiresAt: "2099-01-01T00:00:00.000Z" }
      }
      export class QboClient {
        async queryAll() {
          if (state.companyInfoError) throw state.companyInfoError
          return state.companyInfo
        }
      }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for("openbooks.qbo-oauth-callback-test")]
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
  ["mock:audit", `export function connectionAuditChanges() { return { event: "oauth_connected" } }`],
  ["mock:email-tokens", `export function appBaseUrl() { return "https://books.example"; }`],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const mocks: Record<string, string> = {
      "../../../../../../../lib/authz": "mock:authz",
      "@openbooks/engine/src/sync/connection.ts": "mock:connection",
      "@openbooks/engine/src/connectors/qbo.ts": "mock:qbo",
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

const qbo_oauth_callbackUrl = './route.ts?qbo-oauth-callback'
const { GET } = (await import(qbo_oauth_callbackUrl)) as typeof import('./route.ts');
const qbo_oauth_callback_flowUrl = '../../_flow.ts?qbo-oauth-callback-flow'
const { CONNECTION_OAUTH_COOKIE, mintConnectionOauthState } = (await import(qbo_oauth_callback_flowUrl)) as typeof import('../../_flow.ts');
hooks.deregister();


function resetQbo(): void {
  state.updated = null;
  state.accessToken = "at";
  state.companyInfo = [{ CompanyName: "Demo" }];
  state.companyInfoError = null;
}

function accessTokenForRealm(realm: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ realmid: realm })).toString("base64url");
  return `${header}.${payload}.sig`;
}

async function callback(init: { state: string; cookie?: string | null; realmId?: string }): Promise<Response> {
  const url = new URL("https://evil.example/api/platform/connections/oauth/qbo/callback");
  url.searchParams.set("code", "auth-code");
  url.searchParams.set("state", init.state);
  url.searchParams.set("realmId", init.realmId ?? "realm-1");
  const headers: Record<string, string> = { host: "evil.example" };
  if (init.cookie) headers.cookie = `${CONNECTION_OAUTH_COOKIE}=${init.cookie}`;
  return GET(new Request(url, { headers }));
}

test("QBO callback bounce uses appBaseUrl, not the request Host", async () => {
  const res = await GET(
    new Request("https://evil.example/api/platform/connections/oauth/qbo/callback?error=access_denied"),
  );
  assert.equal(res.headers.get("location"), "https://books.example/sync?oauth=denied");
});

test("a reusable sealed org/connection pair without the cookie nonce is badstate", async () => {
  resetQbo();
  const res = await callback({
    state: sealJson({ orgId: "org-1", connectionId: "conn-1" }),
    cookie: "unrelated-nonce",
  });
  assert.equal(res.headers.get("location"), "https://books.example/sync?oauth=badstate");
  assert.equal(state.updated, null);
});

test("a matching cookie is required to finish the QBO callback", async () => {
  resetQbo();
  const { state: sealed, nonce } = mintConnectionOauthState("org-1", "conn-1");
  const missing = await callback({ state: sealed });
  assert.equal(missing.headers.get("location"), "https://books.example/sync?oauth=badstate");
  const ok = await callback({ state: sealed, cookie: nonce });
  assert.equal(ok.headers.get("location"), "https://books.example/sync?oauth=connected");
});

test("a tampered query realmId that disagrees with the token realm bounces and writes nothing", async () => {
  resetQbo();
  state.accessToken = accessTokenForRealm("authorized-realm");
  const { state: sealed, nonce } = mintConnectionOauthState("org-1", "conn-1");
  const res = await callback({ state: sealed, cookie: nonce, realmId: "tampered-realm" });
  assert.equal(res.headers.get("location"), "https://books.example/sync?oauth=realm");
  assert.equal(state.updated, null);
});

test("CompanyInfo failure without a token realm bounces and writes nothing", async () => {
  resetQbo();
  state.accessToken = "opaque-access-token";
  state.companyInfoError = new Error("QBO CompanyInfo HTTP 401");
  const { state: sealed, nonce } = mintConnectionOauthState("org-1", "conn-1");
  const res = await callback({ state: sealed, cookie: nonce, realmId: "guessed-realm" });
  assert.equal(res.headers.get("location"), "https://books.example/sync?oauth=realm");
  assert.equal(state.updated, null);
});
