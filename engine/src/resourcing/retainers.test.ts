import assert from "node:assert/strict";
import test from "node:test";
import { ResourcingRefusal } from "./errors.ts";
import {
  assertDrawdownWithinBalance,
  assertRetainerCanClose,
  balanceOf,
  nextRetainerState,
  priceHoursDrawdown,
} from "./retainers.ts";

test("a week straddling month-end allocates cents across entries and months", () => {
  const priced = priceHoursDrawdown([
    { id: "may-entry", workedOn: "2026-05-31", hours: "2.5000" },
    { id: "june-entry-one", workedOn: "2026-06-01", hours: "3.2500" },
    { id: "june-entry-two", workedOn: "2026-06-02", hours: "1.3333" },
  ], "137.50");

  assert.deepEqual(priced.byEntry.map(({ amount }) => amount), ["343.7500", "446.8700", "183.3300"]);
  assert.deepEqual(priced.byMonth, { "2026-05": "343.7500", "2026-06": "630.2000" });
  assert.equal(priced.total, "973.9500");
  assert.equal(priced.hours, "7.0833");
});

test("an overdraw refuses with the available time-and-materials remedy", () => {
  assert.throws(
    () => assertDrawdownWithinBalance("125.0000", "100.0000", "hours"),
    (error: unknown) => {
      assert.ok(error instanceof ResourcingRefusal);
      assert.equal(error.status, 409);
      assert.equal(error.code, "retainer_overdraw");
      assert.equal(error.remedy, "bill the excess hours as time and materials");
      return true;
    },
  );
  assert.throws(
    () => assertDrawdownWithinBalance("125.0000", "100.0000", "fees"),
    (error: unknown) => {
      assert.ok(error instanceof ResourcingRefusal);
      assert.equal(error.remedy, "reduce the milestone drawdown to the remaining balance");
      return true;
    },
  );
});

test("a retainer with an outstanding balance cannot close", () => {
  assert.throws(
    () => assertRetainerCanClose("0.0100"),
    (error: unknown) => {
      assert.ok(error instanceof ResourcingRefusal);
      assert.equal(error.status, 409);
      assert.equal(error.code, "retainer_balance_remaining");
      assert.equal(error.remedy, "draw down the remaining balance or extend the retainer");
      return true;
    },
  );
  assert.deepEqual(balanceOf({ totalAmount: "10.0000", currency: "CAD" }, [{ amount: "10.0000" }]), { amount: "0.0000", currency: "CAD" });
});

test("active retainers exhaust at zero and expire after their end date", () => {
  const active = { state: "active" as const, endsOn: "2026-03-31" };
  assert.equal(nextRetainerState(active, "0.0000", "2026-03-01"), "exhausted");
  assert.equal(nextRetainerState(active, "10.0000", "2026-04-01"), "expired");
  assert.equal(nextRetainerState(active, "10.0000", "2026-03-31"), "active");
  assert.equal(nextRetainerState({ state: "expired", endsOn: active.endsOn }, "10.0000", "2026-04-01"), "expired");
});
