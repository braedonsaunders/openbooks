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
    entities?: unknown;
    presentationCurrency?: unknown;
  };
  actorId: string;
  scope: unknown;
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
      export async function computeProvisionRun(orgId, fiscalYear, input, actorId, scope) {
        state.calls.push({ orgId, fiscalYear, input, actorId, scope })
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

test("POST refuses a populated row without a description instead of dropping it", async () => {
  for (const body of [
    { fiscalYear: 2026, permanentDifferences: [{ description: "", amount: "25000" }] },
    { fiscalYear: 2026, permanentDifferences: [{ description: "   ", amount: "25000" }] },
    {
      fiscalYear: 2026,
      additionalDifferences: [{ description: "", category: "provisions", difference: "25000" }],
    },
    {
      fiscalYear: 2026,
      additionalDifferences: [{ category: "provisions", difference: "25000" }],
    },
    {
      fiscalYear: 2026,
      additionalDifferences: [{ description: "", category: "provisions" }],
    },
  ]) {
    routeState.calls.length = 0;
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    const payload = (await response.json()) as { error: string };
    assert.match(payload.error, /description is required/);
    assert.equal(routeState.calls.length, 0, "a refused row must never reach the provision run");
  }

  // The row index is named so the preparer can find the offending grid line.
  routeState.calls.length = 0;
  const indexed = await post({
    fiscalYear: 2026,
    permanentDifferences: [
      { description: "Meals", amount: "10.00" },
      { description: "", amount: "25000" },
    ],
  });
  assert.equal(indexed.status, 400);
  assert.deepEqual(await indexed.json(), {
    error: "permanentDifferences[1]: description is required when an amount is provided",
  });
  assert.equal(routeState.calls.length, 0);
});

test("a blank first row does not shift a later refusal off its grid row", async () => {
  routeState.calls.length = 0;
  const response = await post({
    fiscalYear: 2026,
    permanentDifferences: [
      { description: "", amount: "" },
      { description: "", amount: "25000" },
    ],
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "permanentDifferences[1]: description is required when an amount is provided",
  });
  assert.equal(routeState.calls.length, 0);
});

test("a described row with an empty amount refuses by row instead of an unnamed amount error", async () => {
  for (const body of [
    {
      fiscalYear: 2026,
      permanentDifferences: [{ description: "Meals", amount: "" }],
      expect: "permanentDifferences[0]: amount is required when a description is provided",
    },
    {
      fiscalYear: 2026,
      additionalDifferences: [{ description: "Lease", category: "other", difference: "" }],
      expect: "additionalDifferences[0]: difference is required when a description is provided",
    },
  ]) {
    routeState.calls.length = 0;
    const { expect, ...request } = body;
    const response = await post(request);
    assert.equal(response.status, 400, JSON.stringify(request));
    assert.deepEqual(await response.json(), { error: expect });
    assert.equal(routeState.calls.length, 0);
  }

  routeState.calls.length = 0;
  const entity = await post({
    fiscalYear: 2026,
    entities: {
      "sub-1": { permanentDifferences: [{ description: "Meals", amount: "" }] },
    },
  });
  assert.equal(entity.status, 400);
  assert.deepEqual(await entity.json(), {
    error: 'entities["sub-1"].permanentDifferences[0]: amount is required when a description is provided',
  });
  assert.equal(routeState.calls.length, 0);
});

test("POST rejects non-array top-level difference lists instead of ignoring them", async () => {
  for (const body of [
    { fiscalYear: 2026, permanentDifferences: "bogus" },
    { fiscalYear: 2026, additionalDifferences: { description: "Lease", category: "other", difference: "1" } },
  ]) {
    routeState.calls.length = 0;
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(routeState.calls.length, 0);
  }
});

test("POST refuses a populated per-entity row without a description, naming the row", async () => {
  routeState.calls.length = 0;
  const response = await post({
    fiscalYear: 2026,
    entities: {
      "sub-1": {
        permanentDifferences: [{ description: "", amount: "50.00" }],
      },
    },
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'entities["sub-1"].permanentDifferences[0]: description is required when an amount is provided',
  });
  assert.equal(routeState.calls.length, 0);
});

test("POST treats a pristine grid row (default category, no data) as blank, never a refusal", async () => {
  routeState.calls.length = 0;
  const response = await post({
    fiscalYear: 2026,
    permanentDifferences: [{ description: "Meals", amount: "10.00" }],
    // Exactly what the compute grid sends for an untouched trailing line:
    // no description, no difference, category still on its "other" default.
    additionalDifferences: [{ description: "", category: "other", difference: "" }],
  });
  assert.equal(response.status, 201);
  assert.equal(routeState.calls.length, 1);
  assert.deepEqual(routeState.calls[0]!.input.permanentDifferences, [
    { description: "Meals", amount: "10.0000" },
  ]);
  assert.deepEqual(routeState.calls[0]!.input.additionalDifferences, []);
});

test("POST still refuses a deliberately chosen category with no description", async () => {
  routeState.calls.length = 0;
  const response = await post({
    fiscalYear: 2026,
    additionalDifferences: [{ description: "", category: "provisions", difference: "" }],
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "additionalDifferences[0]: description is required when an amount or category is provided",
  });
  assert.equal(routeState.calls.length, 0);
});

test("POST still skips truly empty grid rows at root and per-entity level", async () => {
  routeState.calls.length = 0;
  const response = await post({
    fiscalYear: 2026,
    permanentDifferences: [{ description: "" }, { description: "Meals", amount: "10.00" }],
    additionalDifferences: [{ description: "", category: "", difference: "" }],
    entities: {
      "sub-1": {
        permanentDifferences: [{ description: "" }],
        additionalDifferences: [{ description: "", category: "", difference: "" }],
      },
    },
  });
  assert.equal(response.status, 201);
  assert.equal(routeState.calls.length, 1);
  assert.deepEqual(routeState.calls[0]!.input.permanentDifferences, [
    { description: "Meals", amount: "10.0000" },
  ]);
  assert.deepEqual(routeState.calls[0]!.input.additionalDifferences, []);
  assert.deepEqual(routeState.calls[0]!.input.entities, { "sub-1": {} });
});

test("POST passes per-entity inputs and presentation currency to the run", async () => {
  routeState.calls.length = 0;

  const response = await post({
    fiscalYear: 2026,
    permanentDifferences: [{ description: "Root meals", amount: "10.00" }],
    entities: {
      "sub-1": {
        permanentDifferences: [{ description: "Meals", amount: "50.00" }],
        additionalDifferences: [
          { description: "Lease", category: "provisions", difference: "10.00" },
        ],
        lossCarryforwardUsed: "5.00",
        valuationAllowance: "1.00",
      },
    },
    presentationCurrency: "USD",
  });

  assert.equal(response.status, 201);
  assert.equal(routeState.calls.length, 1);
  const input = routeState.calls[0]!.input as Record<string, unknown>;
  assert.deepEqual(input.entities, {
    "sub-1": {
      permanentDifferences: [{ description: "Meals", amount: "50.0000" }],
      additionalDifferences: [
        {
          category: "provisions",
          description: "Lease",
          difference: "10.0000",
          source: "manual",
        },
      ],
      lossCarryforwardUsed: "5.0000",
      valuationAllowance: "1.0000",
    },
  });
  assert.equal(input.presentationCurrency, "USD");
});

test("POST forwards the caller's subsidiary scope so unknown entity keys fail loudly", async () => {
  routeState.calls.length = 0;

  const response = await post({ fiscalYear: 2026 });

  assert.equal(response.status, 201);
  assert.equal(routeState.calls.length, 1);
  assert.equal("scope" in routeState.calls[0]!, true);
  assert.equal(routeState.calls[0]!.scope, null);
});

test("POST omits entity keys when no per-entity inputs are given", async () => {
  routeState.calls.length = 0;

  const response = await post({ fiscalYear: 2026 });

  assert.equal(response.status, 201);
  assert.equal(routeState.calls.length, 1);
  const input = routeState.calls[0]!.input as Record<string, unknown>;
  assert.equal("entities" in input, false);
  assert.equal("presentationCurrency" in input, false);
});

test("POST refuses malformed per-entity inputs without reaching the run", async () => {
  for (const entities of [
    [],
    { "sub-1": null },
    {
      "sub-1": {
        permanentDifferences: [{ description: "Meals", amount: "bogus" }],
      },
    },
    {
      "sub-1": {
        additionalDifferences: [
          { description: "Lease", category: "typo", difference: "10.00" },
        ],
      },
    },
    { "sub-1": { lossCarryforwardUsed: "bogus" } },
    { "sub-1": { permanentDifferences: "bogus" } },
  ]) {
    routeState.calls.length = 0;
    const response = await post({ fiscalYear: 2026, entities });
    assert.equal(response.status, 400, JSON.stringify(entities));
    assert.deepEqual(await response.json(), {
      error: "invalid provision entities",
    });
    assert.equal(routeState.calls.length, 0);
  }
});

test("POST refuses non-object grid rows by indexed path instead of skipping them", async () => {
  // A grid element that is not a plain object reads as "blank" through
  // optional chaining — without the shape refusal each of these computes with
  // [] and saves an understated provision with 201.
  const shapes: { name: string; value: unknown }[] = [
    { name: "string", value: "25000" },
    { name: "null", value: null },
    { name: "number", value: 42 },
    { name: "nested array", value: [{ description: "Meals", amount: "10.00" }] },
  ];
  for (const { name, value } of shapes) {
    for (const body of [
      { fiscalYear: 2026, permanentDifferences: [value] },
      { fiscalYear: 2026, additionalDifferences: [value] },
    ]) {
      routeState.calls.length = 0;
      const response = await post(body);
      assert.equal(response.status, 400, `${name}: ${JSON.stringify(body)}`);
      const payload = (await response.json()) as { error: string };
      assert.match(payload.error, /^\S+\[0\]: each row must be an object with/);
      assert.equal(routeState.calls.length, 0, `${name} must never reach the provision run`);
    }
    for (const key of ["permanentDifferences", "additionalDifferences"] as const) {
      routeState.calls.length = 0;
      const response = await post({
        fiscalYear: 2026,
        entities: { "sub-1": { [key]: [value] } },
      });
      assert.equal(response.status, 400, `per-entity ${name}: ${key}`);
      const payload = (await response.json()) as { error: string };
      assert.match(
        payload.error,
        new RegExp(`^entities\\["sub-1"\\]\\.${key}\\[0\\]: each row must be an object with`),
      );
      assert.equal(routeState.calls.length, 0, `per-entity ${name} must never reach the provision run`);
    }
  }

  // The refusal names the exact grid row, matching the described-row errors.
  routeState.calls.length = 0;
  const indexed = await post({
    fiscalYear: 2026,
    permanentDifferences: [{ description: "Meals", amount: "10.00" }, null],
  });
  assert.equal(indexed.status, 400);
  assert.deepEqual(await indexed.json(), {
    error: "permanentDifferences[1]: each row must be an object with description and amount",
  });
  assert.equal(routeState.calls.length, 0);

  routeState.calls.length = 0;
  const temporary = await post({
    fiscalYear: 2026,
    additionalDifferences: ["25000"],
  });
  assert.equal(temporary.status, 400);
  assert.deepEqual(await temporary.json(), {
    error: "additionalDifferences[0]: each row must be an object with description, category and difference",
  });
  assert.equal(routeState.calls.length, 0);
});

test("POST refuses a malformed presentation currency without reaching the run", async () => {
  for (const presentationCurrency of ["US", "usd", "USDD", 123, ""]) {
    routeState.calls.length = 0;
    const response = await post({ fiscalYear: 2026, presentationCurrency });
    assert.equal(response.status, 400, JSON.stringify(presentationCurrency));
    assert.deepEqual(await response.json(), {
      error: "invalid presentation currency",
    });
    assert.equal(routeState.calls.length, 0);
  }
});
