import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// File URL of the REAL business-date module: the clock mock re-exports its
// pure calendar check instead of reimplementing it.
const BUSINESS_DATE_URL = pathToFileURL(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "..",
    "..",
    "engine",
    "src",
    "platform",
    "business-date.ts",
  ),
).href;

// Unsaved-create contract for POST /api/estimates, /api/sales-orders and
// /api/purchase-orders (shared web/app/api/_order/create.ts): opening the
// drawer writes nothing, Cancel writes nothing, and the drawer's explicit
// Save lands here exactly once — one idempotent, audited draft insert whose
// document number allocates INSIDE the save transaction. A replay of the
// same request is a success (200), while reusing the key for a changed
// order (or a key minted in another org) is a 409 and must never return the
// older order as though it matched.
//
// Only the database and the session gate are doubled. Permissions,
// subsidiary/stock/line validation, UUID/decimal/calendar checks,
// canonical-JSON snapshot comparison, number allocation and the JSON
// boundary all run REAL so the refusal tests cannot pass against a
// permissive copy.

const stateKey = Symbol.for("openbooks.order-create-route-test");
const ORG_ID = "00000000-0000-4000-8000-00000000b011";
const USER_ID = "00000000-0000-4000-8000-00000000b012";
const SUBSIDIARY_ID = "00000000-0000-4000-8000-00000000b021";
const ACCOUNT_ID = "00000000-0000-4000-8000-00000000b031";
const FOREIGN_ACCOUNT_ID = "00000000-0000-4000-8000-00000000b039";
const INVENTORY_ITEM_ID = "00000000-0000-4000-8000-00000000b038";

interface DocRow {
  id: string;
  org_id: string;
  kind: string;
  document_number: string;
  status: string;
  currency: string;
  document_date: string;
  subtotal: string;
  tax_total: string;
  total: string;
}

interface LineRow {
  document_id: string;
  line_number: number;
  account_id: string | null;
  quantity: string;
  unit_price: string;
  amount: string;
}

interface RefRow {
  id: string;
  active: boolean;
}

interface RouteState {
  features: Record<string, boolean>;
  subsidiaries: { id: string; active: boolean; elimination: boolean }[];
  parties: RefRow[];
  departments: RefRow[];
  projects: RefRow[];
  items: { id: string; kind: string }[];
  accounts: RefRow[];
  orgMissing: boolean;
  today: string;
  docs: DocRow[];
  lines: LineRow[];
  audits: { row_id: string; org_id: string; request_id: string; after: unknown }[];
  nextNumber: number;
  allocations: number;
  queries: string[];
  lastParams: unknown[][];
}

const state: RouteState = {
  features: {},
  subsidiaries: [],
  parties: [],
  departments: [],
  projects: [],
  items: [{ id: INVENTORY_ITEM_ID, kind: "inventory" }],
  accounts: [{ id: ACCOUNT_ID, active: true }],
  orgMissing: false,
  today: "2026-06-01",
  docs: [],
  lines: [],
  audits: [],
  nextNumber: 1,
  allocations: 0,
  queries: [],
  lastParams: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

// Flatten a drizzle query to text AND collect bound scalar params in order.
// Text drives query-kind matching; params drive storage simulation. The
// insert/audit column orders are fixed by the route under test and read
// positionally here.
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
      // drizzle Name nodes (sql.identifier(...)) carry neither queryChunks
      // nor a bound value: render them quoted so table matching sees them.
      if (typeof rec.name === "string") return `"${rec.name}"`;
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
).openbooksOrderCreateInspect = inspect;

const CROSS_KEY = "00000000-0000-4000-8000-00000000b090";

