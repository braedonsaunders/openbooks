import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// Canonical unsaved-create contract for fixed assets (exemplar: POST
// /api/accounts). Opening New allocates no record, number, category, or
// audit row — allocation happens only here, on Save, as one idempotent
// tenant-scoped validated insert with a single audit event.
//
// Only the database and the session gate are doubled. Validation, UUID,
// decimal, canonical-JSON, and the JSON boundary all run REAL so the refusal
// tests cannot pass against a permissive copy.

const stateKey = Symbol.for("openbooks.asset-create-route-test");
const ORG_ID = "00000000-0000-4000-8000-00000000a011";
const OTHER_ORG_ID = "00000000-0000-4000-8000-00000000a099";
const USER_ID = "00000000-0000-4000-8000-00000000a012";
const CATEGORY_ID = "00000000-0000-4000-8000-00000000c001";
const SUBSIDIARY_ID = "00000000-0000-4000-8000-00000000b001";
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000d001";

interface AssetRow {
  id: string;
  org_id: string;
  asset_number: string;
}

interface RouteState {
  allowedSubsidiaryIds: string[] | null;
  subsidiaries: { id: string }[];
  categories: { id: string }[];
  accounts: { id: string }[];
  assets: AssetRow[];
  audits: { row_id: string; org_id: string; request_id: string; after: unknown }[];
  queries: string[];
}

