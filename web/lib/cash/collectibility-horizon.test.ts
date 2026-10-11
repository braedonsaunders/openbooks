import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

/**
 * A receivable past the collectability horizon is not a receipt. Once its
 * aging basis is more than the configured horizon days old, it is counted and
 * listed as not forecast instead of being pushed into the near term. Payables
 * are never excluded, unapplied credits always net, and every projected
 * receipt names the basis behind its date.
 */
test("receivables past the collectability horizon are listed, never projected; every projection names its basis", () => {
  // core.ts is server-only in production, so run the behavior check under
  // React's server condition (the same pattern as predict-placement.test.ts).
  const source = `
    import assert from "node:assert/strict";
    import { forecastModelParams, scheduleForecast } from "./web/lib/cash/core.ts";

    const asOf = new Date("2026-10-11T00:00:00Z");
    const start = new Date("2026-10-05T00:00:00Z");
    const end = new Date("2027-01-31T00:00:00Z");
    const noHistory = { map: new Map(), globalAvg: null };
    const model = forecastModelParams({ collectibilityHorizonDays: 90 });

    // 285 days past due with no payment history.
    const stale = {
      id: "l-stale", entryId: "e1", docKind: "customer_invoice", docNumber: "INV-285",
      docId: "d1", partyId: "p-harbor", partyName: "Harbor Supply Co",
      tranDate: new Date("2025-12-01T00:00:00Z"), dueDate: new Date("2025-12-30T00:00:00Z"),
      remaining: "9900.0000",
    };
    // Also 285 days past due, but with a credit balance: unapplied credits net.
    const staleCredit = { ...stale, id: "l-credit", docNumber: "CM-9", partyId: "p-credit", partyName: "Credit Co", remaining: "-400.0000" };
    // 60 days past due: inside the horizon, so it is still forecast (pushed).
    const recent = {
      id: "l-recent", entryId: "e2", docKind: "customer_invoice", docNumber: "INV-60",
      docId: "d2", partyId: "p-recent", partyName: "Recent Co",
      tranDate: new Date("2026-07-01T00:00:00Z"), dueDate: new Date("2026-08-12T00:00:00Z"),
      remaining: "250.0000",
    };

    const receivable = scheduleForecast([stale, staleCredit, recent], noHistory, asOf, start, end, model, true);
    // The stale receivable is named, counted and totalled exactly; it is in no week.
    assert.equal(receivable.notForecast.count, 1);
    assert.equal(receivable.notForecast.total, "9900.0000");
    assert.equal(receivable.notForecast.entries[0].id, "l-stale");
    assert.equal(receivable.notForecast.entries[0].daysOverdue, 285);
    assert.equal(receivable.notForecast.entries[0].partyName, "Harbor Supply Co");
    assert.ok(![...receivable.byWeek.values()].flat().some((e) => e.id === "l-stale"));
    // The credit nets as before; the recent receivable is pushed, not excluded.
    const placed = receivable.entries.map((e) => e.id).sort();
    assert.deepEqual(placed, ["l-credit", "l-recent"]);
    const recentEntry = receivable.entries.find((e) => e.id === "l-recent");
    assert.equal(recentEntry?.method, "Overdue push");
    assert.equal(recentEntry?.basisDays, null);
    assert.equal(receivable.scheduled, "-150.0000");

    // The same population on the payables side is never excluded: a bill 285
    // days overdue is still owed and still placed.
    const payable = scheduleForecast([stale], noHistory, asOf, start, end, model);
    assert.equal(payable.notForecast.count, 0);
    assert.equal(payable.entries.length, 1);
    assert.equal(payable.entries[0].method, "Overdue push");

    // The horizon is the organization's: a 30-day horizon excludes the 60-day item.
    const tight = scheduleForecast([recent], noHistory, asOf, start, end, forecastModelParams({ collectibilityHorizonDays: 30 }), true);
    assert.equal(tight.notForecast.count, 1);
    assert.equal(tight.entries.length, 0);

    // Every projected receipt names its basis: the party's average days to pay,
    // the organization average, or the due date.
    const current = {
      id: "l-current", entryId: "e3", docKind: "customer_invoice", docNumber: "INV-C",
      docId: "d3", partyId: "p-known", partyName: "Known Co",
      tranDate: new Date("2026-10-01T00:00:00Z"), dueDate: null,
      remaining: "100.0000",
    };
    const withParty = scheduleForecast([current], { map: new Map([["p-known", { avg: 42.4, sd: 0, n: 5 }]]), globalAvg: null }, asOf, start, end, model, true);
    assert.equal(withParty.entries[0].method, "Statistical");
    assert.equal(withParty.entries[0].basisDays, 42);
    const withAverage = scheduleForecast([{ ...current, partyId: "p-other" }], { map: new Map(), globalAvg: 30 }, asOf, start, end, model, true);
    assert.equal(withAverage.entries[0].method, "Global avg");
    assert.equal(withAverage.entries[0].basisDays, 30);
    const withDue = scheduleForecast([{ ...current, partyId: "p-other", dueDate: new Date("2026-10-20T00:00:00Z") }], { map: new Map(), globalAvg: null }, asOf, start, end, model, true);
    assert.equal(withDue.entries[0].method, "Due date");
    assert.equal(withDue.entries[0].basisDays, null);

    console.log("collectibility horizon passed: exclusion, payables untouched, credits net, basis named");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
