import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  computeOpportunityTotals,
  grossMarginPercent,
  matchesTerritory,
  shouldPromoteLifecycle,
  validateContributionTotal,
  validateOpportunityStageTransition,
  weightAmount,
  type OpportunityStagePolicy,
} from "./crm-math.ts";

const crmSource = readFileSync(new URL("./crm.ts", import.meta.url), "utf8");

test("customer-role upserts pin the known tenant on the party_id conflict write", () => {
  assert.match(
    crmSource,
    /on conflict \(party_id\) do update set[\s\S]*?where customer_roles\.org_id = \$\{input\.orgId\}/,
  );
});

test("lifecycle promotion is forward-only", () => {
  assert.equal(shouldPromoteLifecycle("lead", "prospect"), true);
  assert.equal(shouldPromoteLifecycle("lead", "customer"), true);
  assert.equal(shouldPromoteLifecycle("customer", "prospect"), false);
});

test("opportunity totals and weighting are exact at four decimals", () => {
  const totals = computeOpportunityTotals([
    { quantity: "3.0000", unitPrice: "19.9999" },
    { quantity: "0.3333", unitPrice: "100.0000", probability: 25 },
  ], 75);
  assert.equal(totals.lines[0]?.amount, "59.9997");
  assert.equal(totals.lines[1]?.amount, "33.3300");
  assert.equal(totals.lines[1]?.expectedAmount, "8.3325");
  assert.equal(totals.projectedAmount, "93.3297");
  // Weighted sums each line's own rounding (44.9998 @ 75% + 8.3325 @ 25%),
  // not the header rate applied to the projected total.
  assert.equal(totals.weightedAmount, "53.3323");
  assert.equal(weightAmount("0.0001", 50), "0.0001");
});

test("weighted totals honor per-line probability overrides with header fallback", () => {
  const totals = computeOpportunityTotals([
    { quantity: "100.0000", unitPrice: "1.0000", probability: 100 },
    { quantity: "40.0000", unitPrice: "1.0000" },
  ], 20);
  assert.equal(totals.lines[0]?.probability, 100);
  assert.equal(totals.lines[0]?.expectedAmount, "100.0000");
  assert.equal(totals.lines[1]?.probability, 20);
  assert.equal(totals.lines[1]?.expectedAmount, "8.0000");
  assert.equal(totals.weightedAmount, "108.0000");
});

test("probability bounds stay guarded at zero and reject invalid rates", () => {
  assert.equal(weightAmount("123.4567", 0), "0.0000");
  assert.equal(weightAmount("123.4567", 100), "123.4567");
  assert.throws(() => weightAmount("10.0000", -1), /integer from 0 to 100/);
  assert.throws(() => weightAmount("10.0000", 101), /integer from 0 to 100/);
  assert.throws(() => weightAmount("10.0000", 12.5), /integer from 0 to 100/);
});

test("sales-team contributions must total exactly one hundred percent", () => {
  assert.doesNotThrow(() => validateContributionTotal(["60", "40"]));
  assert.throws(() => validateContributionTotal(["60", "39.9999"]), /exactly 100/);
  assert.throws(() => validateContributionTotal(["100", "0"]), /positive/);
});

test("territory rules support deterministic exact comparisons", () => {
  const subject = { lifecycleStage: "lead" as const, country: "CA", region: "Ontario", annualRevenue: "2500000.0000", employeeCount: 45 };
  assert.equal(matchesTerritory(subject, [
    { field: "country", operator: "equals", value: "ca" },
    { field: "annualRevenue", operator: "gte", value: "2000000" },
    { field: "employeeCount", operator: "lte", value: 50 },
  ], "all"), true);
  assert.equal(matchesTerritory(subject, [{ field: "region", operator: "equals", value: "Quebec" }], "all"), false);
});

test("line cost extends with the writer's rounding and yields an exact margin", () => {
  const totals = computeOpportunityTotals([
    { quantity: "3.0000", unitPrice: "100.0000", unitCost: "60.0000" },
  ], 50);
  const line = totals.lines[0]!;
  assert.equal(line.costAmount, "180.0000");
  assert.equal(line.grossProfit, "120.0000");
  assert.equal(line.grossMarginPercent, "40.0000");
  assert.equal(totals.totalCost, "180.0000");
  assert.equal(totals.grossProfit, "120.0000");
  assert.equal(totals.grossMarginPercent, "40.0000");
  assert.equal(totals.isFullyCosted, true);
});

