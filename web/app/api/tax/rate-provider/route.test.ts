import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = pathToFileURL(`${process.cwd()}/`).href;
const state = { saves: [] as unknown[][] };
Object.assign(globalThis, { __taxRateProviderRouteTestState: state });

const mocks = new Map<string, string>([
  ["mock:authz", `
    export async function guardPermission() {
      return { user: { orgId: "org-1", id: "user-1" } };
    }
    export function guardUnrestrictedScope() { return null; }
  `],
  ["mock:rate-providers", `
    const state = globalThis.__taxRateProviderRouteTestState;
    export class TaxRateProviderError extends Error {}
    export async function saveTaxRateProviderConfig(...args) { state.saves.push(args); }
    export async function readTaxRateProviderConfigView() { return null; }
    export async function quoteExternalTax() { return {}; }
    export function quoteFromRate() { return {}; }
  `],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "../../../../lib/authz") return { shortCircuit: true, url: "mock:authz" };
    if (specifier === "@openbooks/engine/src/tax/rate-providers.ts") {
      return { shortCircuit: true, url: "mock:rate-providers" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`web/${specifier.slice(2)}.ts`, root).href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mocks.get(url);
    return source === undefined
      ? nextLoad(url, context)
      : { format: "module", source, shortCircuit: true };
  },
});

const { PUT } = await import("./route.ts?tax-rate-provider-route-test") as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  state.saves.length = 0;
}

async function put(body: unknown): Promise<{ response: Response; json: Record<string, unknown> }> {
  const response = await PUT(new Request("http://tax.test/api/tax/rate-provider", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { response, json: await response.json() as Record<string, unknown> };
}

test("PUT refuses an omitted revision instead of silently replacing the current provider", async () => {
  reset();
  const { response, json } = await put({ provider: "manual", isEnabled: true });
  assert.equal(response.status, 422);
  assert.match(String(json.error), /expectedUpdatedAt/);
  assert.equal(state.saves.length, 0);
});

test("PUT accepts only explicit booleans and never coerces or defaults isEnabled", async () => {
  reset();
  for (const isEnabled of ["false", undefined]) {
    const { response, json } = await put({ provider: "manual", isEnabled, expectedUpdatedAt: null });
    assert.equal(response.status, 422, `isEnabled ${JSON.stringify(isEnabled)} must be refused`);
    assert.match(String(json.error), /isEnabled.*boolean/);
  }
  assert.equal(state.saves.length, 0);
});

test("PUT passes explicit disabled state and the initial-setup revision to the locked writer", async () => {
  reset();
  const { response } = await put({ provider: "manual", isEnabled: false, expectedUpdatedAt: null });
  assert.equal(response.status, 200);
  assert.equal(state.saves.length, 1);
  assert.equal((state.saves[0]![1] as { isEnabled: boolean }).isEnabled, false);
  assert.deepEqual(state.saves[0]![3], { expectedUpdatedAt: null });
});

test("PUT rejects malformed credential fields instead of silently ignoring the supplied value", async () => {
  reset();
  for (const field of ["apiKey", "accountId", "licenseKey"] as const) {
    const { response, json } = await put({
      provider: "manual", isEnabled: true, expectedUpdatedAt: null, [field]: 17,
    });
    assert.equal(response.status, 422, `${field} with a number must be refused`);
    assert.ok(json.error, `${field} refusal names the request-schema error`);
  }
  assert.equal(state.saves.length, 0);
});

test("PUT preserves absent, null, and non-empty credential values distinctly", async () => {
  reset();
  const { response } = await put({
    provider: "manual", isEnabled: true, expectedUpdatedAt: null,
    accountId: null, licenseKey: "license-1",
  });
  assert.equal(response.status, 200);
  const input = state.saves[0]![1] as Record<string, unknown>;
  assert.equal(input.apiKey, undefined);
  assert.equal(input.accountId, null);
  assert.equal(input.licenseKey, "license-1");
});
