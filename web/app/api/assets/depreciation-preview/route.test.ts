import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

// Read-only depreciation preview boundary (review/confirm drawer).
// The preview is the exact confirmable accounting impact — one balanced
// debit/credit pair per due line — plus the stale-input fingerprint.
// It must never write: no locks, no schedule extension, no claims.
//
// Only the database and the session gate are doubled. The engine preview,
// UUID checks, decimal math, canonical JSON, and fingerprint run REAL.

const stateKey = Symbol.for("openbooks.depreciation-preview-route-test");
const ORG_ID = "00000000-0000-4000-8000-00000000f011";
const USER_ID = "00000000-0000-4000-8000-00000000f012";
const BOOK_ID = "00000000-0000-4000-8000-00000000b001";
const PERIOD_ID = "00000000-0000-4000-8000-000000000901";
const ASSET_A = "00000000-0000-4000-8000-00000000a001";
const ASSET_B = "00000000-0000-4000-8000-00000000a002";
const EXPENSE_ID = "00000000-0000-4000-8000-00000000e001";
const ACCUM_ID = "00000000-0000-4000-8000-00000000e002";
const SUBSIDIARY_ID = "00000000-0000-4000-8000-00000000s001";

interface DueRow {
  line_id: string;
  asset_id: string;
  asset_number: string;
  asset_name: string;
  subsidiary_id: string;
  subsidiary_name: string;
  department_id: string | null;
  department_name: string | null;
  project_id: string | null;
  project_name: string | null;
  location_id: string | null;
  location_name: string | null;
  book_id: string;
  book_name: string;
  posts_gl: boolean;
  period_id: string;
  period_name: string;
  period_ends_on: string;
  period_starts_on: string;
  amount: string;
  asset_account: string | null;
  asset_accum: string | null;
  asset_expense: string | null;
  cat_asset: string;
  cat_accum: string;
  cat_expense: string;
}

interface RouteState {
  allowedSubsidiaryIds: string[] | null;
  books: { id: string }[];
  periods: { id: string }[];
  assets: { id: string }[];
  due: DueRow[];
  stale: { asset_id: string; asset_number: string; asset_name: string }[];
  queries: string[];
  writes: string[];
}

function dueRow(line: string, asset: string, number: string, amount: string, postsGl: boolean): DueRow {
  return {
    line_id: line,
    asset_id: asset,
    asset_number: number,
    asset_name: `Mill ${number}`,
    subsidiary_id: SUBSIDIARY_ID,
    subsidiary_name: "HQ",
    department_id: null,
    department_name: null,
    project_id: null,
    project_name: null,
    location_id: null,
    location_name: null,
    book_id: BOOK_ID,
    book_name: "GAAP",
    posts_gl: postsGl,
    period_id: PERIOD_ID,
    period_name: "2026-09",
    period_ends_on: "2026-09-30",
    period_starts_on: "2026-09-01",
    amount,
    asset_account: null,
    asset_accum: null,
    asset_expense: null,
    cat_asset: EXPENSE_ID,
    cat_accum: ACCUM_ID,
    cat_expense: EXPENSE_ID,
  };
}

const state: RouteState = {
  allowedSubsidiaryIds: null,
  books: [{ id: BOOK_ID }],
  periods: [{ id: PERIOD_ID }],
  assets: [{ id: ASSET_A }, { id: ASSET_B }],
  due: [
    dueRow(
      "00000000-0000-4000-8000-00000000l001",
      ASSET_A,
      "FA-0001",
      "100.0000",
      true,
    ),
    dueRow(
      "00000000-0000-4000-8000-00000000l002",
      ASSET_B,
      "FA-0002",
      "250.5000",
      false,
    ),
  ],
  stale: [],
  queries: [],
  writes: [],
};
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
).openbooksDepreciationPreviewInspect = inspect;

