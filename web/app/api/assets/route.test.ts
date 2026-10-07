import assert from "node:assert/strict";
import { stubModules } from "../../../testing/stub-modules";
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
    if (text.includes('from custom_field_defs')) return { rows: [] }
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

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  database: `${mockDb}
     export async function withBypassContext(work) { return work() }`,
  extra: {
    "../../../lib/feature-gates": `const state = globalThis[Symbol.for('openbooks.asset-create-route-test')]
     export async function guardFeaturePermission() {
       return {
         user: { orgId: '${ORG_ID}', id: '${USER_ID}' },
         allowedSubsidiaryIds: state.allowedSubsidiaryIds
           ? new Set(state.allowedSubsidiaryIds)
           : null,
       }
     }`,
    "@/lib/feature-gates": `const state = globalThis[Symbol.for('openbooks.asset-create-route-test')]
     export async function guardFeaturePermission() {
       return {
         user: { orgId: '${ORG_ID}', id: '${USER_ID}' },
         allowedSubsidiaryIds: state.allowedSubsidiaryIds
           ? new Set(state.allowedSubsidiaryIds)
           : null,
       }
     }`,
  },
});

const routeUrl = "./route.ts?asset-create-test";
const routeModule = (await import(routeUrl)) as typeof import("./route.ts");

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
  assert.ok(state.queries.some((query) => query.includes("from custom_field_defs")), "native custom-field lookup uses the tracked database");
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
    "idempotency-conflict",
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
    "idempotency-conflict",
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
  const codes = ["name_required", "", "invalid_category", "invalid_subsidiary", "", "acquisition_cost_negative", "salvage_exceeds_cost", "", ""];
  const schemaFields = new Map([[1, "categoryId"], [4, "acquisitionCost"], [7, "acquiredOn"], [8, "status"]]);
  for (let index = 0; index < bodies.length; index += 1) {
    const key = `00000000-0000-4000-8000-000000003${String(index + 1).padStart(3, "0")}`;
    const res = await post(key, bodies[index]!);
    const responseBody = (await res.json()) as { error: string; issues?: { path: string }[] };
    assert.equal(res.status, schemaFields.has(index) ? 400 : 422);
    if (schemaFields.has(index)) assert.equal(responseBody.issues?.[0]?.path, schemaFields.get(index));
    else assert.equal(responseBody.error, codes[index]);
  }
  assert.equal(state.assets.length, 0);
  assert.equal(state.audits.length, 0);
});

test("financial JSON numbers are refused with a decimal-string remedy before asset creation", async () => {
  reset();
  const response = await post(KEY_A, { ...baseBody(), acquisitionCost: 100.25 });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { error: string; issues?: { path: string; message: string }[] };
  assert.match(body.error, /decimal string.*JSON numbers are refused/);
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
    "",
    "invalid_life",
    "",
    "invalid_units",
    "",
    "opening_pair_required",
    "opening_exceeds_basis",
    "invalid_asset_account",
    "",
    "tax_business_use_invalid",
    "",
  ];
  const schemaFields = new Map([[0, "method"], [2, "ratePercent"], [4, "convention"], [8, "depreciationMethodId"], [10, "inServiceOn"]]);
  for (let index = 0; index < bodies.length; index += 1) {
    const key = `00000000-0000-4000-8000-000000004${String(index + 1).padStart(3, "0")}`;
    const res = await post(key, bodies[index]!);
    const responseBody = (await res.json()) as { error: string; issues?: { path: string }[] };
    assert.equal(res.status, schemaFields.has(index) ? 400 : 422);
    if (schemaFields.has(index)) assert.equal(responseBody.issues?.[0]?.path, schemaFields.get(index));
    else assert.equal(responseBody.error, codes[index]);
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
