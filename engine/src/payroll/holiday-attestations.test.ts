import assert from "node:assert/strict";
import test from "node:test";
import { mergeHolidayEligibility, type DemandingHoliday } from "./holiday-attestations.ts";

const holiday = (key: string, date: string, name: string): DemandingHoliday => ({
  key, date, name, jurisdiction: "CA-AB",
  needsCommissionStatus: false, needsAbsenceAssertion: true,
  needsEntitlementDayAssessment: false, needsOccupationClass: false,
});

test("an absence answer filed for one holiday reaches that holiday while another is still unanswered", () => {
  const employee = "84a4d8a7-9090-4202-b59e-a7c89319770f";
  const merged = mergeHolidayEligibility(undefined, {
    commissions: new Map(),
    assertions: new Map([[employee, new Map([["christmas|2025-12-25", false]])]]),
    entitledDays: new Map(),
  }, new Map([[employee, [holiday("christmas", "2025-12-25", "Christmas Day"), holiday("new_years_day", "2026-01-01", "New Year's Day")]]]));
  assert.deepEqual(merged[employee]?.absentWithoutConsentByHoliday, { "christmas|2025-12-25": false });
  assert.equal(merged[employee]?.absentWithoutConsent, undefined, "the unanswered holiday still has no employee-wide answer");
});

test("answers filed for every demanding holiday also settle the employee-wide answer when they agree", () => {
  const employee = "84a4d8a7-9090-4202-b59e-a7c89319770f";
  const merged = mergeHolidayEligibility(undefined, {
    commissions: new Map(),
    assertions: new Map([[employee, new Map([["christmas|2025-12-25", false], ["new_years_day|2026-01-01", false]])]]),
    entitledDays: new Map(),
  }, new Map([[employee, [holiday("christmas", "2025-12-25", "Christmas Day"), holiday("new_years_day", "2026-01-01", "New Year's Day")]]]));
  assert.equal(merged[employee]?.absentWithoutConsent, false);
});

test("an explicit employee-wide absence answer overrides previously filed occurrence answers", () => {
  const employee = "84a4d8a7-9090-4202-b59e-a7c89319770f";
  const merged = mergeHolidayEligibility({ [employee]: { absentWithoutConsent: false } }, {
    commissions: new Map(),
    assertions: new Map([[employee, new Map([["christmas|2025-12-25", true]])]]),
    entitledDays: new Map(),
  }, new Map([[employee, [holiday("christmas", "2025-12-25", "Christmas Day")]]]));
  assert.equal(merged[employee]?.absentWithoutConsent, false);
  assert.equal(merged[employee]?.absentWithoutConsentByHoliday, undefined);
});

test("an explicit occurrence answer overrides its stored answer and preserves other occurrences", () => {
  const employee = "84a4d8a7-9090-4202-b59e-a7c89319770f";
  const merged = mergeHolidayEligibility({
    [employee]: { absentWithoutConsentByHoliday: { "christmas|2025-12-25": false } },
  }, {
    commissions: new Map(),
    assertions: new Map([[employee, new Map([["christmas|2025-12-25", true], ["new_years_day|2026-01-01", true]])]]),
    entitledDays: new Map(),
  }, new Map([[employee, [holiday("christmas", "2025-12-25", "Christmas Day"), holiday("new_years_day", "2026-01-01", "New Year's Day")]]]));
  assert.deepEqual(merged[employee]?.absentWithoutConsentByHoliday, {
    "christmas|2025-12-25": false, "new_years_day|2026-01-01": true,
  });
});