const mockDb = `
  const state = globalThis[Symbol.for('openbooks.depreciation-preview-route-test')]
  const inspect = globalThis.openbooksDepreciationPreviewInspect
  function respond(query) {
    const seen = inspect(query)
    const text = seen.text
    const params = seen.params
    if (/insert\\s|update\\s|delete\\s|for\\s+update/i.test(text)) {
      throw new Error('preview performed a write: ' + text.slice(0, 120))
    }
    // Route-ownership reads only: engine preview/join queries mention the
    // same tables inside joins, so these branches require the absence of
    // any depreciation_ fragment. Reference lookups bind ids either singly
    // or inside any('{...}') arrays: match by containment, not equality.
    const mentions = (id) => params.some((param) => String(param).includes(id));
    if (text.includes('from accounting_books') && !text.includes('depreciation_')) {
      return { rows: state.books.filter((row) => mentions(row.id)) }
    }
    if (text.includes('from accounting_periods') && !text.includes('depreciation_')) {
      return { rows: state.periods.filter((row) => mentions(row.id)) }
    }
    if (text.includes('from fixed_assets') && !text.includes('depreciation_')) {
      return { rows: state.assets.filter((row) => mentions(row.id)) }
    }
    if (text.includes('from accounts')) {
      return { rows: [
        { id: '${EXPENSE_ID}', number: '6100', name: 'Depreciation expense' },
        { id: '${ACCUM_ID}', number: '1510', name: 'Accumulated depreciation' },
      ] }
    }
    if (text.includes('select distinct s.asset_id')) {
      return { rows: state.stale }
    }
    if (text.includes('from depreciation_schedule_lines')) {
      const scoped = state.due.filter((row) => {
        if (!text.includes('${ORG_ID}')) return false
        return true
      })
      return { rows: scoped }
    }
    return { rows: [] }
  }
  async function execute(query) {
    const seen = inspect(query)
    state.queries.push(seen.text)
    return respond(query)
  }
  export const db = {
    execute,
    transaction: async (work) => work({ execute }),
  }
  export async function withTransactionSavepoint(tx, work) {
    return work(tx)
  }
  export async function withBypassContext(work) {
    return work()
  }
`;

