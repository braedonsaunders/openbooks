import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
// NOTE: the route is imported dynamically AFTER registerHooks below. A
// static import here would cache the real-database graph before the mocks
// install, and every query would hit production-shaped storage.

// POST /api/assets/rebuild-schedules (review/confirm drawer remedy): the
// operator-initiated rebuild for schedules the preview reports as stale.
// Only the database, the session gate, and the engine builder are doubled.
// Boundary validation, tenant-ownership checks, arg forwarding, and refusal
// mapping run REAL.

const stateKey = Symbol.for("openbooks.depreciation-rebuild-route-test");
const ORG_ID = "00000000-0000-4000-8000-00000000f021";
const USER_ID = "00000000-0000-4000-8000-00000000f022";
const BOOK_ID = "00000000-0000-4000-8000-00000000b011";
const ASSET_A = "00000000-0000-4000-8000-00000000a011";
const ASSET_B = "00000000-0000-4000-8000-00000000a012";

interface RouteState {
  books: { id: string }[];
  assets: { id: string; asset_number: string }[];
  built: { assetId: string; bookId: string | undefined }[];
  failOn: string | null;
}

const state: RouteState = {
  books: [{ id: BOOK_ID }],
  assets: [
    { id: ASSET_A, asset_number: "FA-0001" },
    { id: ASSET_B, asset_number: "FA-0002" },
  ],
  built: [],
  failOn: null,
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
).openbooksDepreciationRebuildInspect = inspect;

const mockDb = `
  const state = globalThis[Symbol.for('openbooks.depreciation-rebuild-route-test')]
  const inspect = globalThis.openbooksDepreciationRebuildInspect
  function respond(query) {
    const seen = inspect(query)
    const text = seen.text
    const params = seen.params
    const mentions = (id) => params.some((param) => String(param).includes(id));
    if (text.includes('from accounting_books')) {
      return { rows: state.books.filter((row) => mentions(row.id)) }
    }
    if (text.includes('from fixed_assets')) {
      return { rows: state.assets.filter((row) => mentions(row.id)) }
    }
    return { rows: [] }
  }
  async function execute(query) {
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
    `export async function guardFeaturePermission() {
       return {
         user: { orgId: '${ORG_ID}', id: '${USER_ID}' },
         allowedSubsidiaryIds: null,
       }
     }`,
  ],
  [
    "mock:builder",
    `const state = globalThis[Symbol.for('openbooks.depreciation-rebuild-route-test')]
     export async function buildSchedule(assetId, orgId, actorId, forBookId) {
       state.built.push({ assetId, bookId: forBookId });
       if (state.failOn === assetId) throw new Error('no depreciable months remain');
       return { scheduleId: 'sched-' + assetId.slice(0, 8), lineCount: 14, skippedMonths: [] };
     }`,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../lib/feature-gates", "mock:feature-gates"],
  ["@openbooks/engine/src/assets/depreciation.ts", "mock:builder"],
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

const routeUrl = "./route.ts?depreciation-rebuild-test";
const routeModule = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { POST } = routeModule;

function reset(): void {
  state.books = [{ id: BOOK_ID }];
  state.assets = [
    { id: ASSET_A, asset_number: "FA-0001" },
    { id: ASSET_B, asset_number: "FA-0002" },
  ];
  state.built = [];
  state.failOn = null;
}

function rebuild(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/assets/rebuild-schedules", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("empty selection is refused by name before any rebuild", async () => {
  reset();
  const res = await rebuild({ bookId: BOOK_ID, assetIds: [] });
  assert.equal(res.status, 422);
  assert.equal(
    ((await res.json()) as { error: string }).error,
    "nothing_selected",
  );
  assert.deepEqual(state.built, []);
});

test("foreign scope ids are refused, never silently narrowed", async () => {
  reset();
  const unknownAsset = await rebuild({
    assetIds: ["00000000-0000-4000-8000-00000000a099"],
  });
  assert.equal(unknownAsset.status, 422);
  assert.equal(
    ((await unknownAsset.json()) as { error: string }).error,
    "unknown_asset",
  );
  const unknownBook = await rebuild({ bookId: "00000000-0000-4000-8000-00000000b099", assetIds: [ASSET_A] });
  assert.equal(unknownBook.status, 422);
  assert.equal(
    ((await unknownBook.json()) as { error: string }).error,
    "book_not_found",
  );
  assert.deepEqual(state.built, []);
});

test("rebuild forwards tenant scope and reports per-asset outcomes", async () => {
  reset();
  const res = await rebuild({ bookId: BOOK_ID, assetIds: [ASSET_A, ASSET_B] });
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    rebuilt: { assetId: string; assetNumber: string; lineCount: number }[];
    problems: string[];
  };
  assert.deepEqual(
    data.rebuilt.map((row) => row.assetNumber),
    ["FA-0001", "FA-0002"],
  );
  assert.deepEqual(data.problems, []);
  // Tenant, actor, and book reach the builder — never ambient values.
  assert.deepEqual(state.built, [
    { assetId: ASSET_A, bookId: BOOK_ID },
    { assetId: ASSET_B, bookId: BOOK_ID },
  ]);
});

test("a builder refusal names its asset and spares the rest", async () => {
  reset();
  state.failOn = ASSET_A;
  const res = await rebuild({ assetIds: [ASSET_A, ASSET_B] });
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    rebuilt: { assetId: string; assetNumber: string }[];
    problems: string[];
  };
  assert.deepEqual(
    data.rebuilt.map((row) => row.assetNumber),
    ["FA-0002"],
  );
  assert.equal(data.problems.length, 1);
  assert.match(data.problems[0]!, /FA-0001/);
  assert.match(data.problems[0]!, /no depreciable months remain/);
});
