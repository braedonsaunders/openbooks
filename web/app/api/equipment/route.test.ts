import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// Canonical unsaved-create contract for equipment units (exemplar: POST
// /api/accounts). Opening New allocates no record, number, or audit row —
// allocation happens only here, on Save, as one idempotent tenant-scoped
// validated insert with a single audit event. Activation still requires a
// name and a charge item through PATCH; creation only ever yields draft.
//
// Only the database, the session gate, and feature flags are doubled.
// Validation, UUID, decimal, canonical-JSON, and the JSON boundary run REAL.

const stateKey = Symbol.for("openbooks.equipment-create-route-test");
const ORG_ID = "00000000-0000-4000-8000-00000000e011";
const OTHER_ORG_ID = "00000000-0000-4000-8000-00000000e099";
const USER_ID = "00000000-0000-4000-8000-00000000e012";
const SUBSIDIARY_ID = "00000000-0000-4000-8000-00000000b001";
const CHARGE_ITEM_ID = "00000000-0000-4000-8000-00000000c001";

interface UnitRow {
  id: string;
  org_id: string;
  unit_number: string;
}

interface RouteState {
  allowedSubsidiaryIds: string[] | null;
  subsidiaries: { id: string }[];
  chargeItems: { id: string }[];
  fixedAssets: { id: string; subsidiary_id: string }[];
  rateBooks: { id: string }[];
  units: UnitRow[];
  audits: { row_id: string; org_id: string; request_id: string; after: unknown }[];
  queries: string[];
  fixedAssetsEnabled: boolean;
  projectsEnabled: boolean;
}

const state: RouteState = {
  allowedSubsidiaryIds: null,
  subsidiaries: [{ id: SUBSIDIARY_ID }],
  chargeItems: [{ id: CHARGE_ITEM_ID }],
  fixedAssets: [],
  rateBooks: [],
  units: [],
  audits: [],
  queries: [],
  fixedAssetsEnabled: true,
  projectsEnabled: true,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

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
).openbooksEquipmentCreateInspect = inspect;

