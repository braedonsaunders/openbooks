import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

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
      export async function getConnection() {
        return { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", orgId: "org-1", source: "qbd", displayName: "Desktop", config: { region: "US" } }
      }
      // Mirrors the real declared list (engine/src/sync/connection.ts).
      export const QBD_WEB_CONNECTOR_REGIONS = ["US", "CA", "UK"]
    `,
  ],
  ["mock:email-tokens", `export function appBaseUrl() { return "https://books.example"; }`],
  [
    "mock:i18n",
    `export async function getTranslations() { return (key) => key }`,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const mocks: Record<string, string> = {
      "../../../../../../lib/authz": "mock:authz",
      "@openbooks/engine/src/sync/connection.ts": "mock:connection",
      "@openbooks/engine/src/flows/email-tokens.ts": "mock:email-tokens",
      "next-intl/server": "mock:i18n",
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

const qwc_origin_testUrl = './route.ts?qwc-origin-test'
const { GET } = (await import(qwc_origin_testUrl)) as typeof import('./route.ts');
hooks.deregister();


test("QWC AppURL and AppSupport pin to appBaseUrl, not the request Host", async () => {
  const res = await GET(
    new Request("https://evil.example/api/platform/connections/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee/qwc", {
      headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
    }),
    { params: Promise.resolve({ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }) },
  );
  assert.equal(res.status, 200);
  const xml = await res.text();
  assert.match(xml, /<AppURL>https:\/\/books\.example\/api\/qbd\/web-connector\/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee<\/AppURL>/);
  assert.match(xml, /<AppSupport>https:\/\/books\.example\/docs\/quickbooks-desktop-connector<\/AppSupport>/);
  assert.equal(xml.includes("evil.example"), false);
});
