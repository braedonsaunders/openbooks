import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const coreSource = readFileSync(join(import.meta.dirname, "core.ts"), "utf8");

// This is the row returned by the GL-history rollup for one account/week when
// the ledger contains a +1,000 inflow and a -400 refund.
const period = {
  net: 1_000 - 400,
  gross: Math.abs(1_000) + Math.abs(-400),
};

test("GL history net mode keeps signed activity in both forecast paths", () => {
  assert.equal(period.net, 600, "forecast history series");
  assert.equal(Math.abs(period.net), 600, "source-account average");
  assert.match(coreSource, /const activity = useNet \? net : gross/);
});

test("GL history gross mode keeps line magnitudes in both forecast paths", () => {
  assert.equal(period.gross, 1_400, "forecast history series");
  assert.equal(Math.abs(period.gross), 1_400, "source-account average");
  assert.match(
    coreSource,
    /sum\(l\.amount\) as net, sum\(abs\(l\.amount\)\) as gross/,
  );
});

test("categoryWeekly feeds the selected activity into history and source-account totals", () => {
  assert.match(coreSource, /weeklyHistory\[x\.wk\][\s\S]{0,140}activity/);
  assert.match(coreSource, /accountTotals\.set\(label,[\s\S]{0,140}activity/);
});
