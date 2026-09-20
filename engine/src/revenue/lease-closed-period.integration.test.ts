import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { setPeriodLockState } from "../close/period-locks.ts";
import { commenceLease, createLeaseAgreement, LeaseError, postDueLeaseSchedules } from "./leases.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * Lease postings that land in a GL-closed period.
 *
 * postLeaseEntry writes its journals through raw draft→posted flips that
 * never call the posting kernel, exactly like the asset-lifecycle class
 * before its guard: a schedule run straddling a closed period end must skip
 * the locked lines and keep posting the open ones (the depreciation and
 * revenue runners both skip closed periods), and commencement into a closed
 * period must refuse with a named LeaseError. Dying at the je_guard flip
 * with a raw driver error aborts the whole schedule run — later open-period
 * lines never post — and surfaces an HTTP 500 instead of a typed refusal.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedLeaseAccounts(org: ScratchOrg) {
  const mk = async (number: string, name: string, type: string): Promise<string> => {
    const id = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate, reconcilable,
                            required_dimensions, custom, subsidiary_include_children)
      values (${id}, ${org.orgId}, ${number}, ${name}, ${type}, false, true, false, false,
              '[]'::jsonb, '{}'::jsonb, true)`);
    return id;
  };
  return {
    rouAsset: await mk("1700", "Right-of-Use Asset", "asset_fixed"),
    leaseLiability: await mk("2700", "Lease Liability", "liability_long_term"),
    interestExpense: await mk("6910", "Lease Interest", "expense_other"),
    amortizationExpense: await mk("6920", "ROU Amortization", "expense"),
    leaseExpense: await mk("6900", "Lease Cost", "expense"),
    payment: org.accounts.bank,
  };
}

async function seedAugust(org: ScratchOrg): Promise<void> {
  const cal = (await db.execute<{ id: string }>(sql`
    select fiscal_calendar_id as id from accounting_periods where org_id = ${org.orgId} limit 1`)).rows[0]!.id;
  await db.execute(sql`
    insert into accounting_periods
      (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    values (${randomUUID()}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${cal})`);
}

async function unpostedCount(orgId: string, leaseId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from lease_agreement_schedule_lines
     where org_id = ${orgId} and lease_id = ${leaseId} and payment_entry_id is null`));
  return r.rows[0]!.n;
}

test("a lease schedule run skips GL-closed periods and posts the open ones", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const accounts = await seedLeaseAccounts(org);
    await seedAugust(org);
    const { leaseId } = await createLeaseAgreement(org.orgId, null, {
      subsidiaryId: org.subsidiaryId,
      leaseNumber: "L-CLOSED-1",
      commencementOn: "2026-07-01",
      termPeriods: 2,
      paymentFrequency: "monthly",
      paymentAmount: "1000",
      annualDiscountRatePercent: "6",
      classificationInputs: { transfersOwnership: true },
      accounts,
    });
    await commenceLease(org.orgId, leaseId, null);
    await setPeriodLockState({
      orgId: org.orgId, periodId: org.periodId, bookId: org.bookId,
      module: "gl", state: "closed", actorId, reason: "close July before the August run",
    });

    // July is locked, August is open: the run must not throw, must leave
    // July unposted, and must still post August.
    const run = await postDueLeaseSchedules(org.orgId, "2026-08-31", null);
    assert.equal(run.posted, 1, `August must post through a locked July, got ${JSON.stringify(run)}`);
    assert.equal(run.skipped, 1, `July must be skipped, not posted or fatal, got ${JSON.stringify(run)}`);
    assert.equal(await unpostedCount(org.orgId, leaseId), 1, "the locked July line must stay due");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("commencement into a GL-closed period refuses with a named LeaseError", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const accounts = await seedLeaseAccounts(org);
    const { leaseId } = await createLeaseAgreement(org.orgId, null, {
      subsidiaryId: org.subsidiaryId,
      leaseNumber: "L-CLOSED-2",
      commencementOn: "2026-07-15",
      termPeriods: 2,
      paymentFrequency: "monthly",
      paymentAmount: "1000",
      annualDiscountRatePercent: "6",
      classificationInputs: { transfersOwnership: true },
      accounts,
    });
    await setPeriodLockState({
      orgId: org.orgId, periodId: org.periodId, bookId: org.bookId,
      module: "gl", state: "closed", actorId, reason: "July is closed before commencement",
    });
    await assert.rejects(
      commenceLease(org.orgId, leaseId, null),
      (e: unknown) => e instanceof LeaseError && /closed/i.test((e as Error).message),
      "commencement into a closed period must raise LeaseError, not a raw driver error",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
