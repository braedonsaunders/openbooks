import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { cmp } from "../money/money.ts";
import {
  calculatedRun,
  markLegacy,
  seedAdoption,
} from "./filing-test-fixtures.ts";
import { reconcilePayrollFilingAccounts } from "./filing-reconciliation.ts";
import { commitPayRun } from "./run-commit.ts";
import {
  createRemittanceBill,
  payrollRemittanceSummary,
} from "./remittance.ts";
import { dropScratchOrg } from "../testing/fixtures.ts";

// Legacy stubs remain visible in summaries and cannot be billed until
// reviewed evidence assigns their filing account.

const DB = !!process.env.OPENBOOKS_DB_URL;

test("legacy unattributed payroll surfaces unfiled without poisoning the remittance summary", { skip: !DB }, async () => {
  const fx = await seedAdoption();
  try {
    const vendor = randomUUID();
    await db.execute(
      sql`insert into parties(id,org_id,kind,display_name,is_active) values(${vendor},${fx.orgId},'organization','Remittance authority',true)`,
    );
    await db.execute(
      sql`insert into vendor_roles(org_id,party_id,is_active) values(${fx.orgId},${vendor},true)`,
    );
    const filingAccountId = randomUUID();
    await db.execute(sql`
      insert into payroll_filing_accounts (id, org_id, country, program_type, account_number, name, remitter_type, is_default)
      values (${filingAccountId}, ${fx.orgId}, 'CA', 'ca_rp', '123456789RP0001', 'CRA payroll', 'regular', true)`);
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{payroll,craRemittancePartyId}',
      to_jsonb(${vendor}::text), true) where id = ${fx.orgId}`);
    await db.execute(
      sql`update pay_components set remittance_party_id=${vendor} where org_id=${fx.orgId}`,
    );
    const { input } = await calculatedRun(fx);
    await commitPayRun(input);
    await markLegacy(fx.orgId);
    const range = { from: "2026-07-01", to: "2026-07-31" };

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

    await assert.rejects(
      createRemittanceBill(fx.orgId, fx.actorId, {
        partyId: vendor,
        ...range,
        filingAccountId: null,
      }),
      /unknown historical filing account/,
    );

    // Reviewed account evidence clears the flag before the bill is created.
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
        filingAccountId,
        reason: "Matched against the registered CRA account",
        reference: "test-evidence/cra-account",
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
      filingAccountId,
    });
    assert.ok(bill.documentId);
  } finally {
    await dropScratchOrg(fx.orgId);
  }
});