const mockDb = `
  const state = globalThis[Symbol.for('openbooks.order-create-route-test')]
  const inspect = globalThis.openbooksOrderCreateInspect
  function str(v) { return v === null || v === undefined ? null : String(v) }
  function respond(query) {
    const seen = inspect(query)
    const text = seen.text
    const params = seen.params.map(str)
    if (text.includes('from number_sequences') || text.includes('into number_sequences')) {
      state.allocations += 1
      const prefix = params.find((p) => typeof p === 'string' && /-$/.test(p)) ?? 'X-'
      return { rows: [{ prefix, next_number: state.nextNumber++, padding: 3 }] }
    }
    if (text.includes('count(*)') && text.includes('from subsidiaries')) {
      const n = state.subsidiaries.filter((s) => s.active && !s.elimination).length
      return { rows: [{ n }] }
    }
    if (text.includes('from subsidiaries')) {
      const rows = state.subsidiaries.filter((s) => s.active && !s.elimination && params.includes(s.id))
      return { rows: rows.map((s) => ({ '1': 1 })) }
    }
    if (text.includes("settings->'features'") && text.includes('from orgs')) {
      return { rows: [{ f: state.features }] }
    }
    if (text.includes('base_currency') && text.includes('from orgs')) {
      if (state.orgMissing) return { rows: [] }
      return { rows: [{ base_currency: 'CAD' }] }
    }
    // Explicit same-org active-reference checks. drizzle inlines
    // sql.identifier(...) unquoted, and the id set arrives as one '{a,b}'
    // any-param, so match the table plus the any-membership (which the
    // kind-probing 'select kind from items' lacks) and filter by substring.
    for (const table of ['parties', 'departments', 'projects', 'items', 'accounts']) {
      if (text.includes('from ' + table) && text.includes('id = any')) {
        const pool = table === 'items'
          ? state.items.map((i) => ({ id: i.id, active: true }))
          : table === 'parties' ? state.parties
          : table === 'departments' ? state.departments
          : table === 'projects' ? state.projects
          : state.accounts;
        const wanted = pool.filter((row) => {
          if (!row.active) return false
          return params.some((p) => typeof p === 'string' && p.includes(row.id));
        })
        return { rows: wanted.map((row) => ({ id: row.id })) }
      }
    }
    if (text.includes("settings->>'timeZone'") && text.includes('from orgs')) {
      return { rows: [{ time_zone: null }] }
    }
    if (text.includes('select kind from items')) {
      return { rows: state.items.filter((i) => params.includes(i.id)).map((i) => ({ kind: i.kind })) }
    }
    if (text.includes('select id from documents')) {
      const rows = state.docs.filter((d) => params.includes(d.id) && params.includes(d.org_id))
      return { rows: rows.map((d) => ({ id: d.id })) }
    }
    if (text.includes('insert into documents')) {
      // (id, org, kind, number, party, docDate, due, currency, 'draft',
      //  subsidiary, dept, project, extraDims, memo, subtotal, tax, total,
      //  actor, actor) — 'draft' stays inline, the rest arrive positionally.
      const [id, orgId, kind, number, party, docDate, due, currency] = params
      if (id === '${CROSS_KEY}') return { rows: [] }
      if (state.docs.some((d) => d.id === id)) return { rows: [] }
      if (params.includes('${FOREIGN_ACCOUNT_ID}')) {
        throw { code: '23503', message: 'foreign key violation' }
      }
      state.docs.push({
        id, org_id: orgId, kind, document_number: number, status: 'draft',
        currency, document_date: docDate, subtotal: params[13], tax_total: params[14], total: params[15],
      })
      return { rows: [{ id }] }
    }
    if (text.includes('insert into document_lines')) {
      if (params.includes('${FOREIGN_ACCOUNT_ID}')) {
        throw { code: '23503', message: 'foreign key violation' }
      }
      state.lines.push({
        document_id: params[1], line_number: params[2], account_id: params[4],
        quantity: params[6], unit_price: params[8], amount: params[9],
      })
      return { rows: [{ id: 'line-' + state.lines.length }] }
    }
    if (text.includes('insert into audit_log')) {
      state.audits.push({
        row_id: String(params[1]),
        org_id: String(params[0]),
        request_id: String(params[4]),
        after: JSON.parse(String(params[2])).after,
      })
      return { rows: [{ id: 'audit-id' }] }
    }
    if (text.includes('from audit_log')) {
      const rows = state.audits.filter((a) => a.org_id === '${ORG_ID}')
      return { rows: rows.map((a) => ({ after: a.after })) }
    }
    if (text.includes('from documents d')) {
      const rows = state.docs.filter((d) => params.includes(d.id) && params.includes(d.org_id))
      return {
        rows: rows.map((d) => ({
          id: d.id, kind: d.kind, status: d.status, currency: d.currency,
          subsidiary_id: null, project_id: null, department_id: null, memo: null,
          due_date: null, document_date: d.document_date, updated_at: '1',
          subtotal: d.subtotal, tax_total: d.tax_total, total: d.total,
          party_id: null, party_name: null, document_number: d.document_number,
          extra_dims: {},
        })),
      }
    }
    if (text.includes('from document_lines l')) {
      const rows = state.lines.filter((l) => params.includes(l.document_id))
      return {
        rows: rows.map((l) => ({
          id: 'line-' + l.line_number, line_number: l.line_number,
          item_id: null, account_id: l.account_id, description: null,
          quantity: l.quantity, unit: null, unit_price: l.unit_price,
          amount: l.amount, tax_code_id: null, tax_group_id: null,
          tax_input_amount: l.amount, tax_amount: '0.0000', quantity_billed: '0',
          department_id: null, project_id: null, stock_location_id: null,
          extra_dims: {}, item_name: null, account_number: null,
          account_name: null, tax_code: null,
        })),
      }
    }
    if (text.includes('document_links')) return { rows: [] }
    return { rows: [] }
  }
  async function execute(query) {
    const seen = inspect(query)
    state.queries.push(seen.text)
    state.lastParams.push(seen.params)
    return respond(query)
  }
  export const db = {
    execute,
    // Atomicity the route depends on: a mid-save refusal (FK 23503,
    // idempotency conflict) rolls the whole save back, so a failed POST
    // leaves no partial row, line, audit event, or burned sequence.
    transaction: async (work) => {
      const snapshot = {
        docs: state.docs.length,
        lines: state.lines.length,
        audits: state.audits.length,
        nextNumber: state.nextNumber,
        allocations: state.allocations,
      }
      try {
        return await work({ execute })
      } catch (error) {
        state.docs.length = snapshot.docs
        state.lines.length = snapshot.lines
        state.audits.length = snapshot.audits
        state.nextNumber = snapshot.nextNumber
        state.allocations = snapshot.allocations
        throw error
      }
    },
  }
  // Named context helpers other real modules import from the same db
  // module: link-time stubs that run the work directly. Nothing under
  // test changes tenants mid-request.
  export async function withOrgTransaction(orgId, work) { return work({ execute }) }
  export async function withOrg(orgId, fn) { return fn() }
  export async function withBypass(fn) { return fn() }
  export async function withBypassContext(fn) { return fn() }
  export async function withOrgContext(orgId, fn) { return fn() }
  export async function withTransactionSavepoint(runner, name, work) { return work(runner) }
  export function registerRequestOrgResolver(fn) { return undefined }
  export function currentRequestOrgResolver() { return null }
  export function ambientTenantOrgId() { return null }
  export const orgContext = { getStore: () => undefined, run: (store, fn) => fn() }
  export const pool = { query: async () => ({ rows: [] }) }
  export const env = {}
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
  [
    "mock:business-date",
    // The clock, doubled so the midnight-retry test can move "today":
    // businessToday reads mutable test state, while the pure calendar
    // check runs REAL (re-exported, never reimplemented) so refusal tests
    // cannot pass against a permissive copy.
    `import { isIsoCalendarDate as realIsIsoCalendarDate } from '${BUSINESS_DATE_URL}'
     const state = globalThis[Symbol.for('openbooks.order-create-route-test')]
     export const isIsoCalendarDate = realIsIsoCalendarDate
     export async function businessToday(orgId) { return state.today }`,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["@openbooks/engine/src/platform/business-date.ts", "mock:business-date"],
  ["../../../lib/feature-gates", "mock:feature-gates"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
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
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const createUrl = "./create.ts?order-create-test";
const createModule = (await import(createUrl)) as typeof import("./create.ts");
hooks.deregister();

const KINDS = [
  { kind: "quote", createPerm: "ar.create", numberPrefix: "EST-", path: "/api/estimates" },
  { kind: "sales_order", createPerm: "ar.create", numberPrefix: "SO-", path: "/api/sales-orders" },
  { kind: "purchase_order", createPerm: "ap.create", numberPrefix: "PO-", path: "/api/purchase-orders" },
] as const;

const KEY_A = "00000000-0000-4000-8000-000000001011";
const KEY_B = "00000000-0000-4000-8000-000000001012";
const KEY_C = "00000000-0000-4000-8000-000000001013";

function reset(): void {
  state.features = {};
  state.subsidiaries = [];
  state.parties = [];
  state.departments = [];
  state.projects = [];
  state.accounts = [{ id: ACCOUNT_ID, active: true }];
  state.orgMissing = false;
  state.today = "2026-06-01";
  state.docs = [];
  state.lines = [];
  state.audits = [];
  state.nextNumber = 1;
  state.allocations = 0;
  state.queries = [];
  state.lastParams = [];
}

function post(
  POST: (req: Request) => Promise<Response>,
  path: string,
  key: string | null,
  body: Record<string, unknown>,
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["Idempotency-Key"] = key;
  return POST(
    new Request(`http://openbooks.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
  );
}

