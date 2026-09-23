import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sealJson, unsealJson } from "@openbooks/engine/src/platform/secrets.ts";

process.env.OPENBOOKS_DATA_KEY ??=
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

const stateKey = Symbol.for("openbooks.xero-oauth-start-test");
interface StartState {
  source: string;
  secrets: string;
  identityError: string | null;
}
const state: StartState = {
  source: "xero",
  secrets: sealJson({ clientId: "xero-client" }),
  identityError: null,
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
      const state = globalThis[Symbol.for("openbooks.xero-oauth-start-test")]
      export async function getConnection() {
        if (state.identityError) {
          const error = new Error("invalid input syntax for type uuid")
          error.code = state.identityError
          throw error
        }
        return {
          id: "conn-1",
          orgId: "org-1",
          source: state.source,
          secrets: state.secrets,
          config: {},
          displayName: "Xero",
          status: "pending",
        }
      }
    `,
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

const xero_oauth_startUrl = './route.ts?xero-oauth-start'
const { GET } = (await import(xero_oauth_startUrl)) as typeof import('./route.ts');
const xero_oauth_start_flowUrl = '../../_flow.ts?xero-oauth-start-flow'
const { CONNECTION_OAUTH_COOKIE } = (await import(xero_oauth_start_flowUrl)) as typeof import('../../_flow.ts');
hooks.deregister();


function cookieMap(response: Response): Map<string, string> {
  const raw =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") ?? ""];
  const out = new Map<string, string>();
  for (const header of raw) {
    const pair = header.split(";")[0] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) out.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return out;
}

test("Xero start pins redirect_uri to appBaseUrl, not the request Host", async () => {
  const res = await GET(
    new Request("https://evil.example/api/platform/connections/oauth/xero/start?connectionId=conn-1", {
      headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
    }),
  );
  assert.equal(res.status, 307);
  const location = new URL(res.headers.get("location") ?? "");
  assert.equal(
    location.searchParams.get("redirect_uri"),
    "https://books.example/api/platform/connections/oauth/xero/callback",
  );
  assert.equal(location.searchParams.get("redirect_uri")?.includes("evil.example"), false);
});

test("Xero start mints a one-time nonce in sealed state and the CSRF cookie", async () => {
  const res = await GET(
    new Request("https://evil.example/api/platform/connections/oauth/xero/start?connectionId=conn-1"),
  );
  const location = new URL(res.headers.get("location") ?? "");
  const sealed = location.searchParams.get("state");
  assert.ok(sealed);
  const payload = unsealJson<{ orgId?: string; connectionId?: string; nonce?: string; exp?: number }>(sealed);
  assert.equal(payload?.orgId, "org-1");
  assert.equal(payload?.connectionId, "conn-1");
  assert.equal(typeof payload?.nonce, "string");
  assert.ok((payload?.nonce?.length ?? 0) >= 16);
  assert.equal(typeof payload?.exp, "number");
  assert.ok((payload?.exp ?? 0) > Date.now() / 1000);
  const cookies = cookieMap(res);
  assert.equal(cookies.get(CONNECTION_OAUTH_COOKIE), payload?.nonce);
});


test("a Postgres 22P02 connection id is 404, not an unhandled 500", async () => {
  state.identityError = "22P02";
  try {
    const res = await GET(
      new Request("https://books.example/api/platform/connections/oauth/xero/start?connectionId=not-a-uuid"),
    );
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not found" });
  } finally {
    state.identityError = null;
  }
});
