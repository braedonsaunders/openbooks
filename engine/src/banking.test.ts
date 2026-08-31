import assert from "node:assert/strict";
import test from "node:test";
import { BankingError, parseBai2 } from "./banking.ts";

const baiHeader = "02,ORG,1,1,260821,0000,CAD,2/";

test("BAI2 rejects amount fields containing anything beyond an optional sign and digits", () => {
  for (const amount of ["12X34", "12-34", "12.34", ""]) {
    const source = [baiHeader, `16,165,${amount},S,REF,,deposit/`].join("\n");
    assert.throws(
      () => parseBai2(source),
      (error: unknown) =>
        error instanceof BankingError && /unparseable amount/.test(error.message),
      `expected malformed BAI2 amount ${JSON.stringify(amount)} to be rejected`,
    );
  }
});

test("BAI2 preserves the sign on exact integer-cent amounts", () => {
  const parsed = parseBai2(
    [
      baiHeader,
      "16,165,+150000,S,REF,,deposit/",
      "16,495,-500,S,REF2,,withdrawal/",
    ].join("\n"),
  );
  assert.deepEqual(
    parsed.lines.map((line) => line.amount),
    ["1500.0000", "-5.0000"],
  );
});