function lineBody(): Record<string, unknown> {
  return {
    documentDate: "2026-01-15",
    lines: [{ accountId: ACCOUNT_ID, description: "Widget", quantity: "2", unitPrice: "10" }],
  };
}

function lineBodyNoDate(): Record<string, unknown> {
  return {
    lines: [{ accountId: ACCOUNT_ID, description: "Widget", quantity: "2", unitPrice: "10" }],
  };
}

for (const { kind, createPerm, numberPrefix, path } of KINDS) {
  const POST = createModule.makePOST({ kind, createPerm, numberPrefix });

  test(`${kind}: Save inserts one tenant-scoped draft with its number and one audit event`, async () => {
    reset();
    const res = await post(POST, path, KEY_A, lineBody());
    assert.equal(res.status, 201);
    const data = (await res.json()) as {
      doc: { id: string; kind: string; status: string; document_number: string; total: string };
      lines: unknown[];
    };
    assert.equal(data.doc.id, KEY_A);
    assert.equal(data.doc.kind, kind);
    assert.equal(data.doc.status, "draft");
    assert.match(data.doc.document_number, new RegExp(`^${numberPrefix}`));
    assert.equal(data.doc.total, "20.0000");
    assert.equal(data.lines.length, 1);
    assert.equal(state.docs.length, 1);
    assert.equal(state.docs[0]!.org_id, ORG_ID);
    assert.equal(state.audits.length, 1);
    assert.equal(state.audits[0]!.row_id, KEY_A);
    assert.equal(state.audits[0]!.request_id, KEY_A);
    assert.equal(state.allocations, 1);
  });

  test(`${kind}: exact replay is a 200 with no second row, number, or audit`, async () => {
    reset();
    assert.equal((await post(POST, path, KEY_A, lineBody())).status, 201);
    const numbers = state.allocations;
    const replay = await post(POST, path, KEY_A, lineBody());
    assert.equal(replay.status, 200);
    const data = (await replay.json()) as { doc: { id: string; document_number: string } };
    assert.equal(data.doc.id, KEY_A);
    assert.equal(state.docs.length, 1);
    assert.equal(state.audits.length, 1);
    // The fast replay path returns before the allocator: no sequence burned.
    assert.equal(state.allocations, numbers);
  });

  test(`${kind}: reusing a key for a changed order is a 409`, async () => {
    reset();
    assert.equal((await post(POST, path, KEY_A, lineBody())).status, 201);
    const conflict = await post(POST, path, KEY_A, {
      ...lineBody(),
      lines: [{ accountId: ACCOUNT_ID, description: "Changed", quantity: "5", unitPrice: "10" }],
    });
    assert.equal(conflict.status, 409);
    assert.equal(state.docs.length, 1);
    assert.equal(state.audits.length, 1);
  });

  test(`${kind}: missing or non-uuid idempotency key is refused before any write`, async () => {
    reset();
    assert.equal((await post(POST, path, null, lineBody())).status, 400);
    assert.equal((await post(POST, path, "not-a-uuid", lineBody())).status, 400);
    assert.equal(state.docs.length, 0);
    assert.equal(state.audits.length, 0);
    assert.equal(state.allocations, 0);
  });

  test(`${kind}: validation refuses violations with no write`, async () => {
    reset();
    // An impossible calendar date fails the typed date boundary by name.
    const badDate = await post(POST, path, KEY_A, { documentDate: "2026-02-30" });
    assert.equal(badDate.status, 400);
    const badDateBody = (await badDate.json()) as { issues?: { path: string }[] };
    assert.ok((badDateBody.issues ?? []).some((issue) => issue.path.includes("documentDate")));
    // Malformed shapes stop at the typed boundary as 400 with a field path.
    const badUuid = await post(POST, path, KEY_B, {
      lines: [{ accountId: "nope", quantity: "1", unitPrice: "1" }],
    });
    assert.equal(badUuid.status, 400);
    const badUuidBody = (await badUuid.json()) as { issues?: { path: string }[] };
    assert.ok((badUuidBody.issues ?? []).some((issue) => issue.path.includes("accountId")));
    // Creation always yields draft: minting any other status is refused.
    assert.equal((await post(POST, path, KEY_C, { status: "approved" })).status, 400);
    assert.equal(state.docs.length, 0);
    assert.equal(state.audits.length, 0);
    assert.equal(state.allocations, 0);
  });

  test(`${kind}: unknown references refuse by name before any write`, async () => {
    reset();
    const PARTY_ID = "00000000-0000-4000-8000-000000001031";
    const unknownParty = await post(POST, path, KEY_A, { partyId: PARTY_ID });
    assert.equal(unknownParty.status, 422);
    assert.match(((await unknownParty.json()) as { error: string }).error, /party/i);
    const unknownAccount = await post(POST, path, KEY_B, {
      documentDate: "2026-01-15",
      lines: [{ accountId: FOREIGN_ACCOUNT_ID, description: "X", quantity: "1", unitPrice: "1" }],
    });
    assert.equal(unknownAccount.status, 422);
    assert.match(((await unknownAccount.json()) as { error: string }).error, /account/i);
    const TAX_ID = "00000000-0000-4000-8000-000000001032";
    const unknownTax = await post(POST, path, KEY_C, {
      documentDate: "2026-01-15",
      lines: [{ accountId: ACCOUNT_ID, description: "X", quantity: "1", unitPrice: "1", taxCodeId: TAX_ID }],
    });
    assert.equal(unknownTax.status, 422);
    assert.match(((await unknownTax.json()) as { error: string }).error, /line 1/i);
    assert.equal(state.docs.length, 0);
    assert.equal(state.audits.length, 0);
    assert.equal(state.allocations, 0);
  });

  test(`${kind}: unknown custom segment refuses by name`, async () => {
    reset();
    const res = await post(POST, path, KEY_A, { extraDims: { nope: "x" } });
    assert.equal(res.status, 422);
    const refusal = (await res.json()) as { error?: unknown };
    assert.equal(typeof refusal.error, "string");
    const message: string = refusal.error as string;
    assert.match(message, /segment/i);
    assert.equal(state.docs.length, 0);
  });
}

