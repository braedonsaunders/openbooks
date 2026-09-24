import assert from "node:assert/strict";
import test from "node:test";
import {
  ConstructionBillingError,
  computeApplication,
  createPayApplication,
  releaseRetainage,
  requireIsoDate,
  revisedScheduleValue,
  type AppLineInput,
} from "./construction-billing.ts";
import { db } from "../platform/db.ts";

const line = (over: Partial<AppLineInput>): AppLineInput => ({
  sovLineId: "l",
  scheduledValue: "10000",
  previousCompleted: "0",
  previousMaterialsStored: "0",
  thisPeriodCompleted: "0",
  materialsStored: "0",
  retainagePercent: "10",
  ...over,
});

test("withholds retainage on this period's gross and nets the current due", () => {
  const r = computeApplication([
    line({ sovLineId: "a", previousCompleted: "2000", thisPeriodCompleted: "3000" }),
  ]);
  assert.equal(r.lines[0]!.grossThisPeriod, "3000.0000");
  assert.equal(r.lines[0]!.retainageThisPeriod, "300.0000");
  assert.equal(r.lines[0]!.netThisPeriod, "2700.0000");
  assert.equal(r.lines[0]!.completedToDate, "5000.0000");
  assert.equal(r.lines[0]!.percentComplete, "50.00");
  assert.equal(r.grossThisPeriod, "3000.0000");
  assert.equal(r.retainageThisPeriod, "300.0000");
  assert.equal(r.currentDue, "2700.0000");
});

test("materials stored are billable and carry retainage too", () => {
  const r = computeApplication([
    line({ thisPeriodCompleted: "1000", materialsStored: "500", retainagePercent: "10" }),
  ]);
  assert.equal(r.grossThisPeriod, "1500.0000");
  assert.equal(r.retainageThisPeriod, "150.0000");
  assert.equal(r.currentDue, "1350.0000");
});

test("re-entering the stored balance bills only the increment", () => {
  // Application #2: the PM re-enters the same cumulative 500 stored balance, so
  // only this period's work bills — the stored materials are not billed twice.
  const r = computeApplication([
    line({ previousCompleted: "1500", previousMaterialsStored: "500", thisPeriodCompleted: "1000", materialsStored: "500" }),
  ]);
  assert.equal(r.lines[0]!.grossThisPeriod, "1000.0000");
  assert.equal(r.lines[0]!.retainageThisPeriod, "100.0000");
  assert.equal(r.lines[0]!.netThisPeriod, "900.0000");
  assert.equal(r.lines[0]!.completedToDate, "2500.0000");
  assert.equal(r.grossThisPeriod, "1000.0000");
  assert.equal(r.currentDue, "900.0000");
});

test("a rising stored balance bills only the delta", () => {
  const r = computeApplication([
    line({ previousCompleted: "2500", previousMaterialsStored: "500", thisPeriodCompleted: "0", materialsStored: "800" }),
  ]);
  assert.equal(r.lines[0]!.grossThisPeriod, "300.0000");
  assert.equal(r.lines[0]!.retainageThisPeriod, "30.0000");
  assert.equal(r.lines[0]!.completedToDate, "2800.0000");
  assert.equal(r.currentDue, "270.0000");
});

test("stored below the previously billed balance is rejected", () => {
  // Billed materials have left the site — a negative draw cannot express that.
  assert.throws(
    () => computeApplication([line({ previousMaterialsStored: "500", materialsStored: "400" })]),
    /credit or adjusting entry/,
  );
});

test("work-only path is byte-identical when nothing was stored before", () => {
  const r = computeApplication([
    line({ previousCompleted: "2000", previousMaterialsStored: "0", thisPeriodCompleted: "3000", materialsStored: "0" }),
  ]);
  assert.equal(r.lines[0]!.grossThisPeriod, "3000.0000");
  assert.equal(r.lines[0]!.retainageThisPeriod, "300.0000");
  assert.equal(r.lines[0]!.netThisPeriod, "2700.0000");
  assert.equal(r.lines[0]!.completedToDate, "5000.0000");
  assert.equal(r.currentDue, "2700.0000");
});

