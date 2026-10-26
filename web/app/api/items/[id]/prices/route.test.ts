import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../../../../../testing/stub-modules";

interface RouteState {
  allowedSubsidiaryIds: Set<string> | null;
  permissions: string[];
  storeCalls: string[];
  invalidations: number;
}

const stateKey = Symbol.for("openbooks.item-prices-route-boundary-test");
const state: RouteState = {
  allowedSubsidiaryIds: null,
  permissions: [],
  storeCalls: [],
  invalidations: 0,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

stubModules({
  authz: `
    const state = globalThis[Symbol.for('openbooks.item-prices-route-boundary-test')]
    export async function guardPermission(permission) {
      state.permissions.push(permission)
      return { user: { orgId: 'org-1', id: 'actor-1' }, allowedSubsidiaryIds: state.allowedSubsidiaryIds }
    }
    export function guardUnrestrictedScope() { return null }
  `,
  extra: {
    "../../../_pricing/schedule-store": `
      const state = globalThis[Symbol.for('openbooks.item-prices-route-boundary-test')]
      export async function getSchedules() { state.storeCalls.push('GET'); return { schedules: [] } }
      export async function postSchedule() { state.storeCalls.push('POST'); return Response.json({ ok: true }) }
      export async function patchSchedule() { state.storeCalls.push('PATCH'); return Response.json({ ok: true }) }
      export async function deleteSchedule() { state.storeCalls.push('DELETE'); return Response.json({ ok: true }) }
      export const priceScheduleBody = {}
    `,
    "@/lib/analytics/preview-invalidation": `
      const state = globalThis[Symbol.for('openbooks.item-prices-route-boundary-test')]
      export async function invalidateAnalyticsPreviews() { state.invalidations += 1 }
    `,
  },
});

const routeUrl = "./route.ts?item-price-route-boundary-test";
const { GET, PATCH, DELETE } = (await import(routeUrl)) as typeof import("./route.ts");

function reset(): void {
  state.allowedSubsidiaryIds = null;
  state.permissions = [];
  state.storeCalls = [];
  state.invalidations = 0;
}

test("item schedule reads and writes use the shared API boundary", async () => {
  reset();
  const params = Promise.resolve({ id: "item-1" });
  const read = await GET(new Request("http://openbooks.test/api/items/item-1/prices"), { params });
  const patch = await PATCH(
    new Request("http://openbooks.test/api/items/item-1/prices", { method: "PATCH" }),
    { params },
  );
  const remove = await DELETE(
    new Request("http://openbooks.test/api/items/item-1/prices?schedule=s1&revision=0", {
      method: "DELETE",
    }),
    { params },
  );

  assert.deepEqual([read.status, patch.status, remove.status], [200, 200, 200]);
  assert.deepEqual(state.permissions, ["items.read", "items.manage", "items.manage"]);
  assert.deepEqual(state.storeCalls, ["GET", "PATCH", "DELETE"]);
  assert.equal(state.invalidations, 2, "successful mutations invalidate analytics previews");
});