test("cross-org idempotency-key reuse is a 409, never the other org's order", async () => {
  reset();
  // The key minted a document in ANOTHER org: the same-org prior lookup
  // misses, the insert hits the id conflict, and the save refuses instead
  // of disclosing or returning the foreign row.
  const POST = createModule.makePOST({ kind: "quote", createPerm: "ar.create", numberPrefix: "EST-" });
  const res = await post(POST, "/api/estimates", CROSS_KEY, lineBody());
  assert.equal(res.status, 409);
  assert.equal(state.docs.length, 0);
  assert.equal(state.audits.length, 0);
});

test("cross-tenant line references fail closed as 422, not a raw 500", async () => {
  reset();
  const POST = createModule.makePOST({ kind: "quote", createPerm: "ar.create", numberPrefix: "EST-" });
  const res = await post(POST, "/api/estimates", KEY_A, {
    documentDate: "2026-01-15",
    lines: [{ accountId: FOREIGN_ACCOUNT_ID, description: "Foreign", quantity: "1", unitPrice: "1" }],
  });
  assert.equal(res.status, 422);
  assert.equal(state.docs.length, 0);
});

test("subsidiary write is refused when the feature is off, stored when on", async () => {
  reset();
  const POST = createModule.makePOST({
    kind: "purchase_order",
    createPerm: "ap.create",
    numberPrefix: "PO-",
  });
  const off = await post(POST, "/api/purchase-orders", KEY_A, {
    documentDate: "2026-01-15",
    subsidiaryId: SUBSIDIARY_ID,
  });
  assert.equal(off.status, 422);
  assert.equal(state.docs.length, 0);

  state.features = { multiSubsidiary: true };
  state.subsidiaries = [{ id: SUBSIDIARY_ID, active: true, elimination: false }];
  const on = await post(POST, "/api/purchase-orders", KEY_B, {
    documentDate: "2026-01-15",
    subsidiaryId: SUBSIDIARY_ID,
  });
  assert.equal(on.status, 201);
});