const mockSources = new Map<string, string>([
  ["mock:db", mockDb],
  [
    "mock:feature-gates",
    `const state = globalThis[Symbol.for('openbooks.depreciation-preview-route-test')]
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
  ["../../../../lib/feature-gates", "mock:feature-gates"],
]);

function mockedUrl(specifier: string): string | null {
  // Engine files import the database relatively (../platform/db.ts) while
  // web routes use the canonical package specifier; both resolve to the
  // same module, so match it by suffix or the mock silently misses and the
  // REAL database receives the query.
  if (specifier === "@openbooks/engine/src/platform/db.ts") return "mock:db";
  if (/(^|\/)platform\/db\.ts$/.test(specifier)) return "mock:db";
  return mockUrls.get(specifier) ?? null;
}

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    const mocked = mockedUrl(specifier);
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

const routeUrl = "./route.ts?depreciation-preview-test";
const routeModule = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { POST } = routeModule;

function reset(): void {
  state.allowedSubsidiaryIds = null;
  state.books = [{ id: BOOK_ID }];
  state.periods = [{ id: PERIOD_ID }];
  state.assets = [{ id: ASSET_A }, { id: ASSET_B }];
  state.stale = [];
  state.queries = [];
  state.writes = [];
}

function preview(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/assets/depreciation-preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

interface PreviewBody {
  rows: {
    lineId: string;
    assetNumber: string;
    amount: string;
    debitAccountId: string;
    debitAccountNumber: string;
    creditAccountId: string;
    creditAccountNumber: string;
    subsidiaryName: string;
    evidence: string;
  }[];
  totalAmount: string;
  totalDebits: string;
  totalCredits: string;
  balanced: boolean;
  staleAssets: unknown[];
  warnings: string[];
  fingerprint: string;
}

test("preview returns the exact balanced impact with a fingerprint", async () => {
  reset();
  const res = await preview({ bookId: BOOK_ID, throughDate: "2026-09-30" });
  assert.equal(res.status, 200);
  const data = (await res.json()) as PreviewBody;
  assert.equal(data.rows.length, 2);
  const first = data.rows[0]!;
  assert.equal(first.assetNumber, "FA-0001");
  assert.equal(first.amount, "100.0000");
  assert.equal(first.debitAccountId, EXPENSE_ID);
  assert.equal(first.debitAccountNumber, "6100");
  assert.equal(first.creditAccountId, ACCUM_ID);
  assert.equal(first.creditAccountNumber, "1510");
  assert.equal(first.subsidiaryName, "HQ");
  assert.equal(first.evidence, "gl-posting");
  assert.equal(data.rows[1]!.evidence, "reporting-only");
  assert.equal(data.totalAmount, "350.5000");
  assert.equal(data.totalDebits, "350.5000");
  assert.equal(data.totalCredits, "350.5000");
  assert.equal(data.balanced, true);
  assert.match(data.fingerprint, /^[0-9a-f]{64}$/);
});

test("preview performs zero writes", async () => {
  reset();
  const res = await preview({ throughDate: "2026-09-30" });
  assert.equal(res.status, 200);
  // The mock throws on any insert/update/delete/lock; reaching here proves
  // the boundary is read-only.
  assert.ok(state.queries.length > 0);
});

test("the fingerprint covers the candidate set: a changed amount re-fingerprints", async () => {
  reset();
  const before = ((await (await preview({ throughDate: "2026-09-30" })).json()) as PreviewBody)
    .fingerprint;
  state.due[0]!.amount = "101.0000";
  const after = ((await (await preview({ throughDate: "2026-09-30" })).json()) as PreviewBody)
    .fingerprint;
  assert.notEqual(before, after);
  state.due[0]!.amount = "100.0000";
});

test("unknown book, period, and asset ids are refused by name", async () => {
  reset();
  const cases: [Record<string, unknown>, string][] = [
    [{ bookId: "00000000-0000-4000-8000-00000000b099", throughDate: "2026-09-30" }, "book_not_found"],
    [{ periodId: "00000000-0000-4000-8000-000000000999", throughDate: "2026-09-30" }, "period_not_found"],
    [{ assetIds: ["00000000-0000-4000-8000-00000000a099"], throughDate: "2026-09-30" }, "unknown_asset"],
    [{ throughDate: "2026-02-30" }, "invalid_through_date"],
  ];
  for (const [body, code] of cases) {
    const res = await preview(body);
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error: string }).error, code);
  }
});

test("stale schedules are reported with the rebuild remedy, never extended", async () => {
  reset();
  state.stale = [{ asset_id: ASSET_A, asset_number: "FA-0001", asset_name: "Mill FA-0001" }];
  const data = (await (await preview({ throughDate: "2026-09-30" })).json()) as PreviewBody;
  assert.equal(data.staleAssets.length, 1);
  // The warning names the stale asset and the remedy — rebuild, then
  // preview again — never a silent extension at Confirm.
  assert.ok(
    data.warnings.some(
      (warning) =>
        warning.includes("FA-0001") &&
        warning.includes("rebuild") &&
        warning.includes("preview again"),
    ),
  );
  // Still only the existing rows: nothing was projected or posted.
  assert.equal(data.rows.length, 2);
});

test("the posting date is fingerprinted and validated", async () => {
  reset();
  const plain = ((await (await preview({ throughDate: "2026-09-30" })).json()) as PreviewBody)
    .fingerprint;
  const dated = (
    (await (
      await preview({ throughDate: "2026-09-30", postingDate: "2026-09-15" })
    ).json()) as PreviewBody
  ).fingerprint;
  assert.notEqual(plain, dated);
  const bad = await preview({ throughDate: "2026-09-30", postingDate: "2026-13-40" });
  assert.equal(bad.status, 422);
  assert.equal(
    ((await bad.json()) as { error: string }).error,
    "invalid_posting_date",
  );
});

test("a posting date outside a line's period warns instead of failing", async () => {
  reset();
  const data = (
    (await (
      await preview({ throughDate: "2026-09-30", postingDate: "2026-08-15" })
    ).json()) as PreviewBody
  );
  // September lines with an August posting date: every row warns, and the
  // set still fingerprints — Confirm skips those lines by name.
  assert.equal(data.rows.length, 2);
  assert.ok(
    data.warnings.some(
      (warning) =>
        warning.includes("posting date 2026-08-15") &&
        warning.includes("Confirm will skip"),
    ),
  );
});

test("every refusal the depreciation boundary can emit is mapped by the review drawer", () => {
  const drawer = readFileSync(
    new URL("../../../(app)/assets/RunDepreciationDrawer.tsx", import.meta.url),
    "utf8",
  );
  for (const code of [
    "invalid_through_date",
    "invalid_posting_date",
    "book_not_found",
    "period_not_found",
    "unknown_asset",
    "nothing_selected",
    "fingerprint_required",
    "stale_preview",
    "schedules_stale",
    "period_closed",
    "nothing_due",
  ]) {
    assert.match(
      drawer,
      new RegExp(`['"]${code}['"]`),
      `review drawer must map ${code}`,
    );
  }
  // Transport failures toast instead of dying silent on both flows.
  assert.match(drawer, /toast\.error\(t\('review\.previewFailed'\)\)/);
  assert.match(drawer, /toast\.error\(t\('review\.confirmFailed'\)\)/);
});
