import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

interface TestState {
  minorUnits: number;
}

const stateKey = Symbol.for("openbooks.contract-costs-amount-test");
const state: TestState = { minorUnits: 2 };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockSources = new Map<string, string>([
  [
    "database",
    `
      const state = globalThis[Symbol.for('openbooks.contract-costs-amount-test')]
      export const db = {
        async execute(_query, mode) { const inMode = (result) => (mode === 'objects' ? result.rows : result); return inMode({ rows: [{ minor_units: state.minorUnits }] }) },
      }
    `,
  ],
  [
    "revenue",
    `
      export class ContractCostError extends Error {
        constructor(message, options = {}) {
          super(message)
          this.status = options.status ?? 422
          this.code = options.code ?? 'contract_cost_invalid'
          this.remedy = options.remedy ?? 'Correct the contract cost input and submit it again.'
        }
      }
    `,
  ],
]);

const selfUrl = new URL(import.meta.url).href;
const mockUrl = (name: string) => `${selfUrl}?contract-costs-mock=${name}`;
const mockUrls = new Map<string, string>([
  ["@openbooks/engine/platform/database", mockUrl("database")],
  ["@openbooks/engine/revenue", mockUrl("revenue")],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier);
    if (mocked) return { shortCircuit: true, url: mocked };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const name = new URL(url).searchParams.get("contract-costs-mock");
    const source = name ? mockSources.get(name) : undefined;
    if (source !== undefined) return { shortCircuit: true, format: "module", source };
    return nextLoad(url, context);
  },
});

const contractCostsUrl = new URL("./contract-costs.ts", import.meta.url).href;
const { contractCostErrorResponse, parseCostAmountMinor } = (await import(
  contractCostsUrl
)) as typeof import("./contract-costs.ts");
const { ContractCostError } = await import("@openbooks/engine/revenue");

test("parses exact minor units and allows zero only for fields that permit it", async () => {
  state.minorUnits = 2;
  assert.equal(await parseCostAmountMinor("org-1", "10.00", "USD"), 1000n);
  assert.equal(await parseCostAmountMinor("org-1", "0.00", "USD", { allowZero: true }), 0n);

  await assert.rejects(
    parseCostAmountMinor("org-1", "0.00", "USD"),
    (error: unknown) =>
      error instanceof ContractCostError && error.code === "contract_cost_amount_non_positive",
  );

  state.minorUnits = 3;
  assert.equal(await parseCostAmountMinor("org-1", "1.234", "BHD"), 1234n);
});

test("refuses malformed and sub-minor amounts as actionable 422 errors", async () => {
  state.minorUnits = 2;
  for (const [amount, code] of [
    ["10.999", "contract_cost_amount_precision"],
    ["10.12345", "contract_cost_amount_invalid"],
    ["abc", "contract_cost_amount_invalid"],
  ] as const) {
    await assert.rejects(parseCostAmountMinor("org-1", amount, "USD"), (error: unknown) => {
      assert.ok(error instanceof ContractCostError);
      assert.equal(error.code, code);
      assert.ok(error.remedy.length > 0);
      const response = contractCostErrorResponse(error, "Unexpected failure.");
      assert.equal(response.status, 422);
      return true;
    });
  }
});
