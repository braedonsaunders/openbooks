import assert from "node:assert/strict";
import test from "node:test";
import { BankingError, parseBai2 } from "./banking.ts";

test("BAI2 refuses type-16 detail before a type-02 statement date", () => {
  assert.throws(
    () => parseBai2("16,165,150000,Z,REF,,deposit/\n"),
    (err: unknown) => err instanceof BankingError && /type-02 header date/.test(err.message),
  );
});

test("BAI2 dates type-16 lines from the type-02 header, not the clock", () => {
  const parsed = parseBai2(
    [
      "02,ORG,1,1,260821,0000,CAD,2/",
      "03,123,CAD,015,150000/",
      "16,165,150000,Z,REF,,deposit/",
    ].join("\n"),
  );
  assert.equal(parsed.statementDate, "2026-08-21");
  assert.equal(parsed.lines[0]?.postedOn, "2026-08-21");
});

test("BAI2 expands two-digit years on a fixed pivot, never the wall clock", () => {
  const parsed = parseBai2(
    [
      "02,ORG,1,1,991231,0000,CAD,2/",
      "03,123,CAD,015,150000/",
      "16,165,150000,Z,REF,,deposit/",
    ].join("\n"),
  );
  assert.equal(parsed.statementDate, "1999-12-31");
  assert.equal(parsed.lines[0]?.postedOn, "1999-12-31");
});

test("BAI2 refuses to merge lines from multiple accounts into one statement", () => {
  assert.throws(
    () =>
      parseBai2(
        [
          "02,ORG,1,1,260821,0000,USD,2/",
          "03,ACCT-ONE,USD,015,100000/",
          "16,165,50000,Z,REF-A,ALPHA/",
          "03,ACCT-TWO,EUR,015,200000/",
          "16,165,70000,Z,REF-B,BETA/",
        ].join("\n"),
      ),
    (err: unknown) =>
      err instanceof BankingError && /multiple accounts.*ACCT-ONE.*ACCT-TWO/.test(err.message),
  );
});

test("BAI2 refuses a repeated 03 section for the same account", () => {
  // A second 03 re-states the currency/closing-balance evidence (last write
  // would win) and re-anchors the dates of the lines that follow it.
  assert.throws(
    () =>
      parseBai2(
        [
          "02,ORG,1,1,260821,0000,CAD,2/",
          "03,123,CAD,015,150000/",
          "16,165,150000,Z,REF,,deposit/",
          "03,123,CAD,015,160000/",
          "16,165,10000,Z,REF2,,deposit/",
        ].join("\n"),
      ),
    (err: unknown) => err instanceof BankingError && /repeats account 123/.test(err.message),
  );
});

test("BAI2 refuses a 03 account record without an account number", () => {
  assert.throws(
    () =>
      parseBai2(
        [
          "02,ORG,1,1,260821,0000,CAD,2/",
          "03,,CAD,015,150000/",
          "16,165,150000,Z,REF,,deposit/",
        ].join("\n"),
      ),
    (err: unknown) => err instanceof BankingError && /missing its account number/.test(err.message),
  );
});

test("BAI2 skips complete funds structures before transaction references and repeated summaries", () => {
  const header = "02,ORG,1,1,260821,0000,CAD,2/\n";
  for (const funds of ["Z", "V,260822,1200", "S,20,30,50", "D,2,0,20,2,80"]) {
    const parsed = parseBai2(
      header +
        `03,123,CAD,100,015,015,${funds},015,9000,,Z/\n16,165,100,${funds},BANK-REF,CUSTOMER-REF,wire,text/`,
    );
    assert.equal(parsed.closingBalance, "90.0000");
    assert.equal(parsed.lines[0]!.bankTransactionId, "BANK-REF");
    assert.equal(parsed.lines[0]!.counterpartyRef, "CUSTOMER-REF");
    assert.equal(parsed.lines[0]!.description, "wire,text");
  }
});
test("BAI2 refuses truncated or malformed availability rather than treating its fields as references", () => {
  for (const funds of ["S,100", "D,999999999999999999999", "D,2,0,20", "Q"]) {
    assert.throws(
      () => parseBai2(`02,ORG,1,1,260821,0000,CAD,2/\n03,123,CAD,015,10000/\n16,165,100,${funds}/`),
      BankingError,
    );
  }
});
