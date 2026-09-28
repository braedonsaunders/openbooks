import assert from "node:assert/strict";
import test from "node:test";
import { deriveFundCoverageTieout, fundLedgerDrillScope, type AccountSnapshot, type FinancialPositionStatement } from "./statements.ts";
const snap = (over: Partial<AccountSnapshot> = {}) => ({ accountId: "bank", accountNumber: "1000", accountName: "Cash", accountType: "asset_bank", fundId: "f1", fundCode: "F1", restrictionClass: "r", restrictionClassLabel: "R", baseCurrency: "USD", balance: "0.0000", ...over }) as AccountSnapshot;

test("fund coverage partitions currency, flags undercoverage, ties, zeroes interfund, and scopes drills", () => {
  const position = {
    asOf: "2026-09-30",
    accounts: [
      snap({ balance: "100.0000" }),
      snap({ accountId: "rev", accountType: "income", balance: "-100.0000" }),
      snap({ accountId: "bank-eur", baseCurrency: "EUR", balance: "30.0000" }),
      snap({ accountId: "ar-eur", accountType: "asset_receivable", baseCurrency: "EUR", balance: "40.0000" }),
      snap({ accountId: "due-from", accountType: "asset_other", balance: "25.0000" }),
      snap({ accountId: "due-to", accountType: "liability_other", balance: "-25.0000" }),
    ],
    netAssetsByClass: [], totalAssets: [], totalLiabilities: [],
    totalNetAssets: [{ baseCurrency: "USD", amount: "100.0000" }, { baseCurrency: "EUR", amount: "70.0000" }],
  } as FinancialPositionStatement;
  const tieout = deriveFundCoverageTieout(position, new Set(["due-from", "due-to"]));
  assert.equal(tieout.rows.length, 2);
  assert.equal(tieout.rows.find((row) => row.baseCurrency === "EUR")?.coverage, "-40.0000");
  assert.equal(tieout.rows.find((row) => row.baseCurrency === "EUR")?.undercovered, true);
  assert.ok(tieout.netAssetsTie.every((tie) => tie.tied));
  assert.ok(tieout.interfund.every((line) => line.zero));
  assert.deepEqual(
    fundLedgerDrillScope({ bookId: "b", asOf: "2026-09-30", fundId: "f1", label: "F1", accountIds: ["bank"], accountTypes: ["asset_bank"] }),
    { kind: "ledger", label: "F1", bookId: "b", to: "2026-09-30", mode: "balance", accountIds: ["bank"], accountTypes: ["asset_bank"], dims: { segments: { fund: "f1" } } },
  );
});
