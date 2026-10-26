import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";
import { NextResponse } from "next/server";

const state = {
  allowedSubsidiaryIds: null as Set<string> | null,
  retryCalls: [] as { orgId: string; id: string; actorId: string }[],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[
  Symbol.for("openbooks.provider-retry-scope-test")
] = state;
(globalThis as typeof globalThis & Record<string, unknown>).openbooksProviderRetryNextResponse =
  NextResponse;

const modules = new Map<string, string>([
  [
    "mock:authz",
    `
    const state = globalThis[Symbol.for('openbooks.provider-retry-scope-test')]
    const NextResponse = globalThis.openbooksProviderRetryNextResponse
    export async function guardPermission() {
      return { user: { orgId: 'org-1', id: 'actor-1' }, allowedSubsidiaryIds: state.allowedSubsidiaryIds }
    }
    export function guardUnrestrictedScope(authz) {
      return authz.allowedSubsidiaryIds === null
        ? null
        : NextResponse.json({ error: 'requires unrestricted subsidiary access' }, { status: 403 })
    }
  `,
  ],
  [
    "mock:tax",
    `
    const state = globalThis[Symbol.for('openbooks.provider-retry-scope-test')]
    export class TaxProviderCommitError extends Error {}
    export async function retryProviderTransaction(orgId, id, actorId) {
      state.retryCalls.push({ orgId, id, actorId })
    }
  `,
  ],
  ["mock:preview-invalidation", `export async function invalidateAnalyticsPreviews() {}`],
]);
const urls = new Map<string, string>([
  ["@/lib/authz", "mock:authz"],
  ["@openbooks/engine/tax", "mock:tax"],
  ["@/lib/analytics/preview-invalidation", "mock:preview-invalidation"],
]);
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = urls.get(specifier);
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = modules.get(url);
    return source === undefined
      ? nextLoad(url, context)
      : { format: "module", source, shortCircuit: true };
  },
});
const routeModuleUrl: string = "./route.ts?unrestricted-retry-test";
type RetryRouteModule = typeof import("./route.ts");
const { POST } = (await import(routeModuleUrl)) as RetryRouteModule;
after(() => hooks.deregister());

const transactionId = "00000000-0000-4000-8000-000000000001";

async function retry(): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/tax/provider-transactions/${transactionId}/retry`, {
      method: "POST",
    }),
    { params: Promise.resolve({ id: transactionId }) },
  );
}

test("provider retries refuse subsidiary-restricted callers before service access", async () => {
  state.allowedSubsidiaryIds = new Set(["subsidiary-a"]);
  state.retryCalls = [];

  const response = await retry();

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
  assert.deepEqual(state.retryCalls, []);
});

test("provider retries remain available to unrestricted callers", async () => {
  state.allowedSubsidiaryIds = null;
  state.retryCalls = [];

  const response = await retry();

  assert.equal(response.status, 200);
  assert.deepEqual(state.retryCalls, [{ orgId: "org-1", id: transactionId, actorId: "actor-1" }]);
});
