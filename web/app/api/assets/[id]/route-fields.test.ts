import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// PATCH /api/assets/[id] legacy-sentence parity after the ../_fields
// extraction. The validation RULES moved to the shared module (single source
// with POST /api/assets); this file proves the WORDING did not move with
// them — every sentence below is the exact refusal existing clients receive.
//
// Only the database and the session gate are doubled. All validation,
// revision-token, decimal, and JSON-boundary code runs REAL.

const stateKey = Symbol.for("openbooks.asset-patch-parity-test");
const ORG_ID = "00000000-0000-4000-8000-00000000a021";
const USER_ID = "00000000-0000-4000-8000-00000000a022";
const ASSET_ID = "00000000-0000-4000-8000-00000000a023";
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000d021";
const FORMULA_ID = "00000000-0000-4000-8000-00000000d022";

interface RouteState {
  queries: string[];
}

const state: RouteState = { queries: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

function inspect(query: unknown): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  function walk(node: unknown, collect: boolean): string {
    if (
      typeof node === "string" ||
      typeof node === "number" ||
      typeof node === "bigint" ||
      typeof node === "boolean" ||
      node === null ||
      node === undefined
    ) {
      if (collect) params.push(node);
      return String(node);
    }
    if (Array.isArray(node)) return node.map((item) => walk(item, collect)).join("");
    if (typeof node === "object") {
      const rec = node as Record<string, unknown>;
      if ("queryChunks" in rec) return walk(rec.queryChunks, collect);
      if ("value" in rec) {
        if ((rec as { constructor?: { name?: string } }).constructor?.name === "Param") {
          params.push(rec.value);
          return String(rec.value);
        }
        return walk(rec.value, false);
      }
    }
    return "";
  }
  const chunks = (query as { queryChunks?: unknown })?.queryChunks;
  return { text: walk(chunks, true), params };
}

(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksAssetPatchInspect = inspect;

const EXISTING = {
  id: ASSET_ID,
  status: "draft",
  custom: {},
  acquisition_cost: "100.0000",
  salvage_value: "0.0000",
  in_service_on: null,
  depreciation_method: "straight_line",
  depreciation_method_id: null,
  useful_life_months: 60,
  depreciation_rate_percent: null,
  depreciation_units_total: null,
  depreciation_convention: "full_month",
  opening_accumulated_depreciation: null,
  opening_accumulated_as_of: null,
};

const mockDb = `
  const state = globalThis[Symbol.for('openbooks.asset-patch-parity-test')]
  const inspect = globalThis.openbooksAssetPatchInspect
  function respond(query) {
    const seen = inspect(query)
    const text = seen.text
    if (text.includes('from fixed_assets')) {
      // The pre-transaction existence read sees the row; the in-transaction
      // row lock finds nothing, proving a clean save passes validation and
      // reaches the lock.
      if (text.includes('for update')) return { rows: [] }
      return { rows: [${JSON.stringify(EXISTING)}] }
    }
    return { rows: [] }
  }
  async function execute(query) {
    state.queries.push(inspect(query).text)
    return respond(query)
  }
  export const db = {
    execute,
    transaction: async (work) => work({ execute }),
  }
`;

const mockSources = new Map<string, string>([
  ["mock:db", mockDb],
  [
    "mock:feature-gates",
    `export async function guardFeaturePermission() {
       return {
         user: { orgId: '${ORG_ID}', id: '${USER_ID}' },
         allowedSubsidiaryIds: null,
       }
     }`,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["../../../../lib/feature-gates", "mock:feature-gates"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    if (specifier.startsWith("@/") && context.parentURL) {
      const parentDir = decodeURIComponent(new URL(".", context.parentURL).href);
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot === -1) return nextResolve(specifier, context);
      return nextResolve(
        new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts").href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined)
      return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?asset-patch-parity-test";
const routeModule = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { PATCH } = routeModule;

function patch(body: Record<string, unknown>): Promise<Response> {
  return PATCH(
    new Request(`http://openbooks.test/api/assets/${ASSET_ID}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedUpdatedAt: "1", ...body }),
    }),
    { params: Promise.resolve({ id: ASSET_ID }) },
  );
}

async function errorOf(body: Record<string, unknown>): Promise<{ status: number; error: string }> {
  const res = await patch(body);
  const data = (await res.json()) as { error?: string };
  return { status: res.status, error: String(data.error) };
}

test("a clean save passes validation and reaches the row lock", async () => {
  const { status, error } = await errorOf({});
  // No validation fires; the mocked lock finds no row.
  assert.equal(status, 422);
  assert.equal(error, "asset not found");
});

const cases: [Record<string, unknown>, string][] = [
  [{ method: "sideways" }, "Invalid depreciation method"],
  [{ method: null }, "Invalid depreciation method"],
  [{ convention: "never" }, "Invalid depreciation convention"],
  [{ lifeMonths: "0" }, "Depreciation periods must be a whole number between 1 and 12000"],
  [{ ratePercent: "abc" }, "Rate must be an exact non-negative percent"],
  [{ unitsTotal: "-3" }, "Expected lifetime units must be an exact positive quantity"],
  [{ depreciationMethodId: "not-a-uuid" }, "Invalid depreciation formula"],
  [{ depreciationMethodId: FORMULA_ID }, "Depreciation formula not found or inactive"],
  [{ assetAccountId: ACCOUNT_ID }, "Invalid asset account"],
  [
    { accumulatedDepreciationAccountId: ACCOUNT_ID },
    "Invalid accumulated depreciation account",
  ],
  [
    { depreciationExpenseAccountId: ACCOUNT_ID },
    "Invalid depreciation expense account",
  ],
  [{ taxDepreciation: [] }, "Invalid tax depreciation elections"],
  [
    { taxDepreciation: { us: { businessUsePercent: "150" } } },
    "Business use must be between 0 and 100 percent",
  ],
  [
    { taxDepreciation: { us: { bonusPercent: "101" } } },
    "Bonus depreciation must be between 0 and 100 percent",
  ],
  [
    { taxDepreciation: { us: { section179: "-5" } } },
    "Section 179 must be non-negative",
  ],
  [
    { taxDepreciation: { us: { classCode: "NOPE" } } },
    "Invalid tax depreciation class",
  ],
  [{ openingAccumulated: "abc" }, "Opening accumulated depreciation must be a number"],
  [{ openingAccumulated: "-1" }, "Opening accumulated depreciation must be a non-negative number"],
  [
    { openingAccumulated: "10", openingAsOf: "2026-13-01" },
    "Opening as-of date must be a real calendar date (YYYY-MM-DD)",
  ],
  [
    { openingAccumulated: "10" },
    "Opening accumulated depreciation and its as-of date must be set together",
  ],
  [
    { openingAccumulated: "5000", openingAsOf: "2026-01-01" },
    "Opening accumulated depreciation cannot exceed cost minus salvage",
  ],
  [
    {
      openingAccumulated: "10",
      openingAsOf: "2026-01-01",
      inServiceOn: "2026-03-01",
    },
    "Opening as-of date cannot precede the in-service month",
  ],
];

for (const [body, sentence] of cases) {
  test(`PATCH refuses with its legacy sentence: ${sentence}`, async () => {
    const { status, error } = await errorOf(body);
    assert.equal(status, 422);
    assert.equal(error, sentence);
  });
}