test("a zero-retainage line bills gross with nothing withheld", () => {
  const r = computeApplication([line({ thisPeriodCompleted: "4000", retainagePercent: "0" })]);
  assert.equal(r.retainageThisPeriod, "0.0000");
  assert.equal(r.currentDue, "4000.0000");
});

test("totals sum exactly across mixed lines (no drift)", () => {
  const r = computeApplication([
    line({ sovLineId: "a", thisPeriodCompleted: "3333.33", retainagePercent: "10" }),
    line({ sovLineId: "b", thisPeriodCompleted: "3333.33", retainagePercent: "5" }),
    line({ sovLineId: "c", thisPeriodCompleted: "3333.34", retainagePercent: "0" }),
  ]);
  // gross 10000.00; retainage = 333.333 + 166.6665 → rounded per line 333.3330 + 166.6665 = 499.9995
  assert.equal(r.grossThisPeriod, "10000.0000");
  assert.equal(r.retainageThisPeriod, "499.9995");
  assert.equal(r.currentDue, "9500.0005");
});

test("two-decimal settlement rounds the cumulative retained amount and carries the residual", () => {
  const r = computeApplication([
    line({ sovLineId: "a", thisPeriodCompleted: "3333.33", retainagePercent: "10" }),
    line({ sovLineId: "b", thisPeriodCompleted: "3333.33", retainagePercent: "5" }),
    line({ sovLineId: "c", thisPeriodCompleted: "3333.34", retainagePercent: "0" }),
  ], { minorUnits: 2 });
  // Exact line retainage 333.333 + 166.6665: line a settles 333.33, line b
  // absorbs the residual (166.67), line c settles nothing. The settled total
  // is the rounded cumulative amount exactly — no fractional cents.
  assert.equal(r.lines[0]!.retainageThisPeriod, "333.3300");
  assert.equal(r.lines[1]!.retainageThisPeriod, "166.6700");
  assert.equal(r.lines[2]!.retainageThisPeriod, "0.0000");
  assert.equal(r.grossThisPeriod, "10000.0000");
  assert.equal(r.retainageThisPeriod, "500.0000");
  assert.equal(r.currentDue, "9500.0000");
});

test("zero-decimal settlement keeps whole yen with the residual carried", () => {
  const r = computeApplication([
    line({ sovLineId: "a", thisPeriodCompleted: "333.33", retainagePercent: "10" }),
    line({ sovLineId: "b", thisPeriodCompleted: "333.33", retainagePercent: "10" }),
  ], { minorUnits: 0 });
  // Exact 33.333 + 33.333: cumulative 66.666 rounds to 67 whole yen.
  assert.equal(r.lines[0]!.retainageThisPeriod, "33.0000");
  assert.equal(r.lines[1]!.retainageThisPeriod, "34.0000");
  assert.equal(r.retainageThisPeriod, "67.0000");
  assert.equal(r.currentDue, "599.6600");
});

test("three-decimal settlement settles to fils with the residual carried", () => {
  const r = computeApplication([
    line({ sovLineId: "a", thisPeriodCompleted: "100.5555", retainagePercent: "10" }),
    line({ sovLineId: "b", thisPeriodCompleted: "100.5555", retainagePercent: "10" }),
  ], { minorUnits: 3 });
  // Exact 10.05555 + 10.05555: cumulative 20.1111 rounds to 20.111.
  assert.equal(r.lines[0]!.retainageThisPeriod, "10.0560");
  assert.equal(r.lines[1]!.retainageThisPeriod, "10.0550");
  assert.equal(r.retainageThisPeriod, "20.1110");
});

test("prior-draw replay carries the residual across draws", () => {
  const first = computeApplication(
    [line({ sovLineId: "a", thisPeriodCompleted: "333.33", retainagePercent: "10" })],
    { minorUnits: 2 },
  );
  assert.equal(first.retainageThisPeriod, "33.3300");
  const second = computeApplication(
    [line({ sovLineId: "a", previousCompleted: "333.33", thisPeriodCompleted: "333.33", retainagePercent: "10" })],
    { minorUnits: 2, priorExactRetainage: ["33.3333"] },
  );
  // Cumulative exact 66.6666 rounds to 66.67; 33.33 already settled, so this
  // draw withholds 33.34. Releases across both draws sum to 66.67 exactly.
  assert.equal(second.retainageThisPeriod, "33.3400");
  assert.equal(second.lines[0]!.completedToDate, "666.6600");
});

