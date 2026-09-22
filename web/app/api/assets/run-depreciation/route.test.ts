import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
// NOTE: the engine is imported dynamically AFTER registerHooks below. A
// static import here would cache the real-database graph before the mocks
// install, and every engine query would hit production-shaped storage.

// Confirm path of POST /api/assets/run-depreciation (review/confirm drawer).
// Confirm revalidates the previewed selection — book, period, tenant-owned
// asset ids — recomputes the fingerprint over current state, and refuses
// stale or empty selections by name before posting exactly the previewed
// lines. A repeat or concurrent confirm can only skip already-claimed lines.
//
// Only the database and the session gate are doubled. The engine run,
// fingerprint, UUID checks, and JSON boundary run REAL.

const stateKey = Symbol.for("openbooks.depreciation-confirm-route-test");
const ORG_ID = "00000000-0000-4000-8000-00000000f021";
const USER_ID = "00000000-0000-4000-8000-00000000f022";
const BOOK_ID = "00000000-0000-4000-8000-00000000b011";
const PERIOD_ID = "00000000-0000-4000-8000-000000000911";
const PERIOD_C = "00000000-0000-4000-8000-000000000913";
const ASSET_A = "00000000-0000-4000-8000-00000000a011";
const ASSET_B = "00000000-0000-4000-8000-00000000a012";
const EXPENSE_ID = "00000000-0000-4000-8000-00000000e011";
const ACCUM_ID = "00000000-0000-4000-8000-00000000e012";
const SUBSIDIARY_ID = "00000000-0000-4000-8000-00000000s011";
const CATEGORY_ID = "00000000-0000-4000-8000-00000000c011";
const LINE_A = "00000000-0000-4000-8000-000000001011";
const LINE_B = "00000000-0000-4000-8000-000000001012";

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
  period_starts_on?: string;
  period_ends_text?: string;
  amount: string;
  asset_account: string | null;
  asset_accum: string | null;
  asset_expense: string | null;
  cat_asset: string;
  cat_accum: string;
  cat_expense: string;
}

interface SubsidiaryRow {
  id: string;
  parentId: string | null;
  name: string;
  baseCurrency: string;
  isElimination: boolean;
  isActive: boolean;
}

interface RouteState {
  allowedSubsidiaryIds: string[] | null;
  books: { id: string }[];
  periods: { id: string }[];
  assets: { id: string; category_id: string }[];
  due: DueRow[];
  queries: string[];
  /** Lines whose claim reload observes a live due row; others vanish. */
  claimLive: string[];
  subsidiaries: SubsidiaryRow[];
  /** Period ids the close check reports as closed. */
  closedPeriods: string[];
  stale?: { asset_id: string; asset_number: string; asset_name: string }[];
}

function dueRow(line: string, asset: string, number: string, amount: string): DueRow {
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
    posts_gl: true,
    period_id: PERIOD_ID,
    period_name: "2026-09",
    period_ends_on: "2026-09-30",
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
  assets: [
    { id: ASSET_A, category_id: CATEGORY_ID },
    { id: ASSET_B, category_id: CATEGORY_ID },
  ],
  due: [
    dueRow(LINE_A, ASSET_A, "FA-0001", "100.0000"),
    dueRow(LINE_B, ASSET_B, "FA-0002", "250.5000"),
  ],
  queries: [],
  claimLive: [],
  subsidiaries: [
    {
      id: SUBSIDIARY_ID,
      parentId: null,
      name: "HQ",
      baseCurrency: "USD",
      isElimination: false,
      isActive: true,
    },
  ],
  closedPeriods: [],
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
).openbooksDepreciationConfirmInspect = inspect;

