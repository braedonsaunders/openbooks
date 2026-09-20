import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { NextResponse } from "next/server";

// Route now fails closed (404) on a non-uuid subsidiary id, so scope fixtures use a real uuid.
const SUB_VISIBLE = '00000000-0000-4000-8000-0000000000e1'

interface TaxPoolRouteState {
  allowedSubsidiaryIds: Set<string> | null;
  explicitSubsidiaryExists: boolean;
  requestedSubsidiaryId: string | undefined;
  explicitBookExists: boolean;
  requestedBookId: string | undefined;
  filterCalls: (string[] | null)[];
  queries: string[];
  runCalls: {
    orgId: string;
    bookId: string;
    subsidiaryId: string;
    regime: string;
    taxYear: number;
  }[];
}

const stateKey = Symbol.for("openbooks.tax-pools-route-test");
const routeState: TaxPoolRouteState = {
  allowedSubsidiaryIds: null,
  explicitSubsidiaryExists: true,
  requestedSubsidiaryId: undefined,
  explicitBookExists: true,
  requestedBookId: undefined,
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
    "mock:json",
    `
      const state = globalThis[Symbol.for('openbooks.tax-pools-route-test')]
      export const jsonObject = {}
      export async function parseJsonBody(request) {
        const data = await request.json()
        state.requestedSubsidiaryId = data && typeof data.subsidiaryId === 'string'
          ? data.subsidiaryId
          : undefined
        state.requestedBookId = data && typeof data.bookId === 'string'
          ? data.bookId
          : undefined
        return { ok: true, data }
      }
    `,
  ],
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
          if (text.includes('from tax_pool_periods')) {
            return { rows: [{ tax_year: '2026', class_code: '8', regime: 'ca_cca' }] }
          }
          if (text.includes('from subsidiaries')) {
            if (text.includes('parent_id is null')) return { rows: [{ id: 'sub-root' }] }
            if (!state.explicitSubsidiaryExists) return { rows: [] }
            return { rows: [{ id: state.requestedSubsidiaryId ?? SUB_VISIBLE }] }
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
      export async function runTaxPool(orgId, bookId, subsidiaryId, regime, taxYear) {
        state.runCalls.push({ orgId, bookId, subsidiaryId, regime, taxYear })
        return { regime, taxYear, lines: [], totals: { allowance: '0', recapture: '0', terminalLoss: '0' } }
      }
    `,
  ],
]);

const selfUrl = new URL(import.meta.url).href;
const mockUrl = (name: string) => `${selfUrl}?tax-pool-mock=${name}`;
const mockUrls = new Map<string, string>([
  ["@/lib/api/json", mockUrl("json")],
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
  routeState.filterCalls = [];
  routeState.queries = [];
  routeState.runCalls = [];
}

function post(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/assets/tax-pools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
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

  const response = await post({ taxYear: 2026, subsidiaryId: "sub-other" });

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