test("four minor units preserve exact ledger precision", () => {
  const r = computeApplication([
    line({ sovLineId: "a", thisPeriodCompleted: "3333.33", retainagePercent: "10" }),
  ], { minorUnits: 4 });
  assert.equal(r.retainageThisPeriod, "333.3330");
});

test("rejects overbilling beyond the schedule of values", () => {
  assert.throws(
    () => computeApplication([line({ scheduledValue: "10000", previousCompleted: "9000", thisPeriodCompleted: "1001" })]),
    /exceeds the scheduled value/,
  );
});

test("scheduled-value cap still bounds completedToDate with stored increments", () => {
  const args = { scheduledValue: "10000", previousCompleted: "9500", previousMaterialsStored: "500" };
  // Stored rising 500 → 600 adds only 100 to the draw: 9500 + 400 + 100 lands
  // exactly on the schedule and is allowed.
  const atCap = computeApplication([line({ ...args, thisPeriodCompleted: "400", materialsStored: "600" })]);
  assert.equal(atCap.lines[0]!.completedToDate, "10000.0000");
  assert.equal(atCap.lines[0]!.grossThisPeriod, "500.0000");
  // One cent past the cap is refused.
  assert.throws(
    () => computeApplication([line({ ...args, thisPeriodCompleted: "400.01", materialsStored: "600" })]),
    /exceeds the scheduled value/,
  );
});

test("rejects negative application amounts and invalid retainage", () => {
  assert.throws(() => computeApplication([line({ thisPeriodCompleted: "-1" })]), /cannot be negative/);
  assert.throws(() => computeApplication([line({ thisPeriodCompleted: "1", retainagePercent: "101" })]), /between 0 and 100/);
});

test("change orders revise an SOV line exactly without binary rounding", () => {
  assert.equal(revisedScheduleValue("100000.1000", "1250.2555", "40000.0000"), "101250.3555");
  assert.equal(revisedScheduleValue("100000.1000", "-1250.2555", "40000.0000"), "98749.8445");
});

test("deductive change orders cannot reduce below already-billed work", () => {
  assert.throws(
    () => revisedScheduleValue("100000.0000", "-60000.0001", "40000.0000"),
    ConstructionBillingError,
  );
  assert.equal(revisedScheduleValue("100000.0000", "-60000.0000", "40000.0000"), "40000.0000");
});

test("createPayApplication rejects a period before the previous invoiced Date", async (t) => {
  const projectId = "project-1";
  // Lead responses mirror the transaction's query order: the feature-gate
  // fence (advisory lock), the fenced Projects recheck, then the procedure
  // check and the application writes.
  const responses = [
    { rows: [] },
    { rows: [{ features: { projects: true } }] },
    { rows: [{ supported: true }] },
    { rows: [{ id: projectId }] },
    { rows: [{ has_open: false, last_period: new Date("2026-07-31T00:00:00.000Z") }] },
    { rows: [{ id: "sov-1", scheduled_value: "1000" }] },
    { rows: [{ n: 1 }] },
    { rows: [{ id: "app-1" }] },
    { rows: [{ prev: "0", prev_stored: "0" }] },
    { rows: [] },
    { rows: [] },
  ];
  let responseIndex = 0;
  const tx = {
    execute: async () => responses[responseIndex++] ?? { rows: [] },
  };
  const transactionDb = db as unknown as {
    transaction(callback: (transaction: typeof tx) => Promise<unknown>): Promise<unknown>;
  };
  t.mock.method(
    transactionDb,
    "transaction",
    async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  );

  await assert.rejects(
    createPayApplication("org-1", "user-1", projectId, "2026-07-30", "10", null),
    /period ending must be after the previous invoiced application/,
  );

  responseIndex = 0;
  assert.deepEqual(
    await createPayApplication("org-1", "user-1", projectId, "2026-08-01", "10", null),
    { id: "app-1", applicationNumber: 1 },
  );
});

