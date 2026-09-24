import assert from "node:assert/strict";
import test from "node:test";
import { saveOpeningBalances } from "./opening-balances.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { db } from "../platform/db.ts";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { payRunStaleness } from "./readiness.ts";
import { calculatePayRun } from "./run-calculation.ts";
import { commitPayRun } from "./run-commit.ts";
import { dropScratchOrgReporting } from "../testing/fixtures.ts";
import { calculatedRun, seedAdoption } from "./filing-test-fixtures.ts";

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

test(
  "opening-balance save rechecks employee scope after a committed rehome",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const fx = await seedAdoption();
    try {
      const movedTo = randomUUID();
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
        values (${movedTo}, ${fx.orgId}, ${fx.subsidiaryId}, 'Opening balance rehome target', 'CAD', 'CA')
      `);
      await db.execute(sql`update parties set subsidiary_id = ${fx.subsidiaryId} where org_id = ${fx.orgId} and id = ${fx.employeeId}`);
      const precheck = (await db.execute<{ subsidiary_id: string | null }>(sql`
        select subsidiary_id from parties where org_id = ${fx.orgId} and id = ${fx.employeeId}
      `)).rows[0];
      assert.equal(precheck?.subsidiary_id, fx.subsidiaryId, "the route precheck sees the employee in scope");

      // Both statements autocommit: the move lands after the precheck and
      // before the service's own write transaction, with no outer test txn.
      await db.execute(sql`update parties set subsidiary_id = ${movedTo} where org_id = ${fx.orgId} and id = ${fx.employeeId}`);
      await assert.rejects(saveOpeningBalances({
        orgId: fx.orgId,
        actorId: fx.actorId,
        taxYear: 2026,
        rows: [{ employeePartyId: fx.employeeId, amounts: { pensionableYtd: "60000" } }],
        allowedSubsidiaryIds: new Set([fx.subsidiaryId]),
      }), (error: unknown) => error instanceof ScopeNotFoundError);
      const stored = await db.execute(sql`
        select 1 from payroll_opening_balances where org_id = ${fx.orgId} and employee_party_id = ${fx.employeeId}
      `);
      assert.equal(stored.rows.length, 0, "the out-of-scope carry-in writes no balance row");
    } finally {
      await dropScratchOrgReporting(fx.orgId);
    }
  },
);
