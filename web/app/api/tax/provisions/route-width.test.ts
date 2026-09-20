import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Route boundary suite: a provision amount wider than numeric(19,4) must be
// refused (400) before the run — the engine measures in unbounded bigint
// units and persists the results, so a pasted 20-digit figure sails through
// and dies in Postgres as a raw storage failure (HTTP 500) instead.
const stateKey = Symbol.for("openbooks.tax-provision-width-route-test");
interface ProvisionCreateCall {
  input: { lossCarryforwardUsed: string };
}
const routeState: { calls: ProvisionCreateCall[] } = { calls: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const root = pathToFileURL(process.cwd() + "/").href;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      export async function guardPermission(permission) {
        if (permission !== 'reports.create') {
          throw new Error('unexpected permission gate: ' + permission)
        }
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: null }
      }
      export function guardSubsidiaryScope() { return null }
    `,
  ],
  [
    "mock:income-tax-provision",
    `
      const state = globalThis[Symbol.for('openbooks.tax-provision-width-route-test')]
      export class IncomeTaxProvisionError extends Error {}
      export async function computeProvisionRun(orgId, fiscalYear, input, actorId) {
        state.calls.push({ orgId, fiscalYear, input, actorId })
        return 'run-1'
      }
      export async function listProvisionRuns() { return [] }
      export async function orgTaxFramework() { return null }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  [
    "@openbooks/engine/src/tax-returns/income-tax-provision.ts",
    "mock:income-tax-provision",
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    if (specifier === "@/lib/api/json") {
      return nextResolve(root + "web/lib/api/json.ts", context);
    }
    const mocked = mockUrls.get(specifier);
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

const { POST } = (await import("./route.ts")) as typeof import("./route.ts");
hooks.deregister();

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/tax/provisions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("POST refuses a provision amount wider than numeric(19,4) before the run", async () => {
  routeState.calls.length = 0;

  const response = await post({
    fiscalYear: 2026,
    lossCarryforwardUsed: "99999999999999999999.99",
  });

  assert.equal(response.status, 400, JSON.stringify(await response.json()));
  assert.equal(
    routeState.calls.length,
    0,
    "a refused amount must never reach the provision run",
  );
});

test("POST still runs an ordinary provision", async () => {
  routeState.calls.length = 0;

  const response = await post({
    fiscalYear: 2026,
    lossCarryforwardUsed: "1000.00",
  });

  assert.equal(response.status, 201, JSON.stringify(await response.json()));
  assert.equal(routeState.calls.length, 1);
});
