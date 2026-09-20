import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

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
      export async function getConnection() {
        return { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", orgId: "org-1", source: "qbd", displayName: "Desktop" }
      }
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

const { GET } = (await import("./route.ts?qwc-origin-test")) as typeof import("./route.ts");
hooks.deregister();

const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

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

test("the QWC route never reads origin from the request URL", () => {
  assert.match(routeSource, /from '@openbooks\/engine\/src\/flows\/email-tokens\.ts'/);
  assert.match(routeSource, /appBaseUrl\(\)/);
  assert.doesNotMatch(routeSource, /new URL\(req\.url\)\.origin/);
  assert.doesNotMatch(routeSource, /trustedRequestOrigin/);
});
