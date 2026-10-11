import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

/**
 * An unapplied customer credit nets into the customer's open balance but is
 * not a receivable. It must never appear as a chase row, never count toward
 * the overdue-to-chase total, and surface only as the separate unapplied
 * credits figure.
 */
test("unapplied credits stay out of the chase list and the overdue total", () => {
  // core.ts and ar-position.ts are server-only in production, so the checks
  // run under React's server condition (the same pattern as core.test.ts).
  // The population is built in memory: no database, no clock.
  const source = `
    import assert from "node:assert/strict";
    import { chaseableEntries, collectionsBalances, scheduleForecast, ZERO_MONEY } from "./web/lib/cash/core.ts";
    import { groupByCustomer } from "./web/lib/cash/ar-position.ts";

    const asOf = new Date("2026-10-10T00:00:00Z");
    const day = (iso) => (iso ? new Date(iso + "T00:00:00Z") : null);
    const item = (id, partyId, partyName, docKind, tranDate, dueDate, remaining) => ({
      id, entryId: "e-" + id, docKind, docNumber: id, docId: "d-" + id, partyId, partyName,
      tranDate: day(tranDate), dueDate: day(dueDate), remaining,
    });
    const items = [
      item("INV-A", "p-acme", "Acme Builders", "customer_invoice", "2026-08-01", "2026-09-01", "100.0000"),
      item("INV-B", "p-prairie", "Prairie Crest Homes", "customer_invoice", "2026-09-05", null, "50.0000"),
      item("INV-C", "p-acme", "Acme Builders", "customer_invoice", "2026-10-01", "2026-10-20", "300.0000"),
      item("CR-P", "p-prairie", "Prairie Crest Homes", "customer_credit", "2026-09-20", "2026-10-09", "-5796.0000"),
      item("CR-S", "p-solo", "Solo Credit Co", "customer_credit", "2026-08-01", "2026-08-15", "-40.0000"),
    ];

    // The scheduled population, exactly as the worklist reader sees it: the
    // credit is placed by the same forecast as the invoices.
    const stats = { map: new Map(), globalAvg: 30 };
    const schedule = scheduleForecast(items, stats, asOf, day("2026-01-01"), day("2027-12-31"));
    assert.ok(schedule.entries.some((entry) => entry.id === "CR-P"), "the credit is scheduled before the worklist filter");

    // Chase rows: receivables only.
    const chase = chaseableEntries(schedule.entries).map((entry) => entry.id).sort();
    assert.deepEqual(chase, ["INV-A", "INV-B", "INV-C"]);

    // Overdue is the gross past-due receivable balance; credits are reported
    // separately as a positive magnitude. INV-A (39 days) and INV-B (35 days
    // from posting, untermed) are past due; INV-C is not yet due.
    const balances = collectionsBalances(items, asOf);
    assert.equal(balances.overdue, "150.0000");
    assert.equal(balances.overdueCount, 2);
    assert.equal(balances.unappliedCredits, "5836.0000");
    assert.equal(balances.unappliedCreditCount, 2);

    // A customer row nets its credit into the open balance but never into
    // overdue, and a credit-only customer owes nothing past due.
    const customers = groupByCustomer(items, asOf);
    const byName = Object.fromEntries(customers.map((row) => [row.partyName, row]));
    assert.equal(byName["Acme Builders"].amount, "400.0000");
    assert.equal(byName["Acme Builders"].overdue, "100.0000");
    assert.equal(byName["Prairie Crest Homes"].amount, "-5746.0000");
    assert.equal(byName["Prairie Crest Homes"].overdue, "50.0000");
    assert.equal(byName["Prairie Crest Homes"].oldestDue, "2026-09-05");
    assert.equal(byName["Solo Credit Co"].overdue, ZERO_MONEY);
    assert.equal(byName["Solo Credit Co"].oldestDue, null);

    // Nothing open: no chase rows, no overdue, no credits.
    assert.deepEqual(collectionsBalances([], asOf), { overdue: ZERO_MONEY, overdueCount: 0, unappliedCredits: ZERO_MONEY, unappliedCreditCount: 0 });
    console.log("collections balances exclude unapplied credits from chase rows and overdue");
  `;
  const result = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "--input-type=module", "-e", source],
    { cwd: process.cwd(), env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /collections balances exclude unapplied credits/);
});
