import assert from "node:assert/strict";
import test from "node:test";
import { holidayEligibilityFromStoredFacts } from "./holiday-facts-store.ts";

const employee = "84a4d8a7-9090-4202-b59e-a7c89319770f";

test("a filed absence belongs only to its holiday occurrence", () => {
  const facts = holidayEligibilityFromStoredFacts({
    commissions: new Map(),
    assertions: new Map([[employee, new Map([["christmas|2025-12-25", false]])]]),
    entitledDays: new Map(),
  });
  assert.deepEqual(facts[employee], {
    absentWithoutConsentByHoliday: { "christmas|2025-12-25": false },
  });
  assert.equal(
    Object.hasOwn(facts[employee]!.absentWithoutConsentByHoliday!, "new_years_day|2026-01-01"),
    false,
  );
});

test("different stored absence decisions remain independent across holidays", () => {
  const facts = holidayEligibilityFromStoredFacts({
    commissions: new Map(),
    assertions: new Map([
      [
        employee,
        new Map([
          ["christmas|2025-12-25", true],
          ["new_years_day|2026-01-01", false],
        ]),
      ],
    ]),
    entitledDays: new Map(),
  });
  assert.deepEqual(facts[employee]?.absentWithoutConsentByHoliday, {
    "christmas|2025-12-25": true,
    "new_years_day|2026-01-01": false,
  });
});

test("unanswered commission status remains missing while a recorded false is an explicit answer", () => {
  assert.deepEqual(
    holidayEligibilityFromStoredFacts({
      commissions: new Map(),
      assertions: new Map(),
      entitledDays: new Map(),
    }),
    {},
  );
  assert.deepEqual(
    holidayEligibilityFromStoredFacts({
      commissions: new Map([[employee, false]]),
      assertions: new Map(),
      entitledDays: new Map(),
    }),
    { [employee]: { paidOnCommission: false } },
  );
});

test("audited complete day counts remain tied to their occurrence and employee", () => {
  const facts = holidayEligibilityFromStoredFacts({
    commissions: new Map([[employee, true]]),
    assertions: new Map(),
    entitledDays: new Map([[employee, new Map([["christmas|2025-12-25", 0]])]]),
  });
  assert.deepEqual(facts[employee], {
    paidOnCommission: true,
    entitledDayAttestations: { "christmas|2025-12-25": 0 },
  });
});
