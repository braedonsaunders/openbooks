import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

/**
 * No payment history is not 45 days. Items from a party with no history
 * (and no global history) forecast at their due date — the contractual
 * date, a fact — and items with neither history nor a due date sit in no
 * week at all, counted with their total instead of invented into one.
 * The overdue push ladder and the sigma buffer come from the organization's
 * forecast-model knobs, never bare constants.
 */
test("history-less items forecast at their due date; dateless ones stay unplaced and counted", () => {
  // core.ts is server-only in production, so run the behavior check under
  // React's server condition (the same pattern used by core.test.ts). Only
  // the pure prediction runs here — no database, no clock.
  const source = `
    import assert from "node:assert/strict";
    import { forecastModelParams, predict, scheduleForecast } from "./web/lib/cash/core.ts";

    const asOf = new Date("2026-09-01T00:00:00Z");
    const start = new Date("2026-08-30T00:00:00Z");
    const end = new Date("2026-12-31T00:00:00Z");
    const noHistory = { map: new Map(), globalAvg: null };

    const dated = {
      id: "l-dated", entryId: "e1", docKind: "customer_invoice", docNumber: "INV-900",
      docId: "d1", partyId: "p-new", partyName: "New Customer",
      tranDate: new Date("2026-08-01T00:00:00Z"), dueDate: new Date("2026-09-15T00:00:00Z"),
      remaining: "400.0000",
    };
    // A future due date past the global-average prediction floors there: the
    // contractual date wins over the statistical one.
    const withGlobal = predict(dated, asOf, { map: new Map(), globalAvg: 30 });
    assert.equal(withGlobal?.method, "Due date");
    assert.equal(withGlobal?.date.toISOString().slice(0, 10), "2026-09-15");

    // With no history anywhere, the same item still forecasts — at its due
    // date, never at an invented 45-day average.
    const withoutGlobal = predict(dated, asOf, noHistory);
    assert.equal(withoutGlobal?.method, "Due date");
    assert.equal(withoutGlobal?.date.toISOString().slice(0, 10), "2026-09-15");

    // Neither history nor a due date: unplaceable. Two distinct items count
    // twice and total exactly, and neither enters any week or the scheduled
    // sum.
    const datelessA = { ...dated, id: "l-undated-a", partyId: "p-ghost-a", partyName: "Ghost A", dueDate: null, remaining: "100.0000" };
    const datelessB = { ...dated, id: "l-undated-b", partyId: "p-ghost-b", partyName: "Ghost B", dueDate: null, remaining: "250.5000" };
    assert.equal(predict(datelessA, asOf, noHistory), null);
    const scheduled = scheduleForecast([dated, datelessA, datelessB], noHistory, asOf, start, end);
    assert.equal(scheduled.unplaced.count, 2);
    assert.equal(scheduled.unplaced.total, "350.5000");
    assert.equal(scheduled.entries.length, 1);
    assert.equal(scheduled.scheduled, "400.0000");
    assert.ok(![...scheduled.byWeek.values()].flat().some((e) => e.id !== "l-dated"));

    // The overdue push ladder is the organization's, not a bare constant: 87
    // days overdue pushes 28 by default, but 7 when the mid threshold is 100.
    const stale = {
      id: "l-stale", entryId: "e2", docKind: "vendor_bill", docNumber: "BILL-11",
      docId: "d2", partyId: "p-old", partyName: "Old Vendor",
      tranDate: new Date("2026-06-01T00:00:00Z"), dueDate: new Date("2026-06-10T00:00:00Z"),
      remaining: "700.0000",
    };
    const stats = { map: new Map(), globalAvg: 5 };
    const pushed = predict(stale, asOf, stats);
    assert.equal(pushed?.method, "Overdue push");
    assert.equal(pushed?.date.toISOString().slice(0, 10), "2026-09-29");
    const gentle = predict(stale, asOf, stats, {
      settleBufferSigma: 0.5,
      overduePushShortDays: 7, overduePushMidDays: 14, overduePushLongDays: 28,
      overdueMidThresholdDays: 100, overdueLongThresholdDays: 200,
      cardTrajectoryTolerance: 0.2, cardMedianBlendWeight: 0.7, vendorOutlierSigma: 2,
      cardStatementCloseDays: 27, cardDefaultPayDay: 24, cardStalePaymentDays: 30,
    });
    assert.equal(gentle?.date.toISOString().slice(0, 10), "2026-09-08");

    // The sigma buffer is the organization's too: sd 4 buffers 2 days at
    // 0.5σ and 4 days at 1σ.
    const party = { ...dated, id: "l-party", partyId: "p-known", dueDate: null, tranDate: new Date("2026-08-22T00:00:00Z") };
    const partyStats = { map: new Map([["p-known", { avg: 10, sd: 4, n: 5 }]]), globalAvg: null };
    const buffered = predict(party, asOf, partyStats);
    assert.equal(buffered?.method, "Statistical");
    assert.equal(buffered?.date.toISOString().slice(0, 10), "2026-09-03");
    // At 1σ the same party buffers 4 days: Aug 22 + 14 lands Saturday Sep 5,
    // so the business-day rule carries it to Monday Sep 7.
    const wide = predict(party, asOf, partyStats, forecastModelParams({ settleBufferSigma: 1 }));
    assert.equal(wide?.date.toISOString().slice(0, 10), "2026-09-07");
    console.log("forecast placement passed: due-date fallback, unplaced counting, configured push and buffer");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
