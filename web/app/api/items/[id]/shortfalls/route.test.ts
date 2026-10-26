import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../../../../../testing/stub-modules";

interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: Set<string> | null;
    permissions: Set<string>;
  } | null;
  calls: string[];
}

const stateKey = Symbol.for("openbooks.item-shortfalls-route-test");
const state: RouteState = { authz: null, calls: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

stubModules({
  authz: `
    const state = globalThis[Symbol.for('openbooks.item-shortfalls-route-test')]
    export function can(authz, permission) { return authz.permissions.has('*') || authz.permissions.has(permission) }
    export function guardUnrestrictedScope() { return null }
    export function guardSubsidiaryScope() { return null }
  `,
  extra: {
    "@/lib/feature-gates": `
      const state = globalThis[Symbol.for('openbooks.item-shortfalls-route-test')]
      export async function guardFeaturePermission() { return state.authz ?? Response.json({ error: 'forbidden' }, { status: 403 }) }
    `,
    "@openbooks/engine/inventory/provisional-attribution": `
      const state = globalThis[Symbol.for('openbooks.item-shortfalls-route-test')]
      export async function listUnattributedDeficits() { state.calls.push('list'); return [] }
      export async function attributeDeficitAccount() { state.calls.push('attribute'); return {} }
    `,
  },
});

const routeUrl = new URL("./route.ts?item-shortfalls-route-test", import.meta.url).href;
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
const ITEM_ID = "00000000-0000-4000-8000-000000000101";

async function post(): Promise<Response> {
  return POST(
    new Request(`http://openbooks.test/api/items/${ITEM_ID}/shortfalls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        deficitId: "00000000-0000-4000-8000-000000000102",
        accountId: "00000000-0000-4000-8000-000000000103",
        reason: "The issue charged this operating account",
      }),
    }),
    { params: Promise.resolve({ id: ITEM_ID }) },
  );
}

test("shortfall attribution returns a permission refusal before looking up the shortfall without gl.post", async () => {
  state.authz = {
    user: { orgId: "org-1", id: "user-1" },
    allowedSubsidiaryIds: new Set(["sub-a"]),
    permissions: new Set(["items.manage"]),
  };
  state.calls.length = 0;
  try {
    const response = await post();
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "missing permission: gl.post" });
    assert.deepEqual(state.calls, []);
  } finally {
    state.authz = null;
  }
});
