import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface ValidationState {
  credentialLoads: number;
  credentials: { hmrcAccessToken?: string; abnGuid?: string };
  received: { hmrcAccessToken?: string; abnGuid?: string } | undefined;
}

const stateKey = Symbol.for("openbooks.stored-tax-id-credentials-test");
const state: ValidationState = {
  credentialLoads: 0,
  credentials: { hmrcAccessToken: "stored-token", abnGuid: "stored-guid" },
  received: undefined,
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    "export const db = { execute: async (_query, mode) => Promise.resolve({ rows: [] }).then((result) => (mode === 'objects' ? result.rows : result)) }",
  ],
  ["mock:features", "export async function lockAndCheckOrgFeature() { return true }"],
  [
    "mock:credentials",
    `const state = globalThis[Symbol.for('openbooks.stored-tax-id-credentials-test')]
    export async function authorityCredentialsForOrg() { state.credentialLoads += 1; return state.credentials }`,
  ],
  [
    "mock:validation",
    `const state = globalThis[Symbol.for('openbooks.stored-tax-id-credentials-test')]
    export async function validatePartyTaxId(_tx, _orgId, rowId, options) {
      state.received = options.credentials
      return { rowId, status: 'valid', consultationNumber: 'REF', revalidateAfter: null }
    }`,
  ],
  ["mock:vat", "export function normalizeVatId(_scheme, value) { return value }"],
  ["mock:cross-border-error", "export class CrossBorderTaxError extends Error {}"],
  ["mock:cross-border-posting", "export function parseCrossBorderElection() { return null }"],
]);
const mockUrls = new Map([
  ["../platform/db.ts", "mock:db"],
  ["../organization/org-feature-lock.ts", "mock:features"],
  ["./authority-connections.ts", "mock:credentials"],
  ["./vat-id-validation.ts", "mock:validation"],
  ["../connectors/vat-validation.ts", "mock:vat"],
  ["./cross-border-place-of-supply.ts", "mock:cross-border-error"],
  ["./cross-border-posting.ts", "mock:cross-border-posting"],
]);

registerHooks({
  resolve(specifier, _context, nextResolve) {
    const url = mockUrls.get(specifier);
    return url ? { url, shortCircuit: true } : nextResolve(specifier);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    return source === undefined
      ? nextLoad(url, context)
      : { format: "module", source, shortCircuit: true };
  },
});

const { validateStoredTaxId } = await import("./cross-border-records.ts");

test("interactive stored tax ID validation loads authority credentials for its organization", async () => {
  state.credentialLoads = 0;
  state.received = undefined;
  const result = await validateStoredTaxId("org-1", "row-1", "actor-1", {}, {
    execute: async (_query: unknown, mode?: string) =>
      Promise.resolve({ rows: [] }).then(<T extends { rows: unknown }>(result: T) =>
        mode === "objects" ? result.rows : result,
      ),
  } as never);
  assert.deepEqual(state.received, state.credentials);
  assert.equal(state.credentialLoads, 1);
  assert.deepEqual(result, { id: "row-1", status: "valid", consultationNumber: "REF" });
});
