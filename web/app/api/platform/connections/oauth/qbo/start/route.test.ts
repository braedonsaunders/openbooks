import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { sealJson, unsealJson } from "@openbooks/engine/src/platform/secrets.ts";

process.env.OPENBOOKS_DATA_KEY ??=
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";

const stateKey = Symbol.for("openbooks.qbo-oauth-start-test");
const state = { secrets: sealJson({ clientId: "qbo-client" }) };
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
      const state = globalThis[Symbol.for("openbooks.qbo-oauth-start-test")]
      export async function getConnection() {
        return {
          id: "conn-1",
          orgId: "org-1",
          source: "qbo",
          secrets: state.secrets,
          config: { environment: "sandbox" },
          displayName: "QBO",
          status: "pending",
        }
      }
    `,
  ],
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

const { GET } = (await import("./route.ts?qbo-oauth-start")) as typeof import("./route.ts");
const { CONNECTION_OAUTH_COOKIE } = (await import("../../_flow.ts?qbo-oauth-start-flow")) as typeof import("../../_flow.ts");
hooks.deregister();

const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

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

test("QBO start pins redirect_uri to appBaseUrl, not the request Host", async () => {
  const res = await GET(
    new Request("https://evil.example/api/platform/connections/oauth/qbo/start?connectionId=conn-1", {
      headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
    }),
  );
  const location = new URL(res.headers.get("location") ?? "");
  assert.equal(
    location.searchParams.get("redirect_uri"),
    "https://books.example/api/platform/connections/oauth/qbo/callback",
  );
});

test("QBO start mints a one-time nonce in sealed state and the CSRF cookie", async () => {
  const res = await GET(
    new Request("https://evil.example/api/platform/connections/oauth/qbo/start?connectionId=conn-1"),
  );
  const location = new URL(res.headers.get("location") ?? "");
  const payload = unsealJson<{ nonce?: string }>(location.searchParams.get("state"));
  assert.ok((payload?.nonce?.length ?? 0) >= 16);
  assert.equal(cookieMap(res).get(CONNECTION_OAUTH_COOKIE), payload?.nonce);
});

test("the QBO start route never reads origin from the request URL", () => {
  assert.match(routeSource, /connectionOauthRedirectUri\('qbo'\)/);
  assert.doesNotMatch(routeSource, /new URL\(req\.url\)\.origin/);
  assert.doesNotMatch(routeSource, /trustedRequestOrigin/);
});
