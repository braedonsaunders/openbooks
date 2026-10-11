import assert from "node:assert/strict";
import test from "node:test";
import { InventoryError, type Runner } from "./contracts.ts";
import { transferInventoryTx, type TransferInput } from "./transfers.ts";

const ORG_ID = "00000000-0000-4000-8000-0000000000a1";

function transferOn(date: string): TransferInput {
  return {
    itemId: "00000000-0000-4000-8000-0000000000b1",
    fromStockLocationId: "00000000-0000-4000-8000-0000000000c1",
    toStockLocationId: "00000000-0000-4000-8000-0000000000c2",
    quantity: "1",
    subsidiaryId: "00000000-0000-4000-8000-0000000000d1",
    date,
  };
}

/** A runner that fails the test if the transfer reaches the ledger. */
const unreachableLedger = {
  execute: async () => {
    throw new Error("ledger reached");
  },
} as unknown as Runner;

for (const date of ["2026-02-30", "2025/11/24", "24-11-2025", ""]) {
  test(`a transfer refuses the non-calendar date ${JSON.stringify(date)} before touching the ledger`, async () => {
    await assert.rejects(
      transferInventoryTx(unreachableLedger, ORG_ID, null, transferOn(date)),
      (error: unknown) =>
        error instanceof InventoryError &&
        error.message === "transfer date must be a valid YYYY-MM-DD date",
    );
  });
}

test("a real calendar date passes date validation and reaches the ledger", async () => {
  await assert.rejects(
    transferInventoryTx(unreachableLedger, ORG_ID, null, transferOn("2025-11-24")),
    (error: unknown) => error instanceof Error && error.message === "ledger reached",
  );
});