const mockDb = `
  const state = globalThis[Symbol.for('openbooks.depreciation-confirm-route-test')]
  const inspect = globalThis.openbooksDepreciationConfirmInspect
  function respond(query) {
    const seen = inspect(query)
    const text = seen.text
    const params = seen.params
    // Reference lookups bind ids either singly or inside any('{...}')
    // arrays, so match by containment rather than parameter equality.
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
    // Unrestricted chart: the restriction probe finds no subsidiary-scoped
    // accounts, while locks and metadata resolve both chart rows.
    if (text.includes('from accounts') && text.includes('subsidiary_id is not null')) {
      return { rows: [] }
    }
    if (text.includes('from accounts') && !text.includes('depreciation_')) {
      return { rows: [
        { id: '${EXPENSE_ID}', number: '6100', name: 'Depreciation expense' },
        { id: '${ACCUM_ID}', number: '1510', name: 'Accumulated depreciation' },
      ] }
    }
    if (text.includes('select distinct s.asset_id')) {
      return { rows: state.stale === undefined ? [] : state.stale }
    }
    if (text.includes('from asset_categories')) {
      // Row-lock prelude inside each line transaction: the category exists.
      return { rows: [{}] }
    }
    // Close check: listed periods read closed, everything else open. (Ahead
    // of the limit-1 branch: real close probes end in limit 1 too.)
    if (text.includes('from period_locks')) {
      const closed = state.closedPeriods.some((period) => mentions(period))
      return { rows: closed ? [{ state: 'closed', reopenExpiresAt: null, reason: 'month-end close' }] : [] }
    }
    if (text.includes('limit 1')) {
      return { rows: [] }
    }
    if (text.includes('for update of l')) {
      // Claim-time reload. Listed lines observe their live due row; every
      // other line vanishes before its claim.
      const live = state.due.find(
        (row) => state.claimLive.includes(row.line_id) && mentions(row.line_id),
      )
      if (!live) return { rows: [] }
      return { rows: [{
        line_id: live.line_id,
        planned_amount: live.amount,
        period_id: live.period_id,
        book_id: live.book_id,
        posts_gl: live.posts_gl,
        period_name: live.period_name,
        period_ends_on: live.period_ends_on,
        period_starts_on: live.period_starts_on ?? '2026-09-01',
        period_ends_text: live.period_ends_text ?? live.period_ends_on,
        asset_id: live.asset_id,
        subsidiary_id: live.subsidiary_id,
        base_currency: 'USD',
        asset_number: live.asset_number,
        asset_name: live.asset_name,
        asset_account: live.asset_account,
        asset_accum: live.asset_accum,
        asset_expense: live.asset_expense,
        department_id: live.department_id,
        project_id: live.project_id,
        location_id: live.location_id,
        cat_asset: live.cat_asset,
        cat_accum: live.cat_accum,
        cat_expense: live.cat_expense,
      }] }
    }
    // Subsidiary tree for restriction validation (locks need no rows).
    if (text.includes('from subsidiaries') && !text.includes('join subsidiaries')) {
      return { rows: state.subsidiaries }
    }
    // Journal posting: each entry resolves to a stable id for its asset.
    if (text.includes('insert into journal_entries')) {
      if (mentions('FA-0001')) return { rows: [{ id: '00000000-0000-4000-8000-00000000e101' }] }
      if (mentions('FA-0002')) return { rows: [{ id: '00000000-0000-4000-8000-00000000e102' }] }
      return { rows: [{ id: '00000000-0000-4000-8000-00000000e100' }] }
    }
    // Recognition and line-marking updates affect exactly their line.
    if (text.includes('update depreciation_schedule_lines')) {
      return { rows: [{ id: 'marked' }] }
    }
    if (text.includes('from depreciation_schedule_lines') && text.includes('for update') && !text.includes('for update of l')) {
      // Batch-gate reload: claim-shaped rows — planned amounts plus posted
      // state — so the lock-time comparison runs over realistic values.
      return { rows: state.due.map((row) => ({
        ...row,
        planned_amount: row.amount,
        posted_amount: null,
        period_starts_on: row.period_starts_on ?? '2026-09-01',
        period_ends_text: row.period_ends_text ?? row.period_ends_on,
      })) }
    }
    if (text.includes('from depreciation_schedule_lines')) {
      return { rows: state.due }
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
    `const state = globalThis[Symbol.for('openbooks.depreciation-confirm-route-test')]
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

