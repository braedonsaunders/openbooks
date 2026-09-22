import assert from "node:assert/strict";
import test from "node:test";
import { BankingError, parseMt940 } from "./banking.ts";

const mt940 = (valueDate: string, balanceDate: string) =>
  [
    ":20:STMT1",
    ":25:12345678",
    ":28C:1",
    `:60F:C${balanceDate}USD1000,00`,
    `:61:${valueDate}0101C10,00NTRFNONREF`,
    ":86:Counterparty description",
    `:62F:C${balanceDate}USD1010,00`,
    "-",
  ].join("\n");

test("MT940 reads the wire comma as the decimal point, never as grouping", () => {
  // SWIFT MT940 amounts carry no grouping separators: the comma IS the point
  // by spec. "12,345" is twelve-point-three-four-five — the three-decimal
  // currencies (KWD, BHD, OMR, TND) write exactly this — and the old
  // grouping guess read it as 12345, a 1000x statement line feeding
  // reconciliation.
  const parsed = parseMt940(
    [
      ":20:S1",
      ":25:ACC",
      ":28C:1",
      ":61:2608210821C12,345NTRFNONREF",
      ":62F:C260821KWD12,345",
      "-",
    ].join("\n"),
  );
  assert.deepEqual(parsed.lines.map((line) => line.amount), ["12.3450"]);
  assert.equal(parsed.closingBalance, "12.3450");
});

test("MT940 expands two-digit years on a fixed pivot, never the wall clock", () => {
  const parsed = parseMt940(mt940("991231", "991231"));
  assert.equal(parsed.lines[0]?.postedOn, "1999-12-31");
  assert.equal(parsed.statementDate, "1999-12-31");
  assert.equal(parsed.lines[0]?.description, "Counterparty description");
});

test("MT940 keeps current-century dates on the same pivot", () => {
  const parsed = parseMt940(mt940("260821", "260821"));
  assert.equal(parsed.lines[0]?.postedOn, "2026-08-21");
  assert.equal(parsed.statementDate, "2026-08-21");
});

test("MT940 refuses to merge multiple statements into one", () => {
  const multi = [
    ":20:STMT-ONE",
    ":25:ACC-ONE",
    ":28C:1",
    ":60F:C260821USD1000,00",
    ":61:2608210821C500,00NTRFREFONE",
    ":86:Alpha deposit",
    ":62F:C260821USD1500,00",
    ":20:STMT-TWO",
    ":25:ACC-TWO",
    ":28C:1",
    ":60F:C260821EUR2000,00",
    ":61:2608210821C700,00NTRFREFTWO",
    ":86:Beta deposit",
    ":62F:C260821EUR2700,00",
    "-",
  ].join("\n");
  assert.throws(
    () => parseMt940(multi),
    (err: unknown) =>
      err instanceof BankingError && /multiple statements/.test(err.message),
  );
});

test("MT940 maps all four debit/credit marks to bank-perspective signs", () => {
  // C/D are plain credit/debit; RC/RD name what is being reversed — a reversal
  // of a credit takes money out (debit) and a reversal of a debit puts it
  // back (credit), per the SWIFT MT940 mark contract.
  const parsed = parseMt940(
    [
      ":20:S1",
      ":25:ACC",
      ":28C:1",
      ":61:2608210821C10,00NTRFA",
      ":61:2608210821D10,00NTRFB",
      ":61:2608210821RC10,00NTRFC",
      ":61:2608210821RD10,00NTRFD",
      ":62F:C260821USD40,00",
      "-",
    ].join("\n"),
  );
  assert.deepEqual(
    parsed.lines.map((line) => line.amount),
    ["10.0000", "-10.0000", "-10.0000", "10.0000"],
  );
});

test("MT940 takes currency from the balance fields, never the account suffix", () => {
  const parsed = parseMt940(
    [
      ":20:S1",
      ":25:ACCOUNTUSD",
      ":28C:1",
      ":61:2608210821C10,00NTRFA",
      ":62F:C260821CAD1010,00",
      "-",
    ].join("\n"),
  );
  assert.equal(parsed.currency, "CAD");
});

test("MT940 refuses contradictory opening and closing balance currencies", () => {
  assert.throws(
    () =>
      parseMt940(
        [
          ":20:S1",
          ":25:ACC",
          ":28C:1",
          ":60F:C260821USD1000,00",
          ":61:2608210821C10,00NTRFA",
          ":62F:C260821CAD1010,00",
          "-",
        ].join("\n"),
      ),
    (err: unknown) =>
      err instanceof BankingError && /contradictory balance currencies USD and CAD/.test(err.message),
  );
});

test("MT940 refuses multiple accounts even under one statement reference", () => {
  const multiAccount = [
    ":20:STMT-ONE",
    ":25:ACC-ONE",
    ":61:2608210821C500,00NTRFREFONE",
    ":86:Alpha deposit",
    ":25:ACC-TWO",
    ":61:2608210821C700,00NTRFREFTWO",
    ":86:Beta deposit",
    "-",
  ].join("\n");
  assert.throws(
    () => parseMt940(multiAccount),
    (err: unknown) =>
      err instanceof BankingError && /multiple accounts.*ACC-ONE.*ACC-TWO/.test(err.message),
  );
});
