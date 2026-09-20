import assert from "node:assert/strict";
import test from "node:test";
import {
  applyReciprocity,
  applyWeeklyRule,
  compRuleMatches,
  evaluateRatio,
  perDiemAmountForDay,
  pickCompRule,
  scopeScore,
} from "./pure.ts";
import { HrmConstructionError } from "./errors.ts";

test("scope precedence is project over location over subsidiary over org; mismatches do not apply", () => {
  const target = { projectId: "p1", locationId: "l1", subsidiaryId: "s1" };
  assert.equal(scopeScore({ project_ids: ["p1"] }, target), 3);
  assert.equal(scopeScore({ project_ids: ["p9"] }, target), -1);
  assert.equal(scopeScore({ location_ids: ["l1"] }, target), 2);
  assert.equal(scopeScore({ location_ids: ["l9"] }, target), -1);
  assert.equal(scopeScore({ employer_subsidiary_id: "s1" }, target), 1);
  assert.equal(scopeScore({ employer_subsidiary_id: "s9" }, target), -1);
  assert.equal(scopeScore({}, target), 0);
  // A project-scoped schedule beats a location-scoped one even when both match.
  assert.ok(
    scopeScore({ project_ids: ["p1"] }, target) > scopeScore({ location_ids: ["l1"] }, target),
  );
});

test("reciprocity: home, jobsite, and higher-of price from the named line", () => {
  const jobsite = { base: "50.0000", fringeCash: "1.0000", fringeCredit: "2.0000" };
  const home = { base: "55.0000", fringeCash: "0.5000", fringeCredit: "0.5000" };
  assert.deepEqual(applyReciprocity("home_local", jobsite, home), { line: home, source: "home_local" });
  assert.deepEqual(applyReciprocity("jobsite_local", jobsite, home), {
    line: jobsite,
    source: "jobsite_local",
  });
  // Higher-of takes the greater BASE with its own fringes riding along — never mixed.
  assert.deepEqual(applyReciprocity("higher_of", jobsite, home), { line: home, source: "higher_of" });
  assert.deepEqual(applyReciprocity("higher_of", home, jobsite), { line: home, source: "higher_of" });
  assert.throws(() => applyReciprocity("home_local", jobsite, null), HrmConstructionError);
  // No home line on higher_of prices at the jobsite rather than refusing.
  assert.deepEqual(applyReciprocity("higher_of", jobsite, null), {
    line: jobsite,
    source: "jobsite_local",
  });
});

test("per-diem: flat, brackets, hours threshold, and the weekly rule", () => {
  assert.equal(perDiemAmountForDay("flat_daily", { amount: "75.0000" }, {}), "75.0000");
  assert.throws(
    () => perDiemAmountForDay("flat_daily", {}, {}),
    /no amount in its rules/,
  );
  const brackets = {
    brackets: [
      { min_km: 0, max_km: 50, amount: "25.0000" },
      { min_km: 51, max_km: null, amount: "85.0000" },
    ],
  };
  assert.equal(perDiemAmountForDay("distance_brackets", brackets, { distanceKm: 30 }), "25.0000");
  assert.equal(perDiemAmountForDay("distance_brackets", brackets, { distanceKm: 51 }), "85.0000");
  assert.throws(
    () => perDiemAmountForDay("distance_brackets", { brackets: [] }, { distanceKm: 30 }),
    /No distance bracket covers 30 km/,
  );
  assert.throws(
    () => perDiemAmountForDay("distance_brackets", brackets, {}),
    /needs the day's distance/,
  );
  assert.equal(
    perDiemAmountForDay("hours_threshold", { min_hours: 8, amount_for_hours: "60.0000" }, { hours: "9.0000" }),
    "60.0000",
  );
  assert.equal(
    perDiemAmountForDay("hours_threshold", { min_hours: 8, amount_for_hours: "60.0000" }, { hours: "7.5000" }),
    "0",
  );
  // 5 worked days of 75 pays 7: two extra days at the last daily amount.
  const week = ["75.0000", "75.0000", "75.0000", "75.0000", "75.0000"];
  assert.deepEqual(applyWeeklyRule(week, { worked_days: 5, paid_days: 7 }), [...week, "75.0000", "75.0000"]);
  assert.deepEqual(applyWeeklyRule(week.slice(0, 4), { worked_days: 5, paid_days: 7 }), week.slice(0, 4));
  assert.deepEqual(applyWeeklyRule(week, null), week);
});

test("comp rules: highest priority match wins; nothing matching is null, never a default", () => {
  const rules = [
    { id: "b", priority: 5, match: { department_id: "d1" } },
    { id: "a", priority: 10, match: { project_id: "p1" } },
    { id: "c", priority: 10, match: { project_id: "p1", classification_id: "cc1" } },
  ];
  const target = { projectId: "p1", classificationId: "cc1", departmentId: "d1" };
  // Same priority: the more specific rule does NOT auto-win — priority ties
  // break by id, so specificity must be expressed as priority. Both match;
  // 'a' < 'c' wins deterministically.
  assert.equal(pickCompRule(rules, target)?.id, "a");
  assert.equal(pickCompRule(rules, { projectId: "zzz" })?.id, undefined);
  assert.equal(compRuleMatches({ state_code: "CA" }, { stateCode: "CA" }), true);
  assert.equal(compRuleMatches({ state_code: "CA" }, { stateCode: "NY" }), false);
  assert.equal(compRuleMatches({}, { stateCode: "NY" }), true);
});

test("ratio: breach prices apprentice hours at journey; lone apprentice hours always breach", () => {
  // 1:1 — one apprentice hour against eight journey hours is within ratio.
  assert.deepEqual(evaluateRatio("8.0000", "1.0000", 1, 1), { breach: false, rateAtJourney: false });
  // 1:1 — two apprentice hours against one journey hour breaches.
  assert.deepEqual(evaluateRatio("1.0000", "2.0000", 1, 1), { breach: true, rateAtJourney: true });
  // 3:1 — three apprentice against nine journey is exactly within.
  assert.deepEqual(evaluateRatio("9.0000", "3.0000", 3, 1), { breach: false, rateAtJourney: false });
  // No journey hours with apprentice hours is a breach, never a pass.
  assert.deepEqual(evaluateRatio("0", "4.0000", 1, 1), { breach: true, rateAtJourney: true });
  // No apprentice hours is never a breach.
  assert.deepEqual(evaluateRatio("0", "0", 1, 1), { breach: false, rateAtJourney: false });
});
