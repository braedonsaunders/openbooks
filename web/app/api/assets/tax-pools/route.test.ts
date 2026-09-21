import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextResponse } from "next/server";

// Route now fails closed (404) on a non-uuid subsidiary id, so scope fixtures use a real uuid.
const SUB_VISIBLE = '00000000-0000-4000-8000-0000000000e1'
const WINDOW = '00000000-0000-4000-8000-0000000000e2'

interface TaxPoolRouteState {
  allowedSubsidiaryIds: Set<string> | null;
  explicitSubsidiaryExists: boolean;
  requestedSubsidiaryId: string | undefined;
  explicitBookExists: boolean;
  requestedBookId: string | undefined;
  windowExists: boolean;
  filterCalls: (string[] | null)[];
  queries: string[];
  runCalls: {
    orgId: string;
    bookId: string;
    subsidiaryId: string;
    regime: string;
    taxYear: number;
    options: Record<string, unknown>;
  }[];
}

const stateKey = Symbol.for("openbooks.tax-pools-route-test");
const routeState: TaxPoolRouteState = {
  allowedSubsidiaryIds: null,
  explicitSubsidiaryExists: true,
  requestedSubsidiaryId: undefined,
  explicitBookExists: true,
  requestedBookId: undefined,
  windowExists: true,
  filterCalls: [],
  queries: [],
  runCalls: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;
(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksTaxPoolsSqlText = sqlText;
(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksTaxPoolsNextResponse = NextResponse;

/** Flatten a drizzle SQL chunk into its template text for scripted DB replies. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks)
        return sqlText(chunk);
      return "";
    })
    .join("");
}

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.tax-pools-route-test')]
      const NextResponse = globalThis.openbooksTaxPoolsNextResponse
      export function guardSubsidiaryScope(_gate, subsidiaryId) {
        if (state.allowedSubsidiaryIds !== null && !state.allowedSubsidiaryIds.has(subsidiaryId)) {
          return NextResponse.json({ error: 'not found' }, { status: 404 })
        }
        return null
      }
    `,
  ],
  [
    "mock:feature-gates",
    `
      const state = globalThis[Symbol.for('openbooks.tax-pools-route-test')]
      export async function guardFeaturePermission() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
    `,
  ],
  [
    "mock:subsidiaries",
    `
      import { sql } from 'drizzle-orm'
      const state = globalThis[Symbol.for('openbooks.tax-pools-route-test')]
      export function subsidiaryVisibleFilter(column, allowed) {
        state.filterCalls.push(allowed === null ? null : [...allowed])
        if (allowed === null) return sql\`\`
        const ids = [...allowed]
        return ids.length
          ? sql\` and \${column} = any(\${\`{\${ids.join(',')}}\`}::uuid[])\`
          : sql\` and false\`
      }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.tax-pools-route-test')]
      const sqlText = globalThis.openbooksTaxPoolsSqlText
      export const db = {
        async execute(query) {
          const text = sqlText(query)
          state.queries.push(text)
          if (text.includes('from accounting_books')) {
            if (state.requestedBookId) {
              return state.explicitBookExists ? { rows: [{ id: state.requestedBookId }] } : { rows: [] }
            }
            return { rows: [{ id: 'book-1' }] }
          }
          if (text.includes('from tax_year_windows')) {
            if (!state.windowExists) return { rows: [] }
            return { rows: [{ id: '00000000-0000-4000-8000-0000000000e2',
              subsidiary_id: '00000000-0000-4000-8000-0000000000e1', regime: 'ca_cca',
              year_start: '2026-04-01', year_end: '2026-12-31', filing_year: 2026, reason: 'Year-end change' }] }
          }
          if (text.includes('from tax_pool_periods')) {
            return { rows: [{ tax_year: '2026', class_code: '8', regime: 'ca_cca' }] }
          }
          if (text.includes('from subsidiaries')) {
            if (text.includes('parent_id is null')) return { rows: [{ id: 'sub-root' }] }
            if (!state.explicitSubsidiaryExists) return { rows: [] }
            return { rows: [{ id: state.requestedSubsidiaryId ?? '00000000-0000-4000-8000-0000000000e1' }] }
          }
          throw new Error('unexpected database query: ' + text)
        },
      }
    `,
  ],
  [
    "mock:tax-pool-run",
    `
      const state = globalThis[Symbol.for('openbooks.tax-pools-route-test')]
      export async function listTaxRegimes() {
        return [{ code: 'ca_cca', name: 'Canada CCA', countryCode: 'CA', calculationModel: 'pool' }]
      }
      export async function runTaxPool(orgId, bookId, subsidiaryId, regime, taxYear, options) {
        state.runCalls.push({ orgId, bookId, subsidiaryId, regime, taxYear, options })
        return { regime, taxYear, lines: [], totals: { allowance: '0', recapture: '0', terminalLoss: '0' } }
      }
    `,
  ],
]);

const selfUrl = new URL(import.meta.url).href;
const mockUrl = (name: string) => `${selfUrl}?tax-pool-mock=${name}`;
const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", mockUrl("authz")],
  ["../../../../lib/feature-gates", mockUrl("feature-gates")],
  ["../../../../lib/subsidiaries", mockUrl("subsidiaries")],
  ["@openbooks/engine/src/platform/db.ts", mockUrl("db")],
  ["@openbooks/engine/src/tax-returns/pool-run.ts", mockUrl("tax-pool-run")],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only")
      return { format: "module", shortCircuit: true, url: "mock:server-only" };
    if (specifier === "@/lib/api/json") return nextResolve(new URL("../../../../lib/api/json.ts", import.meta.url).href, context);
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const parsed = new URL(url);
    const source = parsed.searchParams.get("tax-pool-mock")
      ? mockSources.get(`mock:${parsed.searchParams.get("tax-pool-mock")}`)
      : mockSources.get(url);
    if (source !== undefined)
      return { format: "module", source, shortCircuit: true };
    if (url === "mock:server-only")
      return { format: "module", source: "", shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?tax-pools-subsidiary-scope-test";
const { GET, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(allowed: Set<string> | null): void {
  routeState.allowedSubsidiaryIds = allowed;
  routeState.explicitSubsidiaryExists = true;
  routeState.requestedSubsidiaryId = undefined;
  routeState.explicitBookExists = true;
  routeState.requestedBookId = undefined;
  routeState.windowExists = true;
  routeState.filterCalls = [];
  routeState.queries = [];
  routeState.runCalls = [];
}

function post(body: Record<string, unknown>): Promise<Response> {
  routeState.requestedSubsidiaryId = typeof body.subsidiaryId === 'string' ? body.subsidiaryId : undefined;
  routeState.requestedBookId = typeof body.bookId === 'string' ? body.bookId : undefined;
  return POST(
    new Request("http://openbooks.test/api/assets/tax-pools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ regime: 'ca_cca', taxYearWindowId: WINDOW, ...body }),
    }),
  );
}

test("GET applies the caller subsidiary scope to tax pool periods", async () => {
  reset(new Set([SUB_VISIBLE]));

  const response = await GET(
    new Request("http://openbooks.test/api/assets/tax-pools?taxYear=2026"),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(routeState.filterCalls, [[SUB_VISIBLE]]);
  assert.ok(
    routeState.queries.some(
      (query) => query.includes("tp.subsidiary_id") && query.includes("any"),
    ),
    "the tax-pool list query must constrain the joined pool subsidiary",
  );
});

test("POST refuses an explicit subsidiary outside the caller scope before running the pool", async () => {
  reset(new Set([SUB_VISIBLE]));

  const response = await post({ taxYear: 2026, subsidiaryId: "00000000-0000-4000-8000-0000000000f1" });

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not found" });
  assert.deepEqual(
    routeState.runCalls,
    [],
    "an out-of-scope tax pool must never reach the engine",
  );
});

test("POST refuses the implicit root when the caller cannot access that subsidiary", async () => {
  reset(new Set(["sub-child"]));

  const response = await post({ taxYear: 2026 });

  assert.equal(response.status, 404);
  assert.deepEqual(routeState.runCalls, []);
});

test("POST runs an in-scope explicit subsidiary", async () => {
  reset(new Set([SUB_VISIBLE]));

  const response = await post({ taxYear: 2026, subsidiaryId: SUB_VISIBLE });

  assert.equal(response.status, 200);
  assert.deepEqual(routeState.runCalls, [
    {
      orgId: "org-1",
      bookId: "book-1",
      subsidiaryId: SUB_VISIBLE,
      regime: "ca_cca",
      taxYear: 2026,
      options: { taxYearWindowId: WINDOW, yearStart: "2026-04-01", yearEnd: "2026-12-31", actorId: "user-1" },
    },
  ]);
});

test("POST refuses an explicit book outside the caller org before running the pool", async () => {
  reset(null);
  routeState.explicitBookExists = false;

  const response = await post({
    taxYear: 2026,
    bookId: "11111111-1111-4111-8111-111111111111",
    subsidiaryId: SUB_VISIBLE,
  });

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not found" });
  assert.deepEqual(routeState.runCalls, [], "a foreign-org book must never reach the engine");
});


test("POST requires a registered window rather than inventing calendar dates", async () => {
  reset(null);
  const response = await post({ subsidiaryId: SUB_VISIBLE, taxYear: 2026, taxYearWindowId: undefined });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /registered tax-year window/);
  assert.deepEqual(routeState.runCalls, []);
});

test("POST takes exact short-year dates from the registry without a year label input", async () => {
  reset(null);
  const response = await post({ subsidiaryId: SUB_VISIBLE });
  assert.equal(response.status, 200);
  assert.equal(routeState.runCalls[0]?.taxYear, 2026);
  assert.deepEqual(routeState.runCalls[0]?.options, {
    taxYearWindowId: WINDOW, yearStart: "2026-04-01", yearEnd: "2026-12-31", actorId: "user-1",
  });
});

test("POST rejects a label or dates that contradict the selected short year", async () => {
  for (const facts of [{ taxYear: 2025 }, { yearStart: "2026-01-01" }, { yearEnd: "2026-11-30" }]) {
    reset(null);
    const response = await post({ subsidiaryId: SUB_VISIBLE, ...facts });
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /does not match/);
    assert.deepEqual(routeState.runCalls, []);
  }
});

test("POST refuses an unknown or differently scoped tax-year window", async () => {
  reset(null);
  routeState.windowExists = false;
  const response = await post({ subsidiaryId: SUB_VISIBLE });
  assert.equal(response.status, 422);
  assert.match((await response.json()).error, /not declared/);
  assert.deepEqual(routeState.runCalls, []);
});

test("GET window choices enforces subsidiary scope before reading tax history", async () => {
  reset(new Set([]));
  const response = await GET(new Request(`http://openbooks.test/api/assets/tax-pools?view=windows&regime=ca_cca&subsidiaryId=${SUB_VISIBLE}`));
  assert.equal(response.status, 404);
  assert.ok(!routeState.queries.some((query) => query.includes('tax_year_windows')));
});

test("GET window choices carries dates, repeatable label and immutable identity", async () => {
  reset(new Set([SUB_VISIBLE]));
  const response = await GET(new Request(`http://openbooks.test/api/assets/tax-pools?view=windows&regime=ca_cca&subsidiaryId=${SUB_VISIBLE}`));
  assert.equal(response.status, 200);
  const [window] = (await response.json()).windows;
  assert.deepEqual(window, { id: WINDOW, subsidiaryId: SUB_VISIBLE, regime: 'ca_cca',
    yearStart: '2026-04-01', yearEnd: '2026-12-31', filingYear: 2026, reason: 'Year-end change' });
});

test("POST uses real JSON validation for malformed or non-object input", async () => {
  for (const body of ['{', 'null', '[]']) {
    reset(null);
    const response = await POST(new Request('http://openbooks.test/api/assets/tax-pools', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }));
    assert.equal(response.status, 400);
    assert.deepEqual(routeState.runCalls, []);
  }
});

test("POST does not reinterpret an invalid explicit legal entity as the root default", async () => {
  for (const subsidiaryId of ['', null, 42, {}]) {
    reset(null);
    const response = await post({ subsidiaryId });
    assert.equal(response.status, 404);
    assert.deepEqual(routeState.runCalls, []);
    assert.ok(!routeState.queries.some((query) => query.includes('parent_id is null')));
  }
});
