import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import {
  commenceLease,
  createLeaseAgreement,
  LeaseError,
  postDueLeaseSchedules,
} from "./leases.ts";
import { createScratchOrg, dropScratchOrg } from "./test-fixtures.ts";

for (const phase of ["commencement", "payment"] as const) {
  test(`lease ${phase} refuses an inactive configured account`, { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
    const org = await createScratchOrg();
    try {
      const accounts = {
        rouAsset: org.accounts.invAsset,
        leaseLiability: org.accounts.clearing,
        interestExpense: org.accounts.cogs,
        amortizationExpense: org.accounts.adjustment,
        leaseExpense: org.accounts.adjustment,
        payment: org.accounts.bank,
      };
      const { leaseId } = await createLeaseAgreement(org.orgId, null, {
        subsidiaryId: org.subsidiaryId,
        leaseNumber: `LEASE-INACTIVE-${phase}`,
        commencementOn: "2026-07-01",
        termPeriods: 3,
        paymentFrequency: "monthly",
        paymentAmount: "1000",
        annualDiscountRatePercent: "6",
        classificationInputs: { transfersOwnership: true },
        accounts,
      });
      if (phase === "payment") await commenceLease(org.orgId, leaseId, null);
      const accountId = phase === "commencement" ? accounts.rouAsset : accounts.payment;
      await db.execute(sql`update accounts set is_active=false
        where org_id=${org.orgId} and id=${accountId}`);
      const before = (await db.execute<{ journals: number; claimed: number }>(sql`
        select
          (select count(*)::int from journal_entries where org_id=${org.orgId}) as journals,
          (select count(*)::int from lease_agreement_schedule_lines
             where org_id=${org.orgId} and lease_id=${leaseId} and payment_entry_id is not null) as claimed
      `)).rows[0]!;
      const run = phase === "commencement"
        ? commenceLease(org.orgId, leaseId, null)
        : postDueLeaseSchedules(org.orgId, "2026-07-31", null);
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof LeaseError);
        assert.match(error.message, /active, non-summary/i);
        return true;
      });
      const after = (await db.execute<{ journals: number; claimed: number }>(sql`
        select
          (select count(*)::int from journal_entries where org_id=${org.orgId}) as journals,
          (select count(*)::int from lease_agreement_schedule_lines
             where org_id=${org.orgId} and lease_id=${leaseId} and payment_entry_id is not null) as claimed
      `)).rows[0]!;
      assert.deepEqual(after, before);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  });
}
