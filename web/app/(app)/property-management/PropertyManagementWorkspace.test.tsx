import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { decimalCmp, decimalSum } from "../../../lib/statement-format.ts";

const source = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "PropertyManagementWorkspace.tsx",
  ),
  "utf8",
);

test("property-management KPI money aggregates preserve exact decimals", () => {
  assert.equal(decimalSum(["0.1000", "0.2000"]), "0.3000");
  assert.equal(
    decimalSum(["9007199254740992.0000", "1.0000"]),
    "9007199254740993.0000",
  );
  assert.equal(decimalCmp("0.3000", "0") > 0, true);
});

test("property-management KPI totals use exact decimal helpers", () => {
  assert.match(source, /const monthlyRent = decimalSum\(/);
  assert.match(
    source,
    /const overdue = decimalSum\(\[\.\.\.overdueInvoices\.values\(\)\]\)/,
  );
  assert.match(source, /const depositsHeld = decimalSum\(/);
  assert.match(source, /tone=\{decimalCmp\(overdue, "0"\) > 0 \? "danger"/);
  assert.doesNotMatch(
    source,
    /Number\((?:charge\.amount|line\.invoiceOpenBalance|lease\.depositBalance)/,
  );
});
