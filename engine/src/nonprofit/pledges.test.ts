import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPledgeDiscountSchedule,
  pledgeCarryingAmount,
  pledgeDiscountAmortizationForMonth,
  pledgeWriteOffDiscount,
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

test("a written-off pledge amortizes only its collectible balance and stops at maturity", () => {
  const bookedOn = "2026-07-15";
  const installments = [2027, 2028, 2029, 2030, 2031].map((year) => ({ dueOn: `${year}-07-15`, amount: "1000.0000" }));
  const presentValue = presentValueOfPledgeStream({ bookedOn, discountRate: "5", installments });
  const discount = 5000_0000n - toUnits(presentValue);
  const state = { amortized: 0n, collected: 0n, writtenOff: 0n, discountWrittenOff: 0n };
  const position = () => ({
    totalAmount: "5000.0000", presentValue, amortized: fromUnits(state.amortized),
    collected: fromUnits(state.collected), writtenOff: fromUnits(state.writtenOff),
    discountWrittenOff: fromUnits(state.discountWrittenOff),
  });
  const settled = new Set<string>();
  const afterMaturity: bigint[] = [];
  for (let offset = 1; offset <= 72; offset += 1) {
    const month = civilDateFromParts(2026, 7 + offset, 1).slice(0, 7);
    const opening = position();
    // The donor withdraws installment 3 a year before it falls due; installment 5 is never paid.
    if (month === "2028-08") {
      const writeOff = pledgeWriteOffDiscount({
        discountRate: "5", writeOffDate: "2028-08-20",
        unamortizedDiscount: fromUnits(pledgeCarryingAmount(position()).unamortizedDiscount),
        installments: installments.filter((row) => !settled.has(row.dueOn)).map((row) => ({
          dueOn: row.dueOn, outstanding: row.amount, writtenOff: row.dueOn === "2029-07-15" ? row.amount : "0.0000",
        })),
      });
      assert.ok(toUnits(writeOff) > 0n && toUnits(writeOff) < 1000_0000n);
      state.writtenOff += 1000_0000n;
      state.discountWrittenOff += toUnits(writeOff);
      settled.add("2029-07-15");
    }
    for (const row of installments) {
      if (row.dueOn.slice(0, 7) === month && !settled.has(row.dueOn) && row.dueOn !== "2031-07-15") {
        state.collected += toUnits(row.amount);
        settled.add(row.dueOn);
      }
    }
    const amount = toUnits(pledgeDiscountAmortizationForMonth({
      discountRate: "5", month, finalDueMonth: "2031-07", opening, closing: position(),
    }));
    assert.ok(amount >= 0n, `${month} must not reverse accretion`);
    state.amortized += amount;
    if (month > "2031-07") afterMaturity.push(amount);
  }
  assert.equal(state.amortized + state.discountWrittenOff, discount,
    "accretion plus discount written off must equal the booked discount exactly");
  assert.ok(afterMaturity.length > 0 && afterMaturity.every((amount) => amount === 0n),
    "no accretion is posted after maturity, even with an installment still unpaid");
  assert.deepEqual(pledgeCarryingAmount(position()), { outstanding: 1000_0000n, unamortizedDiscount: 0n, carrying: 1000_0000n });
  assert.equal(pledgeWriteOffDiscount({ discountRate: "5", writeOffDate: "2027-01-15", unamortizedDiscount: "12.3456",
    installments: [{ dueOn: "2028-07-15", outstanding: "1000.0000", writtenOff: "1000.0000" }] }), "12.3456",
  "writing off everything outstanding derecognizes the whole remaining discount");
});