const engineModule = (await import(
  "@openbooks/engine/src/assets/depreciation.ts"
)) as typeof import("@openbooks/engine/src/assets/depreciation.ts");
const { previewDepreciationFingerprint, runDepreciation, StalePreviewError } = engineModule;

const routeUrl = "./route.ts?depreciation-confirm-test";
const routeModule = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { POST } = routeModule;

function reset(): void {
  state.allowedSubsidiaryIds = null;
  state.books = [{ id: BOOK_ID }];
  state.periods = [{ id: PERIOD_ID }];
  state.assets = [
    { id: ASSET_A, category_id: CATEGORY_ID },
    { id: ASSET_B, category_id: CATEGORY_ID },
  ];
  state.stale = undefined;
  state.due = [
    dueRow(LINE_A, ASSET_A, "FA-0001", "100.0000"),
    dueRow(LINE_B, ASSET_B, "FA-0002", "250.5000"),
  ];
  state.queries = [];
  state.claimLive = [];
  state.closedPeriods = [];
}

function confirm(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/assets/run-depreciation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

function baseConfirm(): Record<string, unknown> {
  return {
    bookId: BOOK_ID,
    periodId: PERIOD_ID,
    asOfDate: "2026-09-30",
    assetIds: [ASSET_A, ASSET_B],
    fingerprint: previewDepreciationFingerprint(
      ORG_ID,
      {
        asOfDate: "2026-09-30",
        bookId: BOOK_ID,
        periodId: PERIOD_ID,
        assetIds: [ASSET_A, ASSET_B],
      },
      state.due.map((row) => ({
        lineId: row.line_id,
        assetId: row.asset_id,
        assetNumber: row.asset_number,
        assetName: row.asset_name,
        subsidiaryId: row.subsidiary_id,
        subsidiaryName: row.subsidiary_name,
        departmentId: row.department_id,
        departmentName: row.department_name,
        projectId: row.project_id,
        projectName: row.project_name,
        locationId: row.location_id,
        locationName: row.location_name,
        bookId: row.book_id,
        bookName: row.book_name,
        postsGl: row.posts_gl,
        periodId: row.period_id,
        periodName: row.period_name,
        periodEndsOn: row.period_ends_on,
        amount: row.amount,
        debitAccountId: EXPENSE_ID,
        debitAccountNumber: "6100",
        debitAccountName: "Depreciation expense",
        creditAccountId: ACCUM_ID,
        creditAccountNumber: "1510",
        creditAccountName: "Accumulated depreciation",
        accountsResolved: true,
        evidence: (row.posts_gl ? "gl-posting" : "reporting-only") as
          | "gl-posting"
          | "reporting-only",
      })),
    ),
  };
}

test("confirm without a fingerprint or selection is refused by name", async () => {
  reset();
  const noPrint = await confirm({
    bookId: BOOK_ID,
    asOfDate: "2026-09-30",
    assetIds: [ASSET_A],
  });
  assert.equal(noPrint.status, 422);
  assert.equal(
    ((await noPrint.json()) as { error: string }).error,
    "fingerprint_required",
  );
  const noSelection = await confirm({
    bookId: BOOK_ID,
    asOfDate: "2026-09-30",
    assetIds: [],
    fingerprint: "abc",
  });
  assert.equal(noSelection.status, 422);
  assert.equal(
    ((await noSelection.json()) as { error: string }).error,
    "nothing_selected",
  );
});

test("foreign scope ids are refused, never silently narrowed", async () => {
  reset();
  const unknownAsset = await confirm({
    ...baseConfirm(),
    assetIds: ["00000000-0000-4000-8000-00000000a099"],
  });
  assert.equal(unknownAsset.status, 422);
  assert.equal(
    ((await unknownAsset.json()) as { error: string }).error,
    "unknown_asset",
  );
  const unknownBook = await confirm({ ...baseConfirm(), bookId: "00000000-0000-4000-8000-00000000b099" });
  assert.equal(unknownBook.status, 422);
  assert.equal(
    ((await unknownBook.json()) as { error: string }).error,
    "book_not_found",
  );
  const unknownPeriod = await confirm({
    ...baseConfirm(),
    periodId: "00000000-0000-4000-8000-000000000999",
  });
  assert.equal(unknownPeriod.status, 422);
  assert.equal(
    ((await unknownPeriod.json()) as { error: string }).error,
    "period_not_found",
  );
});

test("a changed candidate set fails the stale-input fence", async () => {
  reset();
  const body = baseConfirm();
  state.due[0]!.amount = "101.0000";
  const res = await confirm(body);
  assert.equal(res.status, 409);
  assert.equal(
    ((await res.json()) as { error: string }).error,
    "stale_preview",
  );
  state.due[0]!.amount = "100.0000";
});

test("a matching fingerprint over zero rows is a named refusal, not a zero post", async () => {
  reset();
  state.due = [];
  const body = {
    ...baseConfirm(),
    fingerprint: previewDepreciationFingerprint(
      ORG_ID,
      {
        asOfDate: "2026-09-30",
        bookId: BOOK_ID,
        periodId: PERIOD_ID,
        assetIds: [ASSET_A, ASSET_B],
      },
      [],
    ),
  };
  const res = await confirm(body);
  assert.equal(res.status, 422);
  assert.equal(
    ((await res.json()) as { error: string }).error,
    "nothing_due",
  );
});

function expectedFromDue(): {
  fingerprint: string;
  expectedLines: {
    lineId: string;
    assetId: string;
    amount: string;
    periodId: string;
    bookId: string;
    debitAccountId: string;
    creditAccountId: string;
    subsidiaryId: string;
    departmentId: null;
    projectId: null;
    locationId: null;
    evidence: "gl-posting";
  }[];
} {
  const rows = state.due.map((row) => ({
    lineId: row.line_id,
    assetId: row.asset_id,
    amount: row.amount,
    periodId: row.period_id,
    bookId: row.book_id,
    debitAccountId: EXPENSE_ID,
    creditAccountId: ACCUM_ID,
    subsidiaryId: row.subsidiary_id,
    departmentId: null,
    projectId: null,
    locationId: null,
    evidence: "gl-posting" as const,
  }));
  return {
    fingerprint: previewDepreciationFingerprint(
      ORG_ID,
      {
        asOfDate: "2026-09-30",
        bookId: BOOK_ID,
        periodId: PERIOD_ID,
        assetIds: [ASSET_A, ASSET_B],
      },
      rows,
    ),
    expectedLines: rows,
  };
}

test("lines that vanish after the gate abort the batch, never half-post", async () => {
  reset();
  const res = await confirm(baseConfirm());
  const data = (await res.json()) as { error: string };
  // Every previewed claim vanishes in this mock: the gate verified both
  // lines, then validation finds them gone. In one transaction that
  // divergence is impossible, so the batch fails closed (409) instead of
  // posting one line and skipping the other — never a silent zero, never a
  // half-post.
  assert.equal(res.status, 409);
  assert.equal(data.error, "stale_preview");
  assert.ok(!state.queries.some((text) => text.includes("insert into journal")));
  assert.ok(
    !state.queries.some((text) => text.includes("update depreciation_schedule_lines")),
  );
  // The batch scoped its pinned due query to the confirmed line ids.
  const dueTexts = state.queries.filter((text) =>
    text.includes("from depreciation_schedule_lines"),
  );
  assert.ok(
    dueTexts.some((text) => text.includes(LINE_A) && text.includes(LINE_B)),
  );
});

test("drift under the locks aborts the whole batch before any write", async () => {
  reset();
  const { fingerprint, expectedLines } = expectedFromDue();
  // A rebuild re-plans the first due line after the fingerprint was taken.
  state.due[0]!.amount = "101.0000";
  try {
    await assert.rejects(
      runDepreciation(ORG_ID, "2026-09-30", USER_ID, undefined, undefined, BOOK_ID, {
        assetIds: [ASSET_A, ASSET_B],
        periodId: PERIOD_ID,
        lineIds: [LINE_A, LINE_B],
        expectedFingerprint: fingerprint,
        expectedLines,
      }),
      (error: unknown) => {
        assert.ok(error instanceof StalePreviewError);
        // The refusal names the drifted row, not just the batch.
        assert.match((error as Error).message, /FA-0001/);
        assert.match((error as Error).message, /re-preview/);
        return true;
      },
    );
    // All-or-nothing: neither line recognized, no journal write attempted.
    assert.ok(
      !state.queries.some((text) => text.includes("insert into journal")),
    );
    assert.ok(
      !state.queries.some((text) =>
        text.includes("update depreciation_schedule_lines"),
      ),
    );
  } finally {
    state.due[0]!.amount = "100.0000";
  }
});

test("confirm posts every validated line with linked entries", async () => {
  reset();
  state.claimLive = [LINE_A, LINE_B];
  const res = await confirm(baseConfirm());
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    posted: number;
    recorded: number;
    skipped: number;
    totalAmount: string;
    entries: { assetId: string; assetNumber: string; entryId: string; lineId: string }[];
  };
  assert.equal(data.posted, 2);
  assert.equal(data.recorded, 0);
  assert.equal(data.skipped, 0);
  assert.equal(data.totalAmount, "350.5000");
  // Results carry the evidence links the drawer renders: journal entry ids
  // plus the asset each entry belongs to.
  assert.deepEqual(
    data.entries.map((entry) => [entry.assetNumber, entry.entryId, entry.assetId]),
    [
      ["FA-0001", "00000000-0000-4000-8000-00000000e101", ASSET_A],
      ["FA-0002", "00000000-0000-4000-8000-00000000e102", ASSET_B],
    ],
  );
});

