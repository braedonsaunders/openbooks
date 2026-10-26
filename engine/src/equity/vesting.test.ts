import assert from "node:assert/strict";
import test from "node:test";
import { EquityError } from "./errors.ts";
import {
  acceleratedVested,
  completedMonths,
  finalVestingDate,
  parseVestingTranches,
  scheduledVested,
  validateVestingTerms,
  vestingInstallments,
  type VestingTerms,
} from "./vesting.ts";

function terms(overrides: Partial<VestingTerms> = {}): VestingTerms {
  return {
    issueDate: "2024-01-15",
    quantity: 4800n,
    vestingStart: "2024-01-15",
    vestingMonths: 48,
    cliffMonths: 12,
    vestingFrequency: "monthly",
    vestingTranches: null,
    ...overrides,
  };
}

test("completed months count anniversaries, clamping to short months", () => {
  assert.equal(completedMonths("2024-01-15", "2024-02-14"), 0);
  assert.equal(completedMonths("2024-01-15", "2024-02-15"), 1);
  assert.equal(completedMonths("2024-01-31", "2024-02-29"), 1);
  assert.equal(completedMonths("2024-01-31", "2024-02-28"), 0);
  assert.equal(completedMonths("2024-02-29", "2025-02-28"), 12);
  assert.equal(completedMonths("2024-03-01", "2024-01-01"), 0);
});

test("a four-year monthly schedule vests nothing before the cliff, the catch-up on it, then monthly steps", () => {
  const schedule = terms();
  assert.equal(scheduledVested(schedule, "2024-01-14"), 0n);
  assert.equal(scheduledVested(schedule, "2025-01-14"), 0n);
  assert.equal(scheduledVested(schedule, "2025-01-15"), 1200n);
  assert.equal(scheduledVested(schedule, "2025-02-15"), 1300n);
  assert.equal(scheduledVested(schedule, "2028-01-14"), 4700n);
  assert.equal(scheduledVested(schedule, "2028-01-15"), 4800n);
  assert.equal(scheduledVested(schedule, "2040-01-01"), 4800n);
});

test("installments land on each step and sum to the quantity", () => {
  const installments = vestingInstallments(terms({ quantity: 1000n }));
  assert.equal(installments.length, 37);
  assert.deepEqual(installments[0], { date: "2025-01-15", quantity: 250n, cumulative: 250n });
  assert.equal(
    installments.reduce((sum, item) => sum + item.quantity, 0n),
    1000n,
  );
  assert.equal(installments.at(-1)!.date, "2028-01-15");
  for (const installment of installments)
    assert.equal(
      scheduledVested(terms({ quantity: 1000n }), installment.date),
      installment.cumulative,
    );
  assert.equal(finalVestingDate(terms()), "2028-01-15");
});

test("quarterly steps keep the full cliff catch-up and then step every three months", () => {
  const schedule = terms({ vestingFrequency: "quarterly" });
  assert.equal(scheduledVested(schedule, "2025-01-15"), 1200n);
  assert.equal(scheduledVested(schedule, "2025-03-15"), 1200n);
  assert.equal(scheduledVested(schedule, "2025-04-15"), 1500n);
});

test("a cliff between steps vests its whole catch-up on the cliff date", () => {
  const schedule = terms({
    quantity: 1200n,
    vestingMonths: 12,
    cliffMonths: 4,
    vestingFrequency: "quarterly",
  });
  assert.equal(scheduledVested(schedule, "2024-05-15"), 400n);
  assert.equal(scheduledVested(schedule, "2024-06-15"), 400n);
  assert.equal(scheduledVested(schedule, "2024-07-15"), 600n);
});

test("dated tranches vest on their dates", () => {
  const schedule = terms({
    quantity: 300n,
    vestingMonths: null,
    cliffMonths: null,
    vestingFrequency: null,
    vestingTranches: [
      { date: "2024-06-30", quantity: 100n },
      { date: "2025-06-30", quantity: 200n },
    ],
  });
  validateVestingTerms(schedule);
  assert.equal(scheduledVested(schedule, "2024-06-29"), 0n);
  assert.equal(scheduledVested(schedule, "2024-06-30"), 100n);
  assert.equal(scheduledVested(schedule, "2026-01-01"), 300n);
});

test("no schedule means fully vested from the issue date", () => {
  const schedule = terms({
    vestingMonths: null,
    cliffMonths: null,
    vestingFrequency: null,
    vestingStart: null,
  });
  assert.equal(scheduledVested(schedule, "2024-01-14"), 0n);
  assert.equal(scheduledVested(schedule, "2024-01-15"), 4800n);
  assert.deepEqual(vestingInstallments(schedule), [
    { date: "2024-01-15", quantity: 4800n, cumulative: 4800n },
  ]);
});

test("schedules the math cannot honour refuse by name", () => {
  const refuses = (overrides: Partial<VestingTerms>) =>
    assert.throws(
      () => validateVestingTerms(terms(overrides)),
      (error: unknown) => error instanceof EquityError && error.code === "equity_vesting_invalid",
    );
  refuses({ cliffMonths: 60 });
  refuses({ vestingFrequency: null });
  refuses({ vestingStart: null });
  refuses({
    vestingMonths: null,
    cliffMonths: null,
    vestingFrequency: null,
    vestingTranches: [{ date: "2024-06-30", quantity: 100n }],
  });
  refuses({
    quantity: 300n,
    vestingMonths: null,
    cliffMonths: null,
    vestingFrequency: null,
    vestingTranches: [
      { date: "2025-06-30", quantity: 200n },
      { date: "2024-06-30", quantity: 100n },
    ],
  });
  assert.throws(() => parseVestingTranches([{ date: "2024-02-30", quantity: "10" }]), EquityError);
  assert.throws(() => parseVestingTranches([{ date: "2024-02-03", quantity: "1.5" }]), EquityError);
  assert.deepEqual(parseVestingTranches([{ date: "2024-02-03", quantity: "10" }]), [
    { date: "2024-02-03", quantity: 10n },
  ]);
});

test("acceleration fires only on its trigger and vests a share of the unvested remainder", () => {
  const single = { acceleration: "single" as const, accelerationPercent: "50" };
  const double = { acceleration: "double" as const, accelerationPercent: "100" };
  assert.equal(
    acceleratedVested(1200n, 4800n, single, { changeOfControl: false, terminated: false }),
    1200n,
  );
  assert.equal(
    acceleratedVested(1200n, 4800n, single, { changeOfControl: true, terminated: false }),
    3000n,
  );
  assert.equal(
    acceleratedVested(1200n, 4800n, double, { changeOfControl: true, terminated: false }),
    1200n,
  );
  assert.equal(
    acceleratedVested(1200n, 4800n, double, { changeOfControl: true, terminated: true }),
    4800n,
  );
  assert.equal(
    acceleratedVested(
      1201n,
      4800n,
      { acceleration: "single", accelerationPercent: "33.3333" },
      { changeOfControl: true, terminated: false },
    ),
    2400n,
  );
});
