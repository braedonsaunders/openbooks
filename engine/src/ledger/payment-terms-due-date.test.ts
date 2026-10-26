import assert from "node:assert/strict";
import test from "node:test";
import {
  paymentTermsDueDate,
  PaymentTermsDueDateError,
  paymentTermsDueRuleRefusal,
} from "./payment-terms-due-date.ts";

const net = (netDays: number) => ({ netDays, dueDayOfMonth: null });
const onDay = (dueDayOfMonth: number, netDays = 0) => ({ netDays, dueDayOfMonth });

test("net days count calendar days from the document date across month and year ends", () => {
  assert.equal(paymentTermsDueDate("2026-07-20", net(0)), "2026-07-20");
  assert.equal(paymentTermsDueDate("2026-07-20", net(15)), "2026-08-04");
  assert.equal(paymentTermsDueDate("2026-12-20", net(30)), "2027-01-19");
  assert.equal(paymentTermsDueDate("2028-02-15", net(15)), "2028-03-01");
});

test("a due day of month falls on the first such day after the document date", () => {
  // Net 1st following: always the next month's first day.
  assert.equal(paymentTermsDueDate("2026-10-22", onDay(1)), "2026-11-01");
  assert.equal(paymentTermsDueDate("2026-10-01", onDay(1)), "2026-11-01");
  assert.equal(paymentTermsDueDate("2026-10-31", onDay(1)), "2026-11-01");
  // A document dated before the due day is due that same month.
  assert.equal(paymentTermsDueDate("2026-10-05", onDay(10)), "2026-10-10");
  // A document dated on the due day is due the following month.
  assert.equal(paymentTermsDueDate("2026-10-10", onDay(10)), "2026-11-10");
});

test("net days on a due day of month move documents dated within that window to a later month", () => {
  // Net 30, 1st following.
  assert.equal(paymentTermsDueDate("2026-10-22", onDay(1, 30)), "2026-12-01");
  assert.equal(paymentTermsDueDate("2026-10-01", onDay(1, 30)), "2026-11-01");
  assert.equal(paymentTermsDueDate("2026-10-02", onDay(1, 30)), "2026-12-01");
  // Day 15 with a 30-day window: dated 16 May through 14 June is due 15 July;
  // dated 15 June through 15 July is due 15 August.
  assert.equal(paymentTermsDueDate("2026-05-16", onDay(15, 30)), "2026-07-15");
  assert.equal(paymentTermsDueDate("2026-06-14", onDay(15, 30)), "2026-07-15");
  assert.equal(paymentTermsDueDate("2026-06-15", onDay(15, 30)), "2026-08-15");
  assert.equal(paymentTermsDueDate("2026-07-15", onDay(15, 30)), "2026-08-15");
  // Day 30 with a 5-day window: dated the 25th through the 30th is due next month's 30th.
  assert.equal(paymentTermsDueDate("2026-10-24", onDay(30, 5)), "2026-10-30");
  assert.equal(paymentTermsDueDate("2026-10-25", onDay(30, 5)), "2026-11-30");
  assert.equal(paymentTermsDueDate("2026-10-30", onDay(30, 5)), "2026-11-30");
});

test("a due day past the end of a short month falls on its last day", () => {
  assert.equal(paymentTermsDueDate("2026-01-31", onDay(31)), "2026-02-28");
  assert.equal(paymentTermsDueDate("2026-02-10", onDay(30)), "2026-02-28");
  assert.equal(paymentTermsDueDate("2026-04-05", onDay(31)), "2026-04-30");
  assert.equal(paymentTermsDueDate("2026-02-28", onDay(31)), "2026-03-31");
  // Month end with a 31-day window skips a month for documents dated late in it.
  assert.equal(paymentTermsDueDate("2026-01-31", onDay(31, 31)), "2026-03-31");
});

test("leap years give February its 29th", () => {
  assert.equal(paymentTermsDueDate("2028-02-10", onDay(31)), "2028-02-29");
  assert.equal(paymentTermsDueDate("2028-01-30", onDay(29)), "2028-02-29");
  assert.equal(paymentTermsDueDate("2028-02-29", onDay(29)), "2028-03-29");
  assert.equal(paymentTermsDueDate("2100-02-10", onDay(29)), "2100-02-28");
  assert.equal(paymentTermsDueDate("2000-02-10", onDay(29)), "2000-02-29");
});

test("December documents fall due in the new year", () => {
  assert.equal(paymentTermsDueDate("2026-12-15", onDay(1)), "2027-01-01");
  assert.equal(paymentTermsDueDate("2026-12-31", onDay(31)), "2027-01-31");
  assert.equal(paymentTermsDueDate("2026-12-05", onDay(10, 30)), "2027-01-10");
  assert.equal(paymentTermsDueDate("2026-12-22", onDay(1, 30)), "2027-02-01");
});

test("terms the calculator cannot apply refuse with the setup remedy", () => {
  for (const rule of [
    net(-1),
    net(1.5),
    net(Number.NaN),
    onDay(0),
    onDay(32),
    onDay(1.5),
    onDay(15, -2),
  ]) {
    assert.match(paymentTermsDueRuleRefusal(rule) ?? "", /Setup → Payment terms/);
    assert.throws(
      () => paymentTermsDueDate("2026-07-20", rule),
      (error: unknown) =>
        error instanceof PaymentTermsDueDateError && /Setup → Payment terms/.test(error.message),
    );
  }
  assert.equal(paymentTermsDueRuleRefusal({ netDays: "30", dueDayOfMonth: null }) !== null, true);
  assert.equal(paymentTermsDueRuleRefusal(onDay(31, 30)), null);
  assert.throws(() => paymentTermsDueDate("2026-02-30", net(15)), PaymentTermsDueDateError);
  assert.throws(
    () => paymentTermsDueDate("9999-12-20", onDay(1)),
    (error: unknown) =>
      error instanceof PaymentTermsDueDateError && /supported calendar/.test(error.message),
  );
});