const state: RouteState = {
  allowedSubsidiaryIds: null,
  subsidiaries: [{ id: SUBSIDIARY_ID }],
  categories: [{ id: CATEGORY_ID }],
  accounts: [],
  assets: [],
  audits: [],
  queries: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

// Flatten a drizzle query to text AND collect bound scalar params in order.
// Text drives query-kind matching; params drive storage simulation. The
// insert/audit column orders are fixed by the route under test and read
// positionally here.
function inspect(query: unknown): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  function walk(node: unknown, collect: boolean): string {
    // Bound values arrive as raw primitives inside queryChunks; literal SQL
    // arrives wrapped in StringChunk objects whose value arrays hold plain
    // text. Literals are never storage params, so collection stops inside
    // any non-Param wrapper.
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
).openbooksAssetCreateInspect = inspect;

const mockDb = `
  const state = globalThis[Symbol.for('openbooks.asset-create-route-test')]
  const inspect = globalThis.openbooksAssetCreateInspect
  function respond(query) {
    const seen = inspect(query)
    const text = seen.text
    const params = seen.params
    if (text.includes('pg_advisory_xact_lock')) return { rows: [{}] }
    if (text.includes('from subsidiaries')) {
      const wanted = state.subsidiaries.filter((row) => params.includes(row.id))
      return { rows: wanted.length > 0 ? wanted : state.subsidiaries }
    }
    if (text.includes('from asset_categories')) {
      const wanted = state.categories.filter((row) => params.includes(row.id))
      return { rows: wanted.length > 0 ? wanted : state.categories }
    }
    if (text.includes('from accounts')) {
      return { rows: state.accounts.filter((row) => params.includes(row.id)) }
    }
    if (text.includes('coalesce(max(')) {
      let top = 0
      for (const row of state.assets) {
        if (row.org_id !== '${ORG_ID}') continue
        const match = /^FA-(\\d+)$/.exec(row.asset_number)
        if (match) top = Math.max(top, Number(match[1]))
      }
      return { rows: [{ n: top + 1 }] }
    }
    if (text.includes('insert into fixed_assets')) {
      const id = String(params[0])
      const orgId = String(params[1])
      const assetNumber = String(params[4])
      if (state.assets.some((row) => row.id === id)) return { rows: [] }
      if (state.assets.some((row) => row.org_id === orgId && row.asset_number === assetNumber)) {
        throw new Error('duplicate key value violates unique constraint "fixed_assets_org_asset_number_unique"')
      }
      state.assets.push({ id, org_id: orgId, asset_number: assetNumber })
      return { rows: [{ id }] }
    }
    if (text.includes('insert into audit_log')) {
      // values (org, 'table', row_id, 'insert', changes, actor, request_id):
      // string literals stay inline, so changes is params[2].
      state.audits.push({
        row_id: String(params[1]),
        org_id: String(params[0]),
        request_id: String(params[4]),
        after: JSON.parse(String(params[2])).after,
      })
      return { rows: [{ id: 'audit-id' }] }
    }
    if (text.includes('from audit_log')) {
      const rows = state.audits.filter(
        (row) => text.includes(row.request_id) && row.org_id === '${ORG_ID}',
      )
      return { rows: rows.map((row) => ({ after: row.after })) }
    }
    if (text.includes('from fixed_assets')) {
      const rows = state.assets.filter(
        (row) => text.includes(row.id) && row.org_id === '${ORG_ID}',
      )
      return { rows }
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
    `const state = globalThis[Symbol.for('openbooks.asset-create-route-test')]
     export async function guardFeaturePermission() {
       return {
         user: { orgId: '${ORG_ID}', id: '${USER_ID}' },
         allowedSubsidiaryIds: state.allowedSubsidiaryIds
           ? new Set(state.allowedSubsidiaryIds)
           : null,
       }
     }`,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["../../../lib/feature-gates", "mock:feature-gates"],
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
    // `@/` is a Next alias, not a package: resolve it against web/ like the
    // reconcilable-currency boundary test does, so the REAL json boundary
    // runs instead of a permissive double.
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

const routeUrl = "./route.ts?asset-create-test";
const routeModule = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { POST } = routeModule;

const KEY_A = "00000000-0000-4000-8000-000000001001";
const KEY_B = "00000000-0000-4000-8000-000000001002";
const KEY_C = "00000000-0000-4000-8000-000000001003";
const KEY_D = "00000000-0000-4000-8000-000000001004";

function reset(): void {
  state.allowedSubsidiaryIds = null;
  state.subsidiaries = [{ id: SUBSIDIARY_ID }];
  state.categories = [{ id: CATEGORY_ID }];
  state.accounts = [];
  state.assets = [];
  state.audits = [];
  state.queries = [];
}

function post(
  key: string | null,
  body: Record<string, unknown>,
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (key !== null) headers["Idempotency-Key"] = key;
  return POST(
    new Request("http://openbooks.test/api/assets", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

function baseBody(): Record<string, unknown> {
  return {
    name: "CNC Mill",
    categoryId: CATEGORY_ID,
    subsidiaryId: SUBSIDIARY_ID,
    acquisitionCost: "12000.0000",
  };
}

test("Save inserts one tenant-scoped asset with one audit event", async () => {
  reset();
  const res = await post(KEY_A, baseBody());
  assert.equal(res.status, 201);
  const data = (await res.json()) as { id?: string };
  assert.equal(data.id, KEY_A);
  assert.equal(state.assets.length, 1);
  assert.equal(state.assets[0]!.org_id, ORG_ID);
  assert.equal(state.assets[0]!.asset_number, "FA-0001");
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0]!.row_id, KEY_A);
  assert.equal(state.audits[0]!.request_id, KEY_A);
  const insertText =
    state.queries.find((q) => q.includes("insert into fixed_assets")) ?? "";
  assert.match(insertText, new RegExp(ORG_ID));
});

test("replaying the same snapshot is a success with no second insert or audit", async () => {
  reset();
  assert.equal((await post(KEY_A, baseBody())).status, 201);
  const replay = await post(KEY_A, baseBody());
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { id: string }).id, KEY_A);
  assert.equal(state.assets.length, 1);
  assert.equal(state.audits.length, 1);
});

test("reusing a key for a changed request is a named conflict", async () => {
  reset();
  assert.equal((await post(KEY_A, baseBody())).status, 201);
  const conflict = await post(KEY_A, { ...baseBody(), name: "Different Mill" });
  assert.equal(conflict.status, 409);
  assert.equal(
    ((await conflict.json()) as { error: string }).error,
    "invalid_idempotency_key",
  );
  assert.equal(state.assets.length, 1);
  assert.equal(state.audits.length, 1);
});

test("a key already owned by another organization never leaks that row", async () => {
  reset();
  state.assets.push({
    id: KEY_A,
    org_id: OTHER_ORG_ID,
    asset_number: "FA-0001",
  });
  const res = await post(KEY_A, baseBody());
  assert.equal(res.status, 409);
  assert.equal(
    ((await res.json()) as { error: string }).error,
    "invalid_idempotency_key",
  );
  assert.ok(!state.assets.some((row) => row.org_id === ORG_ID));
  assert.equal(state.audits.length, 0);
});

test("missing or malformed idempotency keys are refused before any write", async () => {
  reset();
  for (const key of [null, "not-a-uuid"]) {
    const res = await post(key, baseBody());
    assert.equal(res.status, 400);
    assert.equal(
      ((await res.json()) as { error: string }).error,
      "invalid_idempotency_key",
    );
  }
  assert.equal(state.assets.length, 0);
  assert.equal(state.audits.length, 0);
});

test("unconfigured inputs are refused by name, never stored as zero", async () => {
  reset();
  const withoutCategory = baseBody();
  delete withoutCategory.categoryId;
  const bodies: Record<string, unknown>[] = [
    { ...baseBody(), name: "   " },
    withoutCategory,
    { ...baseBody(), categoryId: "00000000-0000-4000-8000-00000000c099" },
    { ...baseBody(), subsidiaryId: "00000000-0000-4000-8000-00000000b099" },
    { ...baseBody(), acquisitionCost: "12,34" },
    { ...baseBody(), acquisitionCost: "-5" },
    { ...baseBody(), acquisitionCost: "1", salvageValue: "999999" },
    { ...baseBody(), acquiredOn: "2026-02-30" },
    { ...baseBody(), status: "active" },
  ];
  const codes = [
    "name_required",
    "category_required",
    "invalid_category",
    "invalid_subsidiary",
    "acquisition_cost_invalid",
    "acquisition_cost_negative",
    "salvage_exceeds_cost",
    "acquired_on_invalid",
    "unsupported_status_transition",
  ];
  for (let index = 0; index < bodies.length; index += 1) {
    const key = `00000000-0000-4000-8000-000000003${String(index + 1).padStart(3, "0")}`;
    const res = await post(key, bodies[index]!);
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error: string }).error, codes[index]);
  }
  assert.equal(state.assets.length, 0);
  assert.equal(state.audits.length, 0);
});

test("financial JSON numbers are refused with a decimal-string remedy before asset creation", async () => {
  reset();
  const response = await post(KEY_A, { ...baseBody(), acquisitionCost: 100.25 });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string; issues?: { path: string; message: string }[] };
  assert.match(body.error, /decimal string, not a JSON number/);
  assert.equal(body.issues?.[0]?.path, "acquisitionCost");
  assert.equal(state.assets.length, 0);
  assert.equal(state.audits.length, 0);
});

test("a supplied number conflict names the remedy and consumes no audit row", async () => {
  reset();
  const first = await post(KEY_A, { ...baseBody(), assetNumber: "FA-0042" });
  assert.equal(first.status, 201);
  assert.equal(state.assets[0]!.asset_number, "FA-0042");
  const second = await post(KEY_B, { ...baseBody(), assetNumber: "FA-0042" });
  assert.equal(second.status, 422);
  assert.equal(
    ((await second.json()) as { error: string }).error,
    "asset_number_in_use",
  );
  assert.equal(state.audits.length, 1);
});

test("consecutive saves number consecutively: cancel/open consume no sequence", async () => {
  reset();
  assert.equal((await post(KEY_A, baseBody())).status, 201);
  assert.equal(state.assets[0]!.asset_number, "FA-0001");
  const second = await post(KEY_C, baseBody());
  assert.equal(second.status, 201);
  assert.equal(state.assets[1]!.asset_number, "FA-0002");
  void KEY_D;
});

test("no subsidiary anywhere is a named refusal, not a silent default", async () => {
  reset();
  state.subsidiaries = [];
  const body = baseBody();
  delete body.subsidiaryId;
  const res = await post(KEY_A, body);
  assert.equal(res.status, 409);
  assert.equal(
    ((await res.json()) as { error: string }).error,
    "no_available_subsidiary",
  );
  assert.equal(state.assets.length, 0);
});

test("the full drawer body is validated with named refusals, never dropped", async () => {
  reset();
  const bodies: Record<string, unknown>[] = [
    { ...baseBody(), method: "sideways" },
    { ...baseBody(), lifeMonths: "0" },
    { ...baseBody(), ratePercent: "abc" },
    { ...baseBody(), unitsTotal: "-3" },
    { ...baseBody(), convention: "never" },
    { ...baseBody(), openingAccumulated: "100" },
    {
      ...baseBody(),
      acquisitionCost: "100",
      openingAccumulated: "5000",
      openingAsOf: "2026-01-01",
    },
    {
      ...baseBody(),
      assetAccountId: "00000000-0000-4000-8000-00000000d099",
    },
    { ...baseBody(), depreciationMethodId: "not-a-uuid" },
    {
      ...baseBody(),
      taxDepreciation: { us_macrs: { businessUsePercent: "150" } },
    },
    { ...baseBody(), inServiceOn: "2026-02-30" },
  ];
  const codes = [
    "invalid_method",
    "invalid_life",
    "invalid_rate",
    "invalid_units",
    "invalid_convention",
    "opening_pair_required",
    "opening_exceeds_basis",
    "invalid_asset_account",
    "invalid_formula",
    "tax_business_use_invalid",
    "in_service_on_invalid",
  ];
  for (let index = 0; index < bodies.length; index += 1) {
    const key = `00000000-0000-4000-8000-000000004${String(index + 1).padStart(3, "0")}`;
    const res = await post(key, bodies[index]!);
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error: string }).error, codes[index]);
  }
  assert.equal(state.assets.length, 0);
  assert.equal(state.audits.length, 0);
});

test("a full drawer body is stored whole: nothing the operator filled is dropped", async () => {
  reset();
  state.accounts.push({ id: ACCOUNT_ID });
  const res = await post(KEY_A, {
    ...baseBody(),
    method: "straight_line",
    lifeMonths: "60",
    convention: "full_month",
    inServiceOn: "2026-03-01",
    assetAccountId: ACCOUNT_ID,
    custom: {},
  });
  assert.equal(res.status, 201);
  const after = state.audits[0]!.after as Record<string, unknown>;
  assert.equal(after.depreciation_method, "straight_line");
  assert.equal(after.useful_life_months, 60);
  assert.equal(after.depreciation_convention, "full_month");
  assert.equal(after.in_service_on, "2026-03-01");
  assert.equal(after.asset_account_id, ACCOUNT_ID);
  assert.deepEqual(after.custom, {});
});

test("every refusal the route can emit is mapped by the create drawer", () => {
  const drawer = readFileSync(
    new URL("../../(app)/assets/AssetDrawer.tsx", import.meta.url),
    "utf8",
  );
  const catalog = JSON.parse(
    readFileSync(
      new URL("../../../messages/en/assets.json", import.meta.url),
      "utf8",
    ),
  ) as { create: { errors: Record<string, string> } };
  for (const code of [
    "name_required",
    "unsupported_status_transition",
    "category_required",
    "invalid_category",
    "invalid_subsidiary",
    "no_available_subsidiary",
    "acquisition_cost_invalid",
    "acquisition_cost_negative",
    "salvage_value_invalid",
    "salvage_value_negative",
    "salvage_exceeds_cost",
    "acquired_on_invalid",
    "in_service_on_invalid",
    "asset_number_in_use",
    "invalid_method",
    "invalid_convention",
    "invalid_life",
    "invalid_rate",
    "invalid_units",
    "opening_invalid",
    "opening_negative",
    "opening_as_of_invalid",
    "opening_pair_required",
    "opening_exceeds_basis",
    "opening_before_in_service",
    "invalid_asset_account",
    "invalid_accumulated_account",
    "invalid_expense_account",
    "invalid_formula",
    "unknown_formula",
    "invalid_custom_fields",
    "unknown_custom_reference",
    "tax_elections_invalid",
    "tax_business_use_invalid",
    "tax_bonus_invalid",
    "tax_section179_invalid",
    "tax_class_invalid",
    "invalid_idempotency_key",
    "save_failed",
  ]) {
    assert.match(
      drawer,
      new RegExp(`['"]${code}['"]`),
      `create drawer must map ${code}`,
    );
    assert.equal(
      typeof catalog.create.errors[code],
      "string",
      `en catalog must carry create.errors.${code}`,
    );
  }
});

test("New only navigates: the button performs no fetch and calls no draft factory", () => {
  const button = readFileSync(
    new URL("../../(app)/assets/NewAssetButton.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(button, /fetch\s*\(/);
  assert.doesNotMatch(button, /\/api\/assets\/draft/);
  assert.match(button, /assetNew/);
});
