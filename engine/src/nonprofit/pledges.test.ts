import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPledgeDiscountSchedule,
  presentValueOfPledgeStream,
} from "./pledges.ts";
import {
  periodRateFromAnnualPercent,
  presentValueOfLevelStream,
} from "../money/present-value.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { civilDateFromParts } from "../platform/civil-date.ts";

function dueDate(bookedOn: string, periods: number): string {
  const year = Number(bookedOn.slice(0, 4));
  const month = Number(bookedOn.slice(5, 7));
  return civilDateFromParts(year, month + periods, 15);
}

test("five-year pledge PV and amortization close exactly to the promised cash flows", () => {
  const bookedOn = "2026-01-15";
  const monthly = Array.from({ length: 60 }, () => ({ dueOn: "", amount: "100.0000" }));
  const installments = monthly.map((row, index) => ({
    ...row,
    dueOn: dueDate(bookedOn, index + 1),
  }));
  const rate = periodRateFromAnnualPercent("5", 12);
  const presentValue = presentValueOfPledgeStream({
    bookedOn,
    discountRate: "5",
    installments,
  });
  assert.equal(
    presentValue,
    presentValueOfLevelStream({
      payment: "100.0000",
      periods: 60,
      rate,
      timing: "arrears",
    }),
  );
  assert.ok(toUnits(presentValue) < 60_000_000n);

  const schedule = buildPledgeDiscountSchedule({
    bookedOn,
    presentValue,
    discountRate: "5",
    installments,
  });
  assert.equal(schedule.length, 60);
  assert.equal(schedule[0]?.scheduledCollection, "100.0000");
  assert.equal(schedule[59]?.closingCarryingAmount, "0.0000");
  const amortized = schedule.reduce((sum, row) => sum + toUnits(row.discountAmortization), 0n);
  assert.equal(amortized, 60000000n - toUnits(presentValue));
});

test("uneven pledge installments retain exact decimal PV and a zero closing balance", () => {
  const bookedOn = "2026-01-15";
  const installments = [
    { dueOn: "2027-01-15", amount: "1250.0000" },
    { dueOn: "2028-01-15", amount: "1750.0000" },
    { dueOn: "2029-01-15", amount: "2000.0000" },
  ];
  const presentValue = presentValueOfPledgeStream({
    bookedOn,
    discountRate: "4.75",
    installments,
  });
  const schedule = buildPledgeDiscountSchedule({
    bookedOn,
    presentValue,
    discountRate: "4.75",
    installments,
  });
  assert.ok(toUnits(presentValue) > 0n);
  assert.ok(toUnits(presentValue) < 50000000n);
  assert.equal(schedule.at(-1)?.closingCarryingAmount, "0.0000");
  assert.equal(
    schedule.reduce((sum, row) => sum + toUnits(row.discountAmortization), 0n),
    50000000n - toUnits(presentValue),
  );
  assert.equal(fromUnits(toUnits(presentValue)), presentValue);
});