test("an uncosted line reports no margin rather than a free one", () => {
  const totals = computeOpportunityTotals([{ quantity: "2.0000", unitPrice: "50.0000" }], 50);
  const line = totals.lines[0]!;
  // Absence is not zero: a zero cost would claim a 100% margin, and this line
  // makes no claim at all.
  assert.equal(line.unitCost, null);
  assert.equal(line.costAmount, null);
  assert.equal(line.grossProfit, null);
  assert.equal(line.grossMarginPercent, null);
  assert.equal(totals.totalCost, null);
  assert.equal(totals.grossProfit, null);
  assert.equal(totals.grossMarginPercent, null);
  assert.equal(totals.weightedGrossProfit, null);
  assert.equal(totals.isFullyCosted, false);
});

test("a zero cost is a real 100% margin, distinct from an uncosted line", () => {
  const totals = computeOpportunityTotals([{ quantity: "1.0000", unitPrice: "10.0000", unitCost: "0" }], 100);
  assert.equal(totals.lines[0]?.costAmount, "0.0000");
  assert.equal(totals.grossMarginPercent, "100.0000");
  assert.equal(totals.isFullyCosted, true);
});

test("cost above price reports a negative margin instead of clamping at zero", () => {
  const totals = computeOpportunityTotals([
    { quantity: "1.0000", unitPrice: "80.0000", unitCost: "100.0000" },
  ], 50);
  assert.equal(totals.lines[0]?.grossProfit, "-20.0000");
  assert.equal(totals.grossProfit, "-20.0000");
  assert.equal(totals.grossMarginPercent, "-25.0000");
});

test("no revenue means no margin, whatever the cost, and never 0%", () => {
  // 0/0 and -x/0 are both undefined. Reporting either as 0% would state a
  // break-even that nobody measured.
  assert.equal(grossMarginPercent("0.0000", "0.0000"), null);
  assert.equal(grossMarginPercent("0.0000", "500.0000"), null);
  assert.equal(grossMarginPercent("0.0000", null), null);
  const totals = computeOpportunityTotals([{ quantity: "5.0000", unitPrice: "0", unitCost: "12.0000" }], 50);
  assert.equal(totals.projectedAmount, "0.0000");
  assert.equal(totals.grossProfit, "-60.0000");
  assert.equal(totals.grossMarginPercent, null);
});

test("a partly costed deal reports no header cost and says how far along it is", () => {
  const totals = computeOpportunityTotals([
    { quantity: "1.0000", unitPrice: "100.0000", unitCost: "10.0000" },
    { quantity: "1.0000", unitPrice: "100.0000" },
  ], 50);
  // Summing only the costed line would present 10.0000 as the deal's cost and
  // flatter the margin by exactly the line nobody has priced out.
  assert.equal(totals.totalCost, null);
  assert.equal(totals.grossMarginPercent, null);
  assert.equal(totals.lineCount, 2);
  assert.equal(totals.costedLineCount, 1);
  assert.equal(totals.isFullyCosted, false);
});

test("an empty opportunity is not 'fully costed'", () => {
  const totals = computeOpportunityTotals([], 50);
  assert.equal(totals.isFullyCosted, false);
  assert.equal(totals.totalCost, null);
  assert.equal(totals.grossMarginPercent, null);
});

test("margin rounds half away from zero at four decimals", () => {
  // 1/3 of the revenue is profit: 33.333333...% truncates or rounds to
  // 33.3333 rather than drifting through a float.
  assert.equal(grossMarginPercent("3.0000", "2.0000"), "33.3333");
  assert.equal(grossMarginPercent("7.0000", "4.0000"), "42.8571");
  // Exactly half a unit in the last place goes away from zero, both signs:
  // one ten-thousandth of profit on 200.0000 of revenue is 0.00005%.
  assert.equal(grossMarginPercent("200.0000", "199.9999"), "0.0001");
  assert.equal(grossMarginPercent("200.0000", "200.0001"), "-0.0001");
});

test("weighted gross profit follows each line's own probability", () => {
  const totals = computeOpportunityTotals([
    { quantity: "1.0000", unitPrice: "100.0000", unitCost: "40.0000", probability: 100 },
    { quantity: "1.0000", unitPrice: "100.0000", unitCost: "40.0000", probability: 50 },
  ], 10);
  assert.equal(totals.grossProfit, "120.0000");
  // 60 @ 100% + 60 @ 50%, never 120 @ the header's 10%.
  assert.equal(totals.weightedGrossProfit, "90.0000");
});

test("a weighted loss rounds away from zero rather than toward break-even", () => {
  // weightAmount's unsigned rounding would report -0.0000 here, quietly
  // erasing a loss; the signed path keeps it.
  const totals = computeOpportunityTotals([
    { quantity: "1.0000", unitPrice: "0.0000", unitCost: "0.0001", probability: 50 },
  ], 50);
  assert.equal(totals.lines[0]?.grossProfit, "-0.0001");
  assert.equal(totals.weightedGrossProfit, "-0.0001");
});

