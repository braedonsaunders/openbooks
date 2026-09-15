import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { cmp } from "./money.ts";
import {
  calculatedRun,
  markLegacy,
  seedAdoption,
} from "./payroll-filing-test-fixtures.ts";
import { reconcilePayrollFilingAccounts } from "./payroll-filing-reconciliation.ts";
import { commitPayRun } from "./payroll-run.ts";
import {
  createRemittanceBill,
  payrollRemittanceSummary,
} from "./payroll-remittance.ts";
import { dropScratchOrg } from "./test-fixtures.ts";

// Live-Postgres regression: one legacy pay run whose stubs were never
// attributed to a filing account (filing_account_source = 'unknown') made
// payrollRemittanceSummary throw for the WHOLE org — the real tenant's only
// pay run poisoned its entire remittance surface (the report failed with
// 'Committed payroll has an unknown historical filing account' and no
// figure was reachable at all).
//
// The summary must keep working: unattributed legacy accruals surface under
// the unassigned account, flagged, with their real liability money
// included. Only money movement stays fail-closed — no remittance bill for
// a group carrying unattributed accruals until its stubs are reconciled.

const DB = !!process.env.OPENBOOKS_DB_URL;

test("legacy unattributed payroll surfaces unfiled without poisoning the remittance summary", { skip: !DB }, async () => {
  const fx = await seedAdoption();
  try {
    // Route every statutory group to a real vendor so a bill can be attempted.
    const vendor = randomUUID();
    await db.execute(
      sql`insert into parties(id,org_id,kind,display_name,is_active) values(${vendor},${fx.orgId},'organization','Remittance authority',true)`,
    );
    await db.execute(
      sql`insert into vendor_roles(org_id,party_id,is_active) values(${fx.orgId},${vendor},true)`,
    );
    await db.execute(
      sql`update pay_components set remittance_party_id=${vendor} where org_id=${fx.orgId}`,
    );
    const { input } = await calculatedRun(fx);
    await commitPayRun(input);
    await markLegacy(fx.orgId);
    const range = { from: "2026-07-01", to: "2026-07-31" };

    // The summary resolves: legacy accruals land unassigned, flagged, funded.
    const groups = await payrollRemittanceSummary(fx.orgId, range);
    assert.ok(groups.length > 0, "legacy payroll still remits into groups");
    const unassigned = groups.filter((g) => g.filingAccount.id === null);
    assert.ok(unassigned.length > 0, "legacy accruals surface under the unassigned account");
    assert.ok(
      unassigned.every((g) => g.hasUnknownFilingAccount),
      "every unassigned group flags its unattributed legacy accruals",
    );
    assert.ok(
      unassigned.some((g) => cmp(g.total, "0") !== 0),
      "flagged groups still carry their real liability money",
    );

    // ...but no bill while attribution is unknown: fail closed for that
    // run's boxes, not for the whole org.
    await assert.rejects(
      createRemittanceBill(fx.orgId, fx.actorId, {
        partyId: vendor,
        ...range,
        filingAccountId: null,
      }),
      /unknown historical filing account/,
    );

    // Explicit-null reconciliation (reviewed as originally unassigned) clears
    // the flag, and the bill flows with the same totals the summary showed.
    const stubs = (
      await db.execute<{ id: string }>(
        sql`select id from pay_stubs where org_id = ${fx.orgId} order by id`,
      )
    ).rows.map((row) => row.id);
    assert.ok(stubs.length > 0);
    const reconciled = await reconcilePayrollFilingAccounts({
      orgId: fx.orgId,
      actorId: fx.actorId,
      rows: stubs.map((stubId) => ({
        stubId,
        filingAccountId: null,
        reason: "Reviewed original unassigned register",
        reference: "test-evidence/unassigned",
      })),
    });
    assert.equal(reconciled, stubs.length);
    const after = await payrollRemittanceSummary(fx.orgId, range);
    assert.ok(
      after.every((g) => !g.hasUnknownFilingAccount),
      "reconciliation clears the unknown flag",
    );
    const bill = await createRemittanceBill(fx.orgId, fx.actorId, {
      partyId: vendor,
      ...range,
      filingAccountId: null,
    });
    assert.ok(bill.documentId);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});