test("a reporting-only line is recognized with asset evidence, not a journal", async () => {
  reset();
  state.due[1]!.posts_gl = false;
  state.claimLive = [LINE_A, LINE_B];
  try {
    const res = await confirm(baseConfirm());
    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      posted: number;
      recorded: number;
      recordedAmount: string;
      skipped: number;
      entries: { lineId: string }[];
      recordedEntries: { assetId: string; assetNumber: string; lineId: string }[];
    };
    assert.equal(data.posted, 1);
    assert.equal(data.recorded, 1);
    assert.equal(data.recordedAmount, "250.5000");
    assert.equal(data.skipped, 0);
    assert.deepEqual(
      data.entries.map((entry) => entry.lineId),
      [LINE_A],
    );
    assert.deepEqual(data.recordedEntries, [
      { assetId: ASSET_B, assetNumber: "FA-0002", period: "2026-09", amount: "250.5000", lineId: LINE_B },
    ]);
  } finally {
    state.due[1]!.posts_gl = true;
  }
});

test("a posting date outside a line's period skips that line by name", async () => {
  reset();
  state.due[1]!.period_starts_on = "2026-10-01";
  state.due[1]!.period_ends_text = "2026-10-31";
  state.claimLive = [LINE_A, LINE_B];
  const postingDate = "2026-09-15";
  const rows = state.due.map((row) => ({
    lineId: row.line_id,
    assetId: row.asset_id,
    amount: row.amount,
    periodId: row.period_id,
    bookId: row.book_id,
    debitAccountId: EXPENSE_ID,
    creditAccountId: ACCUM_ID,
    subsidiaryId: row.subsidiary_id,
    departmentId: null,
    projectId: null,
    locationId: null,
    evidence: (row.posts_gl ? "gl-posting" : "reporting-only") as "gl-posting" | "reporting-only",
  }));
  const fingerprint = previewDepreciationFingerprint(
    ORG_ID,
    { asOfDate: "2026-09-30", bookId: BOOK_ID, periodId: PERIOD_ID, assetIds: [ASSET_A, ASSET_B], postingDate },
    rows,
  );
  try {
    const res = await confirm({ ...baseConfirm(), postingDate, fingerprint });
    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      posted: number;
      skipped: number;
      problems: string[];
      entries: { lineId: string }[];
    };
    assert.equal(data.posted, 1);
    assert.equal(data.skipped, 1);
    assert.deepEqual(
      data.entries.map((entry) => entry.lineId),
      [LINE_A],
    );
    assert.ok(
      data.problems.some(
        (problem) =>
          problem.includes("FA-0002") && problem.includes("posting date 2026-09-15"),
      ),
    );
  } finally {
    delete state.due[1]!.period_starts_on;
    delete state.due[1]!.period_ends_text;
  }
});

