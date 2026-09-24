import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const stateKey = Symbol.for("openbooks.inventory-advanced-route-test");
const state = {
  allowedSubsidiaryIds: null as Set<string> | null,
  calls: [] as string[],
  recallFilters: [] as Array<Record<string, unknown>>,
  permissionCalls: [] as unknown[],
  idempotencyCalls: [] as Array<{ operation: string; request: unknown }>,
  voucherSubsidiary: null as string | null,
  reverseResult: null as unknown,
  reverseError: null as unknown,
  ErrorClasses: null as Record<string, new (message?: string) => Error> | null,
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
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.inventory-advanced-route-test')]
      const sqlText = globalThis.inventoryAdvancedSqlText
      export const db = {
        execute: async (query) => {
          const text = sqlText(query)
          state.calls.push(text)
          if (text.includes('landed_cost_vouchers') && state.voucherSubsidiary) {
            return { rows: [{ subsidiary_id: state.voucherSubsidiary }] }
          }
          return { rows: [] }
        },
      }
    `,
  ],
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.inventory-advanced-route-test')]
      export async function guardPermission(permission) {
        state.permissionCalls.push(permission)
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
      export class InventoryOwnershipError extends InventoryError {}
      export class InventoryIdempotencyConflictError extends InventoryError {}
      state.ErrorClasses = { InventoryError, InventoryOwnershipError, InventoryIdempotencyConflictError }
      export async function queryLotRecall(_orgId, filter) {
        state.recallFilters.push(filter)
        return []
      }
      export async function createTransferOrder() {}
      export async function ensureLot() {}
      export async function ensureSerial() {}
      export async function executeIdempotentInventoryAction(_orgId, _userId, { operation, request, execute }) {
        state.idempotencyCalls.push({ operation, request })
        return { value: await execute(), replayed: false }
      }
      export async function postLandedCostVoucher() {}
      export async function receiveTransferOrder() {}
      export async function reverseLandedCostVoucher() {
        if (state.reverseError) throw state.reverseError
        return state.reverseResult ?? { voucherId: 'voucher-1', entryId: 'entry-1', alreadyReversed: false, reversedAllocations: 1 }
      }
      export async function shipTransferOrder() {}
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["@openbooks/engine/src/platform/business-date.ts", "mock:business-date"],
  ["@openbooks/engine/src/inventory/action-idempotency.ts", "mock:inventory"],
  ["@openbooks/engine/src/inventory/contracts.ts", "mock:inventory"],
  ["@openbooks/engine/src/inventory/landed-cost.ts", "mock:inventory"],
  ["@openbooks/engine/src/inventory/tracking.ts", "mock:inventory"],
  ["@openbooks/engine/src/inventory/transfer-orders.ts", "mock:inventory"],
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
]);

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === "@/lib/api/json") {
      return nextResolve(new URL("../../../../lib/api/json.ts", import.meta.url).href, _context);
    }
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
const { GET, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(scope: Set<string> | null): void {
  state.allowedSubsidiaryIds = scope;
  state.calls.length = 0;
  state.recallFilters.length = 0;
  state.permissionCalls.length = 0;
  state.idempotencyCalls.length = 0;
  state.voucherSubsidiary = null;
  state.reverseResult = null;
  state.reverseError = null;
}

function post(body: Record<string, unknown>): Request {
  return new Request("http://openbooks.test/api/inventory/advanced", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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

test("reversing a landed-cost voucher demands the reversal authority, not the posting grant", async () => {
  reset(null);
  const voucherId = "00000000-0000-4000-8000-000000000010";
  const response = await POST(
    post({
      action: "reverseLandedVoucher",
      id: voucherId,
      date: "2026-08-28",
      memo: "Freight was billed to the wrong receipt",
      idempotencyKey: "key-1",
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(state.permissionCalls, ["items.reverse"]);
  assert.equal(state.idempotencyCalls.length, 1);
  assert.equal(state.idempotencyCalls[0]!.operation, "inventory.landed-voucher.reverse");
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.alreadyReversed, false);
});

test("landed-cost reversal validates voucher, date, and reason at the boundary", async () => {
  reset(null);
  const voucherId = "00000000-0000-4000-8000-000000000010";
  for (const [name, payload] of [
    ["missing voucher", { action: "reverseLandedVoucher", date: "2026-08-28", memo: "Freight was billed wrong" }],
    ["missing date", { action: "reverseLandedVoucher", id: voucherId, memo: "Freight was billed wrong" }],
    ["short reason", { action: "reverseLandedVoucher", id: voucherId, date: "2026-08-28", memo: "oops" }],
    ["malformed date", { action: "reverseLandedVoucher", id: voucherId, date: "soon", memo: "Freight was billed wrong" }],
  ] as const) {
    const response = await POST(post({ ...payload }));
    assert.equal(response.status, 422, name);
  }
  assert.equal(state.idempotencyCalls.length, 0, "refused reversals never reach the engine");
});

test("restricted callers cannot reverse a voucher of a subsidiary they cannot see", async () => {
  const allowed = "00000000-0000-4000-8000-000000000001";
  const voucherId = "00000000-0000-4000-8000-000000000010";
  reset(new Set([allowed]));
  state.voucherSubsidiary = "00000000-0000-4000-8000-000000000002";
  const denied = await POST(
    post({
      action: "reverseLandedVoucher",
      id: voucherId,
      date: "2026-08-28",
      memo: "Freight was billed to the wrong receipt",
      idempotencyKey: "key-2",
    }),
  );
  assert.equal(denied.status, 403);
  assert.equal(state.idempotencyCalls.length, 0);

  reset(new Set([allowed]));
  state.voucherSubsidiary = allowed;
  const allowedResponse = await POST(
    post({
      action: "reverseLandedVoucher",
      id: voucherId,
      date: "2026-08-28",
      memo: "Freight was billed to the wrong receipt",
      idempotencyKey: "key-3",
    }),
  );
  assert.equal(allowedResponse.status, 200);
  assert.equal(state.idempotencyCalls.length, 1);
});

test("recall filters are validated at the boundary before they reach the engine", async () => {
  const uuid = "00000000-0000-4000-8000-000000000002";
  for (const query of [
    "lotId=not-a-lot",
    "itemId=not-an-item",
    "expiresOnOrBefore=soon",
    "expiresOnOrBefore=2026-13-45",
    "expiresOnOrBefore=20260831",
  ]) {
    reset(null);
    const response = await GET(new Request(`http://openbooks.test/api/inventory/advanced?view=recall&${query}`));
    assert.equal(response.status, 422, query);
    assert.equal(state.recallFilters.length, 0, `${query} must not reach queryLotRecall`);
  }
  reset(null);
  const ok = await GET(
    new Request(`http://openbooks.test/api/inventory/advanced?view=recall&lotId=${uuid}&itemId=${uuid}&expiresOnOrBefore=2026-08-31`),
  );
  assert.equal(ok.status, 200);
  assert.equal(state.recallFilters[0]?.lotId, uuid);
  assert.equal(state.recallFilters[0]?.itemId, uuid);
  assert.equal(state.recallFilters[0]?.expiresOnOrBefore, "2026-08-31");
});

