import assert from "node:assert/strict";
import test from "node:test";
import { cmp } from "../money/money.ts";
import { weekStartOf } from "../resourcing/weeks.ts";
import { Rng } from "./rng.ts";
import { planResourcing, type ResourcingSimPlan } from "./resourcing-plan.ts";

const plan: ResourcingSimPlan = {
  softBookingShare: "0.20",
  practices: [{
    name: "Assurance",
    positions: [{ jobTitle: "Senior Auditor", members: ["Ada Auditor"] }],
    monthlyDemandFactors: {
      1: "1.50", 2: "1.00", 3: "1.00", 4: "1.00", 5: "1.00", 6: "1.00",
      7: "1.00", 8: "1.00", 9: "1.00", 10: "1.00", 11: "1.00", 12: "1.00",
    },
    genericDemand: { jobTitle: "Senior Auditor" },
  }],
};

function makePlan(seed: string) {
  return planResourcing(plan, {
    employees: [{ id: "employee-1", name: "Ada Auditor" }],
    engagements: [{ id: "project-1" }, { id: "project-2" }, { id: "project-3" }],
    window: { startDate: "2026-01-01", endDate: "2026-02-08" },
    utilization: 0.75,
    annualHours: "2080",
  }, Rng.fromSeed(seed));
}

test("peak generic demand exceeds named capacity and off-peak months have none", () => {
  const rows = makePlan("seasonal-test");
  const january = rows.filter((row) => row.weekStart.startsWith("2026-01") && typeof row.jobTitle === "string");
  const february = rows.filter((row) => row.weekStart.startsWith("2026-02") && typeof row.jobTitle === "string");
  assert.ok(january.length > 0);
  assert.ok(january.every((row) => cmp(row.plannedHours, "40.0000") > 0));
  assert.equal(february.length, 0);
});

test("the same seed produces the same resourcing plan", () => {
  assert.deepEqual(makePlan("repeatable"), makePlan("repeatable"));
});

test("every assignment week is Sunday and every generic title is declared", () => {
  const rows = makePlan("calendar-check");
  const declaredTitles = new Set(plan.practices.flatMap((practice) =>
    practice.positions.map((position) => position.jobTitle)
  ));
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(weekStartOf(row.weekStart), row.weekStart);
    if (typeof row.jobTitle === "string") assert.ok(declaredTitles.has(row.jobTitle));
  }
});
