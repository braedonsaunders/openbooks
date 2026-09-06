import assert from "node:assert/strict";
import test from "node:test";
import { saveOpeningBalances } from "./payroll-opening-balances.ts";
import { payRunStaleness } from "./payroll-readiness.ts";
import { calculatePayRun, commitPayRun } from "./payroll-run.ts";
import { dropScratchOrgReporting } from "./test-fixtures.ts";
import { calculatedRun, seedAdoption } from "./payroll-filing-test-fixtures.ts";

/**
 * A statutory carry-in is the ONLY input for the year's annual ceilings, yet
 * the commit-time freshness gate never watched it: a carry-in saved between
 * Calculate and Commit was silently ignored, the employee was deducted past
 * the CPP/EI maximum, and the carry-in was then locked in a state the
 * committed stub contradicts.
 */
test(
  "a carry-in saved after calculation makes the run stale and refuses commit until recalculated",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const { input } = await calculatedRun(fx);
      assert.deepEqual((await payRunStaleness(fx.orgId, input.documentId)).reasons, []);

      const saved = await saveOpeningBalances({
        orgId: fx.orgId,
        actorId: fx.actorId,
        taxYear: 2026,
        rows: [{
          employeePartyId: fx.employeeId,
          amounts: { pensionableYtd: "60000.00", cppYtd: "3500.00" },
          components: {},
        }],
      });
      assert.deepEqual(saved.errors, []);

      const stale = await payRunStaleness(fx.orgId, input.documentId);
      assert.ok(stale.stale);
      assert.deepEqual(stale.reasons, ["openingBalances"]);
      await assert.rejects(commitPayRun(input), /openingBalances/);

      // Recalculating consumes the carry-in; the run is fresh again and commits.
      assert.deepEqual((await calculatePayRun(input)).errors, []);
      assert.deepEqual((await payRunStaleness(fx.orgId, input.documentId)).reasons, []);
      await commitPayRun(input);

      // The committed run now locks the carry-in it consumed.
      await assert.rejects(
        saveOpeningBalances({
          orgId: fx.orgId,
          actorId: fx.actorId,
          taxYear: 2026,
          rows: [{
            employeePartyId: fx.employeeId,
            amounts: { pensionableYtd: "1.00", cppYtd: "0" },
            components: {},
          }],
        }),
        /already used this carry-in for 2026/,
      );
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
