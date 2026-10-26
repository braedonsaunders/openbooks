import assert from "node:assert/strict";
import test from "node:test";
import { stubModules } from "../../../../testing/stub-modules";

interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
  writes: string[];
}

const stateKey = Symbol.for("openbooks.quote-to-cash-settings-scope-test");
const state: RouteState = { authz: null, writes: [] };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

stubModules({
  authz: `
    const state = globalThis[Symbol.for('openbooks.quote-to-cash-settings-scope-test')]
    export function guardUnrestrictedScope(authz) {
      if (authz.allowedSubsidiaryIds === null) return null
      return Response.json({ error: 'requires unrestricted subsidiary access' }, { status: 403 })
    }
  `,
  extra: {
    "@/lib/feature-gates": `
      const state = globalThis[Symbol.for('openbooks.quote-to-cash-settings-scope-test')]
      export async function guardFeaturePermission() { return state.authz ?? Response.json({ error: 'forbidden' }, { status: 403 }) }
    `,
    "@openbooks/engine/billing/quote-to-cash": `
      const state = globalThis[Symbol.for('openbooks.quote-to-cash-settings-scope-test')]
      export async function getQuoteToCashSettings() { return {} }
      export async function saveQuoteToCashSettings() { state.writes.push('save'); return {} }
      export async function clearQuoteToCashSettings() { state.writes.push('clear'); return {} }
    `,
  },
});

const settingsRouteUrl = new URL("./route.ts?quote-to-cash-scope-test", import.meta.url).href;
const currentSettingsRouteUrl = new URL("./[id]/route.ts?quote-to-cash-scope-test", import.meta.url)
  .href;
const { POST } = (await import(settingsRouteUrl)) as typeof import("./route.ts");
const { PATCH, DELETE } = (await import(
  currentSettingsRouteUrl
)) as typeof import("./[id]/route.ts");

const body = JSON.stringify({
  autoActivateOnSign: false,
  defaultBillingTiming: "arrears",
  defaultStartRule: "quote_date",
  signatureExpiryDays: 30,
  orderFormTemplateId: null,
});

test("restricted subsidiary callers cannot write the organization-wide quote-to-cash policy", async () => {
  state.authz = {
    user: { orgId: "org-1", id: "user-1" },
    allowedSubsidiaryIds: new Set(["sub-a"]),
  };
  state.writes.length = 0;
  try {
    const post = await POST(
      new Request("http://openbooks.test/api/quote-to-cash/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
    );
    const patch = await PATCH(
      new Request("http://openbooks.test/api/quote-to-cash/settings/current", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body,
      }),
      { params: Promise.resolve({ id: "current" }) },
    );
    const remove = await DELETE(
      new Request("http://openbooks.test/api/quote-to-cash/settings/current", {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "current" }) },
    );

    for (const response of [post, patch, remove]) {
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), {
        error: "requires unrestricted subsidiary access",
      });
    }
    assert.deepEqual(state.writes, []);
  } finally {
    state.authz = null;
  }
});