test("inventory-kind lines refuse with 404 while inventory is off", async () => {
  reset();
  state.features = { inventory: false };
  const POST = createModule.makePOST({ kind: "sales_order", createPerm: "ar.create", numberPrefix: "SO-" });
  const res = await post(POST, "/api/sales-orders", KEY_A, {
    documentDate: "2026-01-15",
    lines: [{ itemId: INVENTORY_ITEM_ID, accountId: ACCOUNT_ID, description: "Stocked", quantity: "1", unitPrice: "3" }],
  });
  assert.equal(res.status, 404);
  assert.equal(state.docs.length, 0);
});

test("identical retry after midnight still replays: derived values never join the match", async () => {
  reset();
  const POST = createModule.makePOST({ kind: "quote", createPerm: "ar.create", numberPrefix: "EST-" });
  // No documentDate supplied: the first save defaults it from the clock.
  state.today = "2026-01-15";
  const first = await post(POST, "/api/estimates", KEY_A, lineBodyNoDate());
  assert.equal(first.status, 201);
  assert.equal(state.docs[0]!.document_date, "2026-01-15");
  // The clock moves past midnight; the byte-identical retry must replay —
  // the defaulted date, computed totals and resolved warehouses are derived,
  // so they are excluded from the request-controlled match.
  state.today = "2026-01-16";
  const retry = await post(POST, "/api/estimates", KEY_A, lineBodyNoDate());
  assert.equal(retry.status, 200);
  const data = (await retry.json()) as { doc: { id: string; document_date: string } };
  assert.equal(data.doc.id, KEY_A);
  assert.equal(data.doc.document_date, "2026-01-15");
  assert.equal(state.docs.length, 1);
  assert.equal(state.audits.length, 1);
  assert.equal(state.allocations, 1);
});

