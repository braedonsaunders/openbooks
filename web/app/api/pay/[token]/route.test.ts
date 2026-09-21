import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// CSRF-exempt POST /api/pay/{token} must not bind PSP success/cancel URLs to
// the request Host. Invoice mail already pins /pay/{token} to appBaseUrl();
// this suite proves the checkout mutation uses that same origin.

const stateKey = Symbol.for("openbooks.pay-route-origin-test");
interface RouteState {
  orgId: string | null;
  featureEnabled: boolean;
  returnUrls: string[];
}
const state: RouteState = { orgId: "org-1", featureEnabled: true, returnUrls: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockSources = new Map<string, string>([
  [
    "mock:acceptance",
    `
      const state = globalThis[Symbol.for("openbooks.pay-route-origin-test")];
      export class PaymentAcceptanceError extends Error {}
      export async function paymentLinkOrgId() { return state.orgId; }
      export async function createCheckoutSession(token, returnUrl) {
        state.returnUrls.push(returnUrl);
        return { redirectUrl: "https://psp.example/checkout" };
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for("openbooks.pay-route-origin-test")];
      export async function isFeatureEnabled() { return state.featureEnabled; }
    `,
  ],
  [
    "mock:email-tokens",
    `export function appBaseUrl() { return "https://books.example"; }`,
  ],
  [
    "mock:next-server",
    `export class NextResponse extends Response {
       static json(value, init) {
         return new NextResponse(JSON.stringify(value), {
           ...init,
           headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
         });
       }
     }`,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocks: Record<string, string> = {
      "@openbooks/engine/src/payments/acceptance.ts": "mock:acceptance",
      "@openbooks/engine/src/flows/email-tokens.ts": "mock:email-tokens",
      "../../../../lib/features": "mock:features",
      "next/server": "mock:next-server",
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

const pay_origin_testUrl = './route.ts?pay-origin-test'
const { POST } = (await import(pay_origin_testUrl)) as typeof import('./route.ts');
hooks.deregister();

const TOKEN = "tok_v1_forged_host";
const routeSource = readFileSync(new URL("./route.ts", import.meta.url), "utf8");

test("hosted checkout pins the PSP return URL to appBaseUrl, not the request Host", async () => {
  state.returnUrls = [];
  const res = await POST(
    new Request(`https://evil.example/api/pay/${TOKEN}`, {
      method: "POST",
      headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
    }),
    { params: Promise.resolve({ token: TOKEN }) },
  );
  assert.equal(res.status, 200);
  assert.deepEqual(state.returnUrls, [`https://books.example/pay/${TOKEN}`]);
  assert.equal(
    state.returnUrls.some((url) => url.includes("evil.example")),
    false,
    "forged Host must not appear in the PSP return URL",
  );
});

test("the pay route never reads origin from the request URL", () => {
  assert.match(
    routeSource,
    /from "@openbooks\/engine\/src\/flows\/email-tokens\.ts"/,
    "checkout return URLs must use the same appBaseUrl as invoice mail",
  );
  assert.match(routeSource, /appBaseUrl\(\)/);
  assert.doesNotMatch(routeSource, /new URL\(req\.url\)\.origin/);
});
