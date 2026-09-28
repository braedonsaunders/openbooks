import assert from "node:assert/strict";
import test from "node:test";
import { parseMoney, ZERO_MONEY } from "../money/brands.ts";
import { deriveFundCoverageTieout, fundLedgerDrillScope, type AccountSnapshot, type FinancialPositionStatement } from "./statements.ts";
const snap = (over: Partial<AccountSnapshot> = {}): AccountSnapshot => ({ accountId: "bank", accountNumber: "1000", accountName: "Cash", accountType: "asset_bank", fundId: "f1", fundCode: "F1", restrictionClass: "r", restrictionClassLabel: "R", baseCurrency: "USD", balance: ZERO_MONEY, ...over });

test("fund coverage partitions currency, flags undercoverage, ties, zeroes interfund, and scopes drills", () => {
  const position: FinancialPositionStatement = {
    asOf: "2026-09-30",
    accounts: [
      snap({ balance: parseMoney("100.0000") }),
      snap({ accountId: "rev", accountType: "income", balance: parseMoney("-100.0000") }),
      snap({ accountId: "bank-eur", baseCurrency: "EUR", balance: parseMoney("30.0000") }),
      snap({ accountId: "ar-eur", accountType: "asset_receivable", baseCurrency: "EUR", balance: parseMoney("40.0000") }),
      snap({ accountId: "due-from", accountType: "asset_other", balance: parseMoney("25.0000") }),
      snap({ accountId: "due-to", accountType: "liability_other", balance: parseMoney("-25.0000") }),
    ],
    netAssetsByClass: [], totalAssets: [], totalLiabilities: [],
    totalNetAssets: [{ baseCurrency: "USD", amount: parseMoney("100.0000") }, { baseCurrency: "EUR", amount: parseMoney("70.0000") }],
  };
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