test("a negative unit cost is refused rather than stored as a rebate", () => {
  assert.throws(
    () => computeOpportunityTotals([{ quantity: "1.0000", unitPrice: "10.0000", unitCost: "-1.0000" }], 50),
    /unit cost cannot be negative/,
  );
});

test("stage policy gates are off until a status declares them", () => {
  const openGate: OpportunityStagePolicy = {
    requiresLines: false,
    requiresPrimaryContact: false,
    requiresPositiveAmount: false,
    requiresWinLossReason: false,
  };
  assert.equal(
    validateOpportunityStageTransition(
      { lineCount: 0, hasPrimaryContact: false, projectedAmount: "0.0000", winLossReason: null },
      openGate,
    ),
    null,
  );
});

test("each declared stage gate refuses with its own stable code", () => {
  const off = {
    requiresLines: false,
    requiresPrimaryContact: false,
    requiresPositiveAmount: false,
    requiresWinLossReason: false,
  };
  const bare = { lineCount: 0, hasPrimaryContact: false, projectedAmount: "0.0000", winLossReason: null };
  assert.equal(
    validateOpportunityStageTransition(bare, { ...off, requiresLines: true }),
    "lines_required",
  );
  assert.equal(
    validateOpportunityStageTransition(bare, { ...off, requiresPrimaryContact: true }),
    "primary_contact_required",
  );
  assert.equal(
    validateOpportunityStageTransition(bare, { ...off, requiresPositiveAmount: true }),
    "positive_amount_required",
  );
  assert.equal(
    validateOpportunityStageTransition(bare, { ...off, requiresWinLossReason: true }),
    "win_loss_reason_required",
  );
});

test("a satisfied stage passes every gate at once", () => {
  assert.equal(
    validateOpportunityStageTransition(
      { lineCount: 2, hasPrimaryContact: true, projectedAmount: "0.0001", winLossReason: "Price" },
      {
        requiresLines: true,
        requiresPrimaryContact: true,
        requiresPositiveAmount: true,
        requiresWinLossReason: true,
      },
    ),
    null,
  );
});

test("a positive-amount gate means priced, not merely non-negative", () => {
  const policy = {
    requiresLines: false,
    requiresPrimaryContact: false,
    requiresPositiveAmount: true,
    requiresWinLossReason: false,
  };
  const subject = { lineCount: 1, hasPrimaryContact: true, winLossReason: null };
  assert.equal(
    validateOpportunityStageTransition({ ...subject, projectedAmount: "0.0000" }, policy),
    "positive_amount_required",
  );
  assert.equal(
    validateOpportunityStageTransition({ ...subject, projectedAmount: "0.0001" }, policy),
    null,
  );
});

test("a whitespace-only reason does not satisfy the loss-reason gate", () => {
  assert.equal(
    validateOpportunityStageTransition(
      { lineCount: 1, hasPrimaryContact: true, projectedAmount: "1.0000", winLossReason: "   " },
      {
        requiresLines: false,
        requiresPrimaryContact: false,
        requiresPositiveAmount: false,
        requiresWinLossReason: true,
      },
    ),
    "win_loss_reason_required",
  );
});

test("the stage gate cannot see a stage's name, only what it declares", () => {
  // Structural: the resolver takes flags, never a key or label, so an
  // organization that renames a stage gets the same rules as one that did not.
  const source = readFileSync(new URL("./crm-math.ts", import.meta.url), "utf8");
  const resolver = source.slice(source.indexOf("export function validateOpportunityStageTransition"));
  const body = resolver.slice(0, resolver.indexOf("\n}"));
  for (const forbidden of ["closed_lost", "closed_won", "proposal", "isClosed", "isWon", "key", "name"]) {
    assert.ok(!body.includes(forbidden), `the stage resolver must not branch on ${forbidden}`);
  }
});

test("the default opportunity stages seed the loss-reason gate 0175 backfills", () => {
  // A fresh organization must land on the same rules an upgraded one gets, and
  // no others: seeding an opinion about Proposal would impose on new tenants a
  // policy existing tenants never agreed to.
  assert.match(crmSource, /\["closed_lost", "Closed lost", 0, "omitted", true, false, false, true\]/);
  assert.match(crmSource, /\["proposal", "Proposal", 50, "most_likely", false, false, false, false\]/);
  assert.match(crmSource, /requires_win_loss_reason/);
});
