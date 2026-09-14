import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Route boundary suite: a described temporary difference with an unknown
// category must be refused (400), never silently dropped from the provision
// run — the sibling [id] suite covers the read boundary with the same seams.
const stateKey = Symbol.for("openbooks.tax-provision-create-route-test");
interface ProvisionCreateCall {
  orgId: string;
  fiscalYear: number;
  input: {
    permanentDifferences: unknown[];
    additionalDifferences: unknown[];
    lossCarryforwardUsed: string;
    valuationAllowance: string;
  };
  actorId: string;
}
interface RouteState {
  calls: ProvisionCreateCall[];
}
const routeState: RouteState = { calls: [] };
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
      const state = globalThis[Symbol.for('openbooks.tax-provision-create-route-test')]
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
    "@openbooks/engine/src/income-tax-provision.ts",
    "mock:income-tax-provision",
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    // The collection route reaches the JSON body helper through the @/
    // alias, which the plain runner does not resolve — point it at the real
    // module so body parsing keeps its production behaviour.
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

test("POST refuses a described difference with an unknown category", async () => {
  routeState.calls.length = 0;

  const response = await post({
    fiscalYear: 2026,
    additionalDifferences: [
      { description: "Lease incentive", category: "typo", difference: "100.00" },
    ],
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "invalid temporary-difference category",
  });
  assert.equal(
    routeState.calls.length,
    0,
    "a refused difference must never reach the provision run",
  );
});

test("POST keeps a valid categorized difference and skips empty grid rows", async () => {
  routeState.calls.length = 0;

  const response = await post({
    fiscalYear: 2026,
    additionalDifferences: [
      { description: "", category: "", difference: "" },
      {
        description: "Lease incentive",
        category: "revenue_recognition",
        difference: "100.00",
      },
    ],
  });

  assert.equal(response.status, 201);
  assert.equal(routeState.calls.length, 1);
  assert.deepEqual(
    routeState.calls[0]!.input.additionalDifferences,
    [
      {
        category: "revenue_recognition",
        description: "Lease incentive",
        difference: "100.0000",
        source: "manual",
      },
    ],
  );
});
