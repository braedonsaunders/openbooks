import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { after } from "node:test";

// Tax pack installation changes organization-wide statutory forms and
// libraries, so subsidiary-restricted setup managers cannot install them.
interface TaxSetupState {
  restricted: boolean;
  provisionCalls: number;
  installCalls: number;
}

const stateKey = Symbol.for("openbooks.tax-setup-scope-test");
const taxState: TaxSetupState = { restricted: false, provisionCalls: 0, installCalls: 0 };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = taxState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.tax-setup-scope-test')]
      export async function getAuthz() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.restricted ? new Set(['sub-a']) : null,
        }
      }
      export async function guardPermission() {
        return {
          user: { orgId: 'org-1', id: 'user-1' },
          allowedSubsidiaryIds: state.restricted ? new Set(['sub-a']) : null,
        }
      }
      // Org-wide configuration gate: only an explicit unrestricted scope
      // passes — the canonical assertUnrestrictedScope rule.
      export function guardUnrestrictedScope(authz) {
        if (authz.allowedSubsidiaryIds === null) return null
        return Response.json({ error: 'requires unrestricted subsidiary access' }, { status: 403 })
      }
      export function guardRootSubsidiaryScope() { return null }
    `,
  ],
  [
    "mock:provisioning",
    `
      const state = globalThis[Symbol.for('openbooks.tax-setup-scope-test')]
      export function isTaxProvisionSelection() { return true }
      export async function packInstallationStatuses() { return [] }
      export async function provisionTaxPacks() {
        state.provisionCalls += 1
        return { installed: [] }
      }
    `,
  ],
  [
    "mock:seed-forms",
    `
      const state = globalThis[Symbol.for('openbooks.tax-setup-scope-test')]
      export const TAX_RETURN_PACKS = [{ code: 'X' }]
      export async function installTaxReturnPacks() {
        state.installCalls += 1
        return []
      }
    `,
  ],
  [
    "mock:return-queries",
    `
      export async function listTaxReturnForms() { return [] }
      export async function listInstalledTaxReturnFormCodes() { return [] }
    `,
  ],
  [
    "mock:db",
    `
      export const ambientTenantOrgId = () => null
      export const currentRequestOrgResolver = () => null
      export const registerRequestOrgResolver = () => {}
      export const withBypass = (fn) => fn()
      export const withBypassContext = (fn) => fn()
      export const db = {
        async execute(_query, mode) { const inMode = (result) => (mode === 'objects' ? result.rows : result); return inMode({ rows: [] }) },
      }
    `,
  ],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@openbooks/engine/platform/db")
      return { url: "mock:db", shortCircuit: true };
    if (specifier === "@openbooks/engine/tax/pack-provisioning") {
      return { url: "mock:provisioning", shortCircuit: true };
    }
    if (specifier === "@openbooks/engine/tax/seed-tax-forms") {
      return { url: "mock:seed-forms", shortCircuit: true };
    }
    if (specifier === "@openbooks/engine/tax-returns/return-queries") {
      return { url: "mock:return-queries", shortCircuit: true };
    }
    if (specifier === "@/lib/authz" || specifier.endsWith("/lib/authz"))
      return { url: "mock:authz", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const provisionUrl = "../provision/route.ts?tax-setup-scope-test";
const { POST: provisionPost } = (await import(
  provisionUrl
)) as typeof import("../provision/route.ts");
const returnsUrl = "./route.ts?tax-setup-scope-test";
const { POST: returnsPost } = (await import(returnsUrl)) as typeof import("./route.ts");
after(() => hooks.deregister());

function jsonRequest(body: unknown): Request {
  return new Request("http://openbooks.test/api/tax", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function reset(restricted: boolean): void {
  taxState.restricted = restricted;
  taxState.provisionCalls = 0;
  taxState.installCalls = 0;
}

test("provision by a restricted setup manager is refused before provisioning", async () => {
  reset(true);
  const response = await provisionPost(jsonRequest({ packs: ["CA_GST_HST"] }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
  assert.equal(taxState.provisionCalls, 0);
});

test("provision by an unrestricted setup manager proceeds", async () => {
  reset(false);
  const response = await provisionPost(jsonRequest({ packs: ["CA_GST_HST"] }));
  assert.equal(response.status, 200);
  assert.equal(taxState.provisionCalls, 1);
});

test("return-pack install by a restricted setup manager is refused before planning writes", async () => {
  reset(true);
  const response = await returnsPost(jsonRequest({ mode: "install", packs: ["X"] }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "requires unrestricted subsidiary access" });
  assert.equal(taxState.installCalls, 0);
});

test("return-pack install by an unrestricted setup manager proceeds", async () => {
  reset(false);
  const response = await returnsPost(jsonRequest({ mode: "install", packs: ["X"] }));
  assert.equal(response.status, 200);
  assert.equal(taxState.installCalls, 1);
});