/** Flatten a drizzle SQL chunk into raw text for lock-keyword assertions. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      if ((chunk as { queryChunks?: unknown[] })?.queryChunks) return sqlText(chunk);
      return "";
    })
    .join("");
}

test("createPayApplication takes the feature-gate fence and rechecks Projects under a shared row lock", async (t) => {
  const seen: string[] = [];
  const tx = {
    execute: async (query: unknown) => {
      seen.push(sqlText(query));
      return { rows: [{ features: { projects: false } }] };
    },
  };
  const transactionDb = db as unknown as {
    transaction(callback: (transaction: typeof tx) => Promise<unknown>): Promise<unknown>;
  };
  t.mock.method(
    transactionDb,
    "transaction",
    async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  );

  // The refusal names the gate. A concurrent disable commits first, so the
  // new application must be refused, never committed hidden behind the gate.
  await assert.rejects(
    createPayApplication("org-1", "user-1", "project-1", "2026-08-31", "10", null),
    (error: unknown) =>
      error instanceof ConstructionBillingError && error.message === "Projects feature is disabled",
  );
  // Refused before any other database work: the advisory fence first (it
  // serializes this creator against the disable path's blocker checks),
  // then the fenced gate read under a shared org-row lock (which serializes
  // against the disable path's exclusive row lock).
  assert.equal(seen.length, 2);
  assert.match(seen[0]!, /pg_advisory_xact_lock/);
  assert.match(seen[1]!, /from orgs/);
  assert.match(seen[1]!, /for share/);
});

test("createPayApplication proceeds past an enabled gate to the procedure check", async (t) => {
  let calls = 0;
  const tx = {
    execute: async (_query: unknown) => {
      calls += 1;
      if (calls === 1) return { rows: [] };
      if (calls === 2) return { rows: [{ features: { projects: true } }] };
      throw new Error("beyond-gate");
    },
  };
  const transactionDb = db as unknown as {
    transaction(callback: (transaction: typeof tx) => Promise<unknown>): Promise<unknown>;
  };
  t.mock.method(
    transactionDb,
    "transaction",
    async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  );

  // An enabled gate must not refuse: the flow continues to the next check.
  await assert.rejects(createPayApplication("org-1", "user-1", "project-1", "2026-08-31", "10", null), /beyond-gate/);
});

test("period-ending dates are validated as calendar days before any database work", async (t) => {
  const transactionDb = db as unknown as { transaction(callback: unknown): Promise<unknown> };
  t.mock.method(transactionDb, "transaction", async () => {
    throw new Error("database work must not start for an invalid date");
  });
  const isDateError = (error: unknown) =>
    error instanceof ConstructionBillingError && /valid calendar date/.test(error.message);
  for (const bad of ["undefined", "", "2026-02-30", "07/31/2026", "2026-7-1", "2026-07-01T00:00:00Z"]) {
    await assert.rejects(releaseRetainage("org-1", "user-1", "project-1", bad, "100", null), isDateError, `releaseRetainage(${bad})`);
    await assert.rejects(createPayApplication("org-1", "user-1", "project-1", bad, "10", null), isDateError, `createPayApplication(${bad})`);
  }
  assert.equal(requireIsoDate("2026-07-31", "Period ending"), "2026-07-31");
});

test("retainage math uses the validated percent, refusing garbage with the domain error", () => {
  // A blank percent normalizes to zero through the same boundary as every
  // other line amount — previously the raw blank reached cmp and threw a
  // bare Error outside the domain.
  const blank = computeApplication([line({ thisPeriodCompleted: "1000", retainagePercent: "" })]);
  assert.equal(blank.lines[0]!.retainageThisPeriod, "0.0000");
  assert.equal(blank.currentDue, "1000.0000");
  // Garbage is refused as ConstructionBillingError, never a bare Error.
  assert.throws(
    () => computeApplication([line({ thisPeriodCompleted: "1000", retainagePercent: "abc" })]),
    ConstructionBillingError,
  );
  assert.throws(
    () => computeApplication([line({ thisPeriodCompleted: "1000", retainagePercent: "abc" })]),
    /retainage percent must be an exact decimal/,
  );
  // Out-of-range input is still refused by name.
  assert.throws(
    () => computeApplication([line({ thisPeriodCompleted: "1000", retainagePercent: "101" })]),
    /between 0 and 100/,
  );
});
