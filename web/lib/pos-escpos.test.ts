import assert from "node:assert/strict";
import test from "node:test";
import { asciiFold, encodeEscPos, padPair } from "./pos-escpos.ts";

test("receipt text folds to printable ASCII so every printer code page prints it the same", () => {
  assert.equal(asciiFold("Café crème — 2×"), "Cafe creme - 2?");
  assert.equal(asciiFold("“Total”"), '"Total"');
});

test("a label and an amount share one line, the label clipped before the amount", () => {
  assert.equal(padPair("Coffee", "4.50", 16), "Coffee      4.50");
  assert.equal(padPair("A very long product name", "12.00", 16), "A very lon 12.00");
  assert.equal(padPair("Total", "1,234.50", 16).length, 16);
});

test("the byte stream initializes the printer, prints each line and ends with a cut", () => {
  const bytes = encodeEscPos(
    [
      { kind: "text", text: "Shop", align: "center", bold: true },
      { kind: "rule" },
      { kind: "pair", left: "Total", right: "9.99" },
    ],
    20,
  );
  assert.deepEqual([...bytes.slice(0, 2)], [0x1b, 0x40]);
  assert.deepEqual([...bytes.slice(-4)], [0x1d, 0x56, 0x42, 0x00]);
  const text = String.fromCharCode(...bytes.filter((byte) => byte >= 0x20 && byte <= 0x7e));
  assert.ok(text.includes("Shop"));
  assert.ok(text.includes("-".repeat(20)));
  assert.ok(text.includes("Total           9.99"));
});
