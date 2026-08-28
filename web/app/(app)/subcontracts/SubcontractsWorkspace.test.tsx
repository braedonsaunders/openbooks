import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  decimalAdd,
  decimalCmp,
  decimalNeg,
  decimalSum,
} from "../../../lib/statement-format.ts";

const source = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "SubcontractsWorkspace.tsx"),
  "utf8",
);

test("subcontract money aggregates preserve numeric(19,4) precision", () => {
  assert.equal(decimalSum(["0.1000", "0.2000"]), "0.3000");
  assert.equal(
    decimalSum(["9007199254740992.0000", "1.0000"]),
    "9007199254740993.0000",
  );

  const available = decimalAdd(
    decimalSum(["0.1000", "0.2000"]),
    decimalNeg(decimalSum(["0.3000"])),
  );
  assert.equal(available, "0.0000");
  assert.equal(decimalCmp(available, "0") > 0, false);
});

test("workspace totals and retainage availability use exact decimal helpers", () => {
  assert.match(source, /sumSubcontractAmounts\([^\n]+grossThisPeriod/);
  assert.match(source, /sumSubcontractAmounts\([^\n]+scheduledValue/);
  assert.match(source, /sumSubcontractAmounts\([^\n]+retainageThisPeriod/);
  assert.match(source, /sumSubcontractAmounts\([^\n]+release\.amount/);
  assert.match(
    source,
    /const available = subtractSubcontractAmounts\(postedHeld, released\)/,
  );
  assert.match(source, /decimalCmp\(available, "0"\) > 0/);
  assert.doesNotMatch(
    source,
    /reduce\(\(n, (?:app|line|release)\) => n \+ Number\(/,
  );
});
