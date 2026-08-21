import assert from "node:assert/strict";
import test from "node:test";
import { BankingError, parseBai2 } from "./banking.ts";

test("BAI2 refuses type-16 detail before a type-02 statement date", () => {
  assert.throws(
    () => parseBai2("16,165,150000,S,REF,,deposit/\n"),
    (err: unknown) => err instanceof BankingError && /type-02 header date/.test(err.message),
  );
});

test("BAI2 dates type-16 lines from the type-02 header, not the clock", () => {
  const parsed = parseBai2(
    [
      "02,ORG,1,1,260821,0000,CAD,2/",
      "03,123,CAD,015,150000/",
      "16,165,150000,S,REF,,deposit/",
    ].join("\n"),
  );
  assert.equal(parsed.statementDate, "2026-08-21");
  assert.equal(parsed.lines[0]?.postedOn, "2026-08-21");
});