test("a closed period on a later line aborts the batch before any write", async () => {
  reset();
  // The second line lives in a closed October period: validation passes the
  // first line, then refuses the batch — no write may precede that refusal.
  state.due[1]!.period_id = PERIOD_C;
  state.due[1]!.period_name = "2026-10";
  state.due[1]!.period_starts_on = "2026-10-01";
  state.due[1]!.period_ends_text = "2026-10-31";
  state.closedPeriods = [PERIOD_C];
  state.claimLive = [LINE_A, LINE_B];
  try {
    const res = await confirm(baseConfirm());
    assert.equal(res.status, 409);
    const data = (await res.json()) as { error: string; asset: string; period: string };
    assert.equal(data.error, "period_closed");
    assert.equal(data.asset, "FA-0002");
    assert.equal(data.period, "2026-10");
    // All-or-nothing at the issue level: pass 1 validates every line before
    // pass 2 issues its first write, so the abort leaves zero writes behind
    // (and the outer transaction rolls back whatever a crash could leave).
    assert.ok(!state.queries.some((text) => text.includes("insert into journal")));
    assert.ok(
      !state.queries.some((text) => text.includes("update depreciation_schedule_lines")),
    );
  } finally {
    state.due[1]!.period_id = PERIOD_ID;
    state.due[1]!.period_name = "2026-09";
    delete state.due[1]!.period_starts_on;
    delete state.due[1]!.period_ends_text;
  }
});

