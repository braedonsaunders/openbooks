import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.inventory-advanced-route-test");
const state = {
  allowedSubsidiaryIds: null as Set<string> | null,
  calls: [] as string[],
  recallFilters: [] as Array<Record<string, unknown>>,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

/** Flatten a Drizzle SQL expression to its structural text for scope checks. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk);
      return "";
    })
    .join("");
}
(globalThis as typeof globalThis & Record<string, unknown>).inventoryAdvancedSqlText = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:json",
    `
      export const jsonObject = {}
      export async function parseJsonBody(request) { return { ok: true, data: await request.json() } }
    `,
  ],
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.inventory-advanced-route-test')]
      const sqlText = globalThis.inventoryAdvancedSqlText
      export const db = {
        execute: async (query) => {
          state.calls.push(sqlText(query))
          return { rows: [] }
        },
      }
    `,
  ],
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.inventory-advanced-route-test')]
      export async function guardPermission() {
        return { user: { orgId: 'org-1', id: 'user-1' }, allowedSubsidiaryIds: state.allowedSubsidiaryIds }
      }
    `,
  ],
  ["mock:features", `export async function isFeatureEnabled() { return true }`],
  [
    "mock:inventory",
    `
      const state = globalThis[Symbol.for('openbooks.inventory-advanced-route-test')]
      export class InventoryError extends Error {}
      export class InventoryIdempotencyConflictError extends InventoryError {}
      export async function queryLotRecall(_orgId, filter) {
        state.recallFilters.push(filter)
        return []
      }
      export async function createTransferOrder() {}
      export async function ensureLot() {}
      export async function ensureSerial() {}
      export async function executeIdempotentInventoryAction() {}
      export async function postLandedCostVoucher() {}
      export async function receiveTransferOrder() {}
      export async function shipTransferOrder() {}
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@/lib/api/json", "mock:json"],
  ["@openbooks/engine/src/db.ts", "mock:db"],
  ["@openbooks/engine/src/business-date.ts", "mock:business-date"],
  ["@openbooks/engine/src/inventory.ts", "mock:inventory"],
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
]);

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, _context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    if (url === "mock:business-date") {
      return { format: "module", source: "export async function businessToday() { return '2026-08-28' }", shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?inventory-advanced-scope-test";
const { GET } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(scope: Set<string> | null): void {
  state.allowedSubsidiaryIds = scope;
  state.calls.length = 0;
  state.recallFilters.length = 0;
}

test("restricted reads carry subsidiary scope into every advanced view", async () => {
  const subsidiaryId = "00000000-0000-4000-8000-000000000001";
  for (const view of ["recall", "lots", "landed", "transfers"]) {
    reset(new Set([subsidiaryId]));
    const response = await GET(new Request(`http://openbooks.test/api/inventory/advanced?view=${view}`));
    assert.equal(response.status, 200, view);
    if (view === "recall") {
      assert.deepEqual(state.recallFilters[0]?.subsidiaryIds, [subsidiaryId]);
    } else {
      assert.match(state.calls[0] ?? "", /subsidiary_id/);
    }
  }
});

test("an empty subsidiary scope fails closed without returning read metadata", async () => {
  for (const view of ["recall", "lots", "landed", "transfers"]) {
    reset(new Set());
    const response = await GET(new Request(`http://openbooks.test/api/inventory/advanced?view=${view}`));
    assert.equal(response.status, 200, view);
    if (view === "recall") {
      assert.deepEqual(state.recallFilters[0]?.subsidiaryIds, []);
    } else {
      assert.match(state.calls[0] ?? "", /false/);
    }
  }
});

test("null subsidiary scope remains unrestricted", async () => {
  for (const view of ["recall", "lots", "landed", "transfers"]) {
    reset(null);
    const response = await GET(new Request(`http://openbooks.test/api/inventory/advanced?view=${view}`));
    assert.equal(response.status, 200, view);
    if (view === "recall") {
      assert.equal(state.recallFilters[0]?.subsidiaryIds, null);
    } else {
      assert.doesNotMatch(state.calls[0] ?? "", /and false/);
    }
  }
});
