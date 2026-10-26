import assert from "node:assert/strict";
import test from "node:test";
import { processBalanceRows, type ProcessBalanceSource } from "./process-balance.ts";

const green: ProcessBalanceSource = {
  unit: "lb",
  inputQuantity: "200.0000",
  outputQuantity: "0.0000",
  producedOutputQuantity: "0.0000",
};

function row(sources: ProcessBalanceSource[], measured: Record<string, string> = {}) {
  return processBalanceRows(sources, new Map(Object.entries(measured)));
}

test("a measured final output reconciles the balance before its receipt, and the shortfall is a measured loss", () => {
  const [balance] = row([green], { lb: "168.0000" });
  assert.equal(balance?.measuredOutputQuantity, "168.0000");
  assert.equal(balance?.outputQuantity, "0.0000");
  assert.equal(balance?.difference, "32.0000");
  assert.equal(balance?.differenceKind, "measured_loss");
});

test("the receipt of the measured weight keeps the same shrink without double counting", () => {
  const [balance] = row(
    [{ ...green, outputQuantity: "168.0000", producedOutputQuantity: "168.0000" }],
    { lb: "168.0000" },
  );
  assert.equal(balance?.difference, "32.0000");
  assert.equal(balance?.differenceKind, "measured_loss");
});

test("a partial receipt still accounts the whole measured weight, the unreceived part included", () => {
  const [balance] = row(
    [{ ...green, outputQuantity: "150.0000", producedOutputQuantity: "150.0000" }],
    { lb: "168.0000" },
  );
  assert.equal(balance?.difference, "32.0000");
});

test("a receipt above the measured weight is authoritative and adds no unreceived output", () => {
  const [balance] = row(
    [{ ...green, outputQuantity: "170.0000", producedOutputQuantity: "170.0000" }],
    { lb: "168.0000" },
  );
  assert.equal(balance?.difference, "30.0000");
});

test("a by-product receipt counts as recorded output alongside the measured product", () => {
  const [balance] = row(
    [{ ...green, outputQuantity: "10.0000", producedOutputQuantity: "0.0000" }],
    { lb: "168.0000" },
  );
  assert.equal(balance?.difference, "22.0000");
  assert.equal(balance?.differenceKind, "measured_loss");
});

test("without a measured output, an input with no recorded output stays unreconciled", () => {
  const [balance] = row([green]);
  assert.equal(balance?.measuredOutputQuantity, null);
  assert.equal(balance?.difference, "200.0000");
  assert.equal(balance?.differenceKind, "unreconciled");
});

test("an exact match between input and measured output is balanced", () => {
  const [balance] = row([{ ...green, inputQuantity: "168.0000" }], { lb: "168.0000" });
  assert.equal(balance?.difference, "0.0000");
  assert.equal(balance?.differenceKind, "balanced");
});

test("a measured output with no recorded input is unreconciled, not a measured loss", () => {
  const [balance] = row([], { kg: "5.0000" });
  assert.equal(balance?.unit, "kg");
  assert.equal(balance?.inputQuantity, "0");
  assert.equal(balance?.difference, "-5.0000");
  assert.equal(balance?.differenceKind, "unreconciled");
});

test("different units stay separate rows, each reconciled against its own measured output", () => {
  const rows = row(
    [
      green,
      {
        unit: "kg",
        inputQuantity: "1.0000",
        outputQuantity: "0.0000",
        producedOutputQuantity: "0.0000",
      },
    ],
    { lb: "168.0000" },
  );
  assert.deepEqual(
    rows.map((entry) => [entry.unit, entry.differenceKind]),
    [
      ["kg", "unreconciled"],
      ["lb", "measured_loss"],
    ],
  );
});