test("legacy immediate runs keep working without a fingerprint", async () => {
  reset();
  state.claimLive = [LINE_A];
  const res = await POST(
    new Request("http://openbooks.test/api/assets/run-depreciation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ assetId: ASSET_A, bookId: BOOK_ID, asOfDate: "2026-09-30" }),
    }),
  );
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    posted: number;
    skipped: number;
    entries: { lineId: string; entryId: string }[];
  };
  // The legacy path keeps its historic per-line behavior: the live line
  // posts, the vanished one is named as skipped — no fingerprint required.
  assert.equal(data.posted, 1);
  assert.equal(data.skipped, 1);
  assert.deepEqual(
    data.entries.map((entry) => entry.lineId),
    [LINE_A],
  );
  assert.ok(data.entries[0]!.entryId);
});

test("stale schedules refuse the batch with the rebuild remedy", async () => {
  reset();
  state.stale = [
    { asset_id: ASSET_A, asset_number: "FA-0001", asset_name: "Mill FA-0001" },
  ];
  const res = await confirm(baseConfirm());
  assert.equal(res.status, 409);
  const data = (await res.json()) as {
    error: string;
    assets: { assetId: string; assetNumber: string; assetName: string }[];
  };
  assert.equal(data.error, "schedules_stale");
  assert.deepEqual(
    data.assets.map((asset) => asset.assetNumber),
    ["FA-0001"],
  );
  assert.ok(
    !state.queries.some((text) => text.includes("insert into journal")),
  );
});