test("createTransfer carries a caller-selected transit warehouse to the engine", async () => {
  reset(null);
  const ids = {
    from: "00000000-0000-4000-8000-000000000021",
    to: "00000000-0000-4000-8000-000000000022",
    item: "00000000-0000-4000-8000-000000000023",
    subsidiary: "00000000-0000-4000-8000-000000000024",
    transit: "00000000-0000-4000-8000-000000000025",
  };
  const response = await POST(
    post({
      action: "createTransfer",
      idempotencyKey: "transit-key-1",
      fromStockLocationId: ids.from,
      toStockLocationId: ids.to,
      subsidiaryId: ids.subsidiary,
      transitStockLocationId: ids.transit,
      orderedOn: "2026-08-28",
      lines: [{ itemId: ids.item, quantity: "2" }],
    }),
  );
  assert.equal(response.status, 201);
  assert.equal(state.idempotencyCalls.length, 1);
  assert.equal(state.idempotencyCalls[0]!.operation, "inventory.transfer-order.create");
  const request = state.idempotencyCalls[0]!.request as Record<string, unknown>;
  assert.equal(request.transitStockLocationId, ids.transit);
});

test("createTransfer without a transit warehouse sends null for engine defaulting", async () => {
  reset(null);
  const ids = {
    from: "00000000-0000-4000-8000-000000000021",
    to: "00000000-0000-4000-8000-000000000022",
    item: "00000000-0000-4000-8000-000000000023",
    subsidiary: "00000000-0000-4000-8000-000000000024",
  };
  const response = await POST(
    post({
      action: "createTransfer",
      idempotencyKey: "transit-key-2",
      fromStockLocationId: ids.from,
      toStockLocationId: ids.to,
      subsidiaryId: ids.subsidiary,
      orderedOn: "2026-08-28",
      lines: [{ itemId: ids.item, quantity: "2" }],
    }),
  );
  assert.equal(response.status, 201);
  const request = state.idempotencyCalls[0]!.request as Record<string, unknown>;
  assert.equal(request.transitStockLocationId, null);
});

test("an engine ownership refusal surfaces as 403, not a validation miss", async () => {
  reset(null);
  const OwnershipError = state.ErrorClasses!.InventoryOwnershipError!;
  state.reverseError = new OwnershipError("cross-entity voucher reversal refused");
  const response = await POST(
    post({
      action: "reverseLandedVoucher",
      id: "00000000-0000-4000-8000-000000000010",
      date: "2026-08-28",
      memo: "Freight was billed to the wrong receipt",
      idempotencyKey: "key-ownership",
    }),
  );
  assert.equal(response.status, 403);
  const body = (await response.json()) as Record<string, unknown>;
  assert.match(String(body.error), /cross-entity voucher reversal refused/);
});