const mockDb = `
  const state = globalThis[Symbol.for('openbooks.equipment-create-route-test')]
  const inspect = globalThis.openbooksEquipmentCreateInspect
  function respond(query) {
    const seen = inspect(query)
    const text = seen.text
    const params = seen.params
    if (text.includes('pg_advisory_xact_lock')) return { rows: [{}] }
    if (text.includes('from subsidiaries')) {
      const wanted = state.subsidiaries.filter((row) => params.includes(row.id))
      return { rows: wanted.length > 0 ? wanted : state.subsidiaries }
    }
    if (text.includes('from items')) {
      return { rows: state.chargeItems.filter((row) => params.includes(row.id)) }
    }
    if (text.includes('from fixed_assets')) {
      return { rows: state.fixedAssets.filter((row) => params.includes(row.id)) }
    }
    if (text.includes('from item_rate_books')) {
      return { rows: state.rateBooks.filter((row) => params.includes(row.id)) }
    }
    if (text.includes('coalesce(max(')) {
      let top = 0
      for (const row of state.units) {
        if (row.org_id !== '${ORG_ID}') continue
        const match = /^EQ-(\\d+)$/.exec(row.unit_number)
        if (match) top = Math.max(top, Number(match[1]))
      }
      return { rows: [{ n: top + 1 }] }
    }
    if (text.includes('insert into equipment_units')) {
      const id = String(params[0])
      const orgId = String(params[1])
      const unitNumber = String(params[3])
      if (state.units.some((row) => row.id === id)) return { rows: [] }
      if (state.units.some((row) => row.org_id === orgId && row.unit_number === unitNumber)) {
        throw new Error('duplicate key value violates unique constraint "equipment_units_org_number"')
      }
      state.units.push({ id, org_id: orgId, unit_number: unitNumber })
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
    if (text.includes('from equipment_units')) {
      const rows = state.units.filter(
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
    `const state = globalThis[Symbol.for('openbooks.equipment-create-route-test')]
     export async function guardFeaturePermission() {
       return {
         user: { orgId: '${ORG_ID}', id: '${USER_ID}' },
         allowedSubsidiaryIds: state.allowedSubsidiaryIds
           ? new Set(state.allowedSubsidiaryIds)
           : null,
       }
     }`,
  ],
  [
    "mock:features",
    `const state = globalThis[Symbol.for('openbooks.equipment-create-route-test')]
     export async function isFeatureEnabled(_orgId, key) {
       if (key === 'fixedAssets') return state.fixedAssetsEnabled
       if (key === 'projects') return state.projectsEnabled
       return true
     }`,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["../../../lib/feature-gates", "mock:feature-gates"],
  ["../../../lib/features", "mock:features"],
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

const routeUrl = "./route.ts?equipment-create-test";
const routeModule = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { POST } = routeModule;

const KEY_A = "00000000-0000-4000-8000-000000001011";
const KEY_B = "00000000-0000-4000-8000-000000001012";
const KEY_C = "00000000-0000-4000-8000-000000001013";

function reset(): void {
  state.allowedSubsidiaryIds = null;
  state.subsidiaries = [{ id: SUBSIDIARY_ID }];
  state.chargeItems = [{ id: CHARGE_ITEM_ID }];
  state.fixedAssets = [];
  state.rateBooks = [];
  state.units = [];
  state.audits = [];
  state.queries = [];
  state.fixedAssetsEnabled = true;
  state.projectsEnabled = true;
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
    new Request("http://openbooks.test/api/equipment", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

function baseBody(): Record<string, unknown> {
  return {
    name: "Excavator 3",
    subsidiaryId: SUBSIDIARY_ID,
    chargeItemId: CHARGE_ITEM_ID,
    purchasePrice: "85000",
  };
}

test("Save inserts one tenant-scoped unit with one audit event", async () => {
  reset();
  const res = await post(KEY_A, baseBody());
  assert.equal(res.status, 201);
  assert.equal(((await res.json()) as { id?: string }).id, KEY_A);
  assert.equal(state.units.length, 1);
  assert.equal(state.units[0]!.org_id, ORG_ID);
  assert.equal(state.units[0]!.unit_number, "EQ-0001");
  assert.equal(state.audits.length, 1);
  assert.equal(state.audits[0]!.request_id, KEY_A);
  const insertText =
    state.queries.find((q) => q.includes("insert into equipment_units")) ?? "";
  assert.match(insertText, new RegExp(ORG_ID));
});

test("replaying the same snapshot is a success with no second insert or audit", async () => {
  reset();
  assert.equal((await post(KEY_A, baseBody())).status, 201);
  const replay = await post(KEY_A, baseBody());
  assert.equal(replay.status, 200);
  assert.equal(((await replay.json()) as { id: string }).id, KEY_A);
  assert.equal(state.units.length, 1);
  assert.equal(state.audits.length, 1);
});

test("reusing a key for a changed request is a named conflict", async () => {
  reset();
  assert.equal((await post(KEY_A, baseBody())).status, 201);
  const conflict = await post(KEY_A, { ...baseBody(), name: "Dozer 1" });
  assert.equal(conflict.status, 409);
  assert.equal(
    ((await conflict.json()) as { error: string }).error,
    "invalid_idempotency_key",
  );
  assert.equal(state.units.length, 1);
});

test("a key already owned by another organization never leaks that row", async () => {
  reset();
  state.units.push({ id: KEY_A, org_id: OTHER_ORG_ID, unit_number: "EQ-0001" });
  const res = await post(KEY_A, baseBody());
  assert.equal(res.status, 409);
  assert.equal(
    ((await res.json()) as { error: string }).error,
    "invalid_idempotency_key",
  );
  assert.ok(!state.units.some((row) => row.org_id === ORG_ID));
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
  assert.equal(state.units.length, 0);
});

test("unconfigured inputs are refused by name, never stored as zero", async () => {
  reset();
  const bodies: Record<string, unknown>[] = [
    { ...baseBody(), name: "" },
    { ...baseBody(), subsidiaryId: "00000000-0000-4000-8000-00000000b099" },
    { ...baseBody(), chargeItemId: "00000000-0000-4000-8000-00000000c099" },
    { ...baseBody(), purchasePrice: "1.234,56" },
    { ...baseBody(), purchasePrice: "-1" },
    { ...baseBody(), acquiredOn: "2026-13-01" },
    {
      ...baseBody(),
      acquiredOn: "2026-05-01",
      inServiceOn: "2026-04-01",
    },
    { ...baseBody(), capacityQuantity: "0" },
    { ...baseBody(), status: "active" },
  ];
  const codes = [
    "name_required",
    "invalid_subsidiary",
    "charge_item_not_found",
    "purchase_price_invalid",
    "purchase_price_negative",
    "acquired_on_invalid",
    "in_service_before_acquisition",
    "capacity_not_positive",
    "unsupported_status_transition",
  ];
  for (let index = 0; index < bodies.length; index += 1) {
    const key = `00000000-0000-4000-8000-000000003${String(index + 11).padStart(3, "0")}`;
    const res = await post(key, bodies[index]!);
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error: string }).error, codes[index]);
  }
  assert.equal(state.units.length, 0);
  assert.equal(state.audits.length, 0);
});

test("a supplied number conflict names the remedy and consumes no audit row", async () => {
  reset();
  const first = await post(KEY_A, { ...baseBody(), unitNumber: "EQ-0007" });
  assert.equal(first.status, 201);
  const second = await post(KEY_B, { ...baseBody(), unitNumber: "EQ-0007" });
  assert.equal(second.status, 422);
  assert.equal(
    ((await second.json()) as { error: string }).error,
    "unit_number_in_use",
  );
  assert.equal(state.audits.length, 1);
});

test("consecutive saves number consecutively: cancel/open consume no sequence", async () => {
  reset();
  assert.equal((await post(KEY_A, baseBody())).status, 201);
  assert.equal(state.units[0]!.unit_number, "EQ-0001");
  assert.equal((await post(KEY_C, baseBody())).status, 201);
  assert.equal(state.units[1]!.unit_number, "EQ-0002");
});

test("creation without a charge item stays draft; activation still demands it", async () => {
  reset();
  const body = baseBody();
  delete body.chargeItemId;
  const res = await post(KEY_A, body);
  assert.equal(res.status, 201);
  assert.equal(state.units.length, 1);
});

test("linked records are validated against this organization", async () => {
  reset();
  const assetId = "00000000-0000-4000-8000-00000000d001";
  const otherSubsidiary = "00000000-0000-4000-8000-00000000b002";
  const bookId = "00000000-0000-4000-8000-00000000d002";
  const unknownAsset = await post(KEY_A, { ...baseBody(), fixedAssetId: assetId });
  assert.equal(unknownAsset.status, 422);
  assert.equal(
    ((await unknownAsset.json()) as { error: string }).error,
    "fixed_asset_not_found",
  );
  state.fixedAssets.push({ id: assetId, subsidiary_id: otherSubsidiary });
  const mismatched = await post(KEY_B, { ...baseBody(), fixedAssetId: assetId });
  assert.equal(mismatched.status, 422);
  assert.equal(
    ((await mismatched.json()) as { error: string }).error,
    "subsidiary_mismatch",
  );
  const unknownBook = await post(KEY_C, { ...baseBody(), rateBookId: bookId });
  assert.equal(unknownBook.status, 422);
  assert.equal(
    ((await unknownBook.json()) as { error: string }).error,
    "rate_book_not_found",
  );
  assert.equal(state.units.length, 0);
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
  assert.equal(state.units.length, 0);
});

test("every refusal the route can emit is mapped by the create drawer", () => {
  const drawer = readFileSync(
    new URL("../../(app)/assets/equipment/EquipmentDrawer.tsx", import.meta.url),
    "utf8",
  );
  const catalog = JSON.parse(
    readFileSync(
      new URL("../../../messages/en/assets.json", import.meta.url),
      "utf8",
    ),
  ) as { equipment: { create: { errors: Record<string, string> } } };
  for (const code of [
    "name_required",
    "unsupported_status_transition",
    "invalid_subsidiary",
    "no_available_subsidiary",
    "unit_number_in_use",
    "charge_item_not_found",
    "fixed_asset_not_found",
    "subsidiary_mismatch",
    "rate_book_not_found",
    "purchase_price_invalid",
    "purchase_price_negative",
    "acquired_on_invalid",
    "in_service_on_invalid",
    "in_service_before_acquisition",
    "capacity_invalid",
    "capacity_not_positive",
    "invalid_idempotency_key",
    "save_failed",
  ]) {
    assert.match(
      drawer,
      new RegExp(`['"]${code}['"]`),
      `create drawer must map ${code}`,
    );
    assert.equal(
      typeof catalog.equipment.create.errors[code],
      "string",
      `en catalog must carry equipment.create.errors.${code}`,
    );
  }
});

test("New only navigates: the button performs no fetch and calls no draft factory", () => {
  const button = readFileSync(
    new URL("../../(app)/assets/equipment/NewEquipmentButton.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(button, /fetch\s*\(/);
  assert.doesNotMatch(button, /\/api\/equipment\/draft/);
  assert.match(button, /equipmentNew/);
});