test("missing org base currency refuses by name instead of inventing one", async () => {
  reset();
  state.orgMissing = true;
  const POST = createModule.makePOST({ kind: "quote", createPerm: "ar.create", numberPrefix: "EST-" });
  const res = await post(POST, "/api/estimates", KEY_A, lineBody());
  assert.equal(res.status, 422);
  assert.match(((await res.json()) as { error: string }).error, /base currency/i);
  assert.equal(state.docs.length, 0);
  assert.equal(state.audits.length, 0);
  assert.equal(state.allocations, 0);
});

test("same-key save fences on the idempotency key before allocating", async () => {
  reset();
  const POST = createModule.makePOST({ kind: "quote", createPerm: "ar.create", numberPrefix: "EST-" });
  assert.equal((await post(POST, "/api/estimates", KEY_A, lineBody())).status, 201);
  // Lock order: key fence, then allocation, then insert. Concurrent
  // same-key first-Saves serialize on the fence, so the loser sees the
  // winner's row and replays (200) instead of racing to a 409.
  const lockIdx = state.queries.findIndex((q) => q.includes("pg_advisory_xact_lock"));
  const allocIdx = state.queries.findIndex((q) => q.includes("number_sequences"));
  const insertIdx = state.queries.findIndex((q) => q.includes("insert into documents"));
  assert.ok(lockIdx !== -1 && lockIdx < allocIdx && allocIdx < insertIdx);
  assert.ok((state.lastParams[lockIdx] ?? []).map(String).includes(KEY_A));
  assert.equal(state.allocations, 1);
});

test("sequential saves allocate distinct numbers, one per save", async () => {
  reset();
  const POST = createModule.makePOST({ kind: "quote", createPerm: "ar.create", numberPrefix: "EST-" });
  const first = (await (await post(POST, "/api/estimates", KEY_A, lineBody())).json()) as {
    doc: { document_number: string };
  };
  const second = (await (await post(POST, "/api/estimates", KEY_B, lineBody())).json()) as {
    doc: { document_number: string };
  };
  assert.notEqual(first.doc.document_number, second.doc.document_number);
  assert.equal(state.allocations, 2);
  assert.equal(state.docs.length, 2);
});
