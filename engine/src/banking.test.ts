import assert from "node:assert/strict";
import test from "node:test";
import { BankingError, parseBai2, parseCsv } from "./banking.ts";

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

test("statement amounts wider than numeric(19,4) fail closed at parse time", () => {
  // Pasted statement figures used to normalize fine and die only at the
  // numeric(19,4) insert with a storage error. Every format funnels through
  // the same column, so every parser refuses the same way.
  assert.throws(
    () => parseCsv("date,amount,description\n2026-07-01,99999999999999999999,salary\n", { date: 0, amount: 1, description: 2 }),
    (error: unknown) => error instanceof BankingError && /out of range/.test(error.message),
  );
  assert.throws(
    () => parseBai2([baiHeader, "16,165,9999999999999999999999,S,REF,,deposit/"].join("\n")),
    (error: unknown) => error instanceof BankingError && /out of range/.test(error.message),
  );
  // The column maximum itself still parses in both spellings.
  const csv = parseCsv("date,amount,description\n2026-07-01,999999999999999.9999,salary\n", { date: 0, amount: 1, description: 2 });
  assert.equal(csv[0]!.amount, "999999999999999.9999");
  const bai = parseBai2([baiHeader, "16,165,99999999999999999,S,REF,,deposit/"].join("\n"));
  assert.equal(bai.lines[0]!.amount, "999999999999999.9900");
});
