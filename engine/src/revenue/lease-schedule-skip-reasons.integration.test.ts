import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { setPeriodLockState } from "../close/period-locks.ts";
import {
  commenceLease,
  createLeaseAgreement,
  postDueLeaseSchedules,
} from "./leases.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";

/**
 * postDueLeaseSchedules refusal propagation.
 *
 * A closed-period line is skipped, never fatal — but the skip must carry the
 * refusal to the operator (lease, sequence, date, book, entity, and the
 * period gate's own message verbatim). Benign replays (nothing due) stay
 * silent: they are not errors, so they add no problem.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

async function seedLeaseAccounts(org: ScratchOrg) {
  const mk = async (
    number: string,
    name: string,
    type: string,
  ): Promise<string> => {
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
  const cal = (
    await db.execute<{ id: string }>(sql`
    select fiscal_calendar_id as id from accounting_periods where org_id = ${org.orgId} limit 1`)
  ).rows[0]!.id;
  await db.execute(sql`
    insert into accounting_periods
      (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
    values (${randomUUID()}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, ${cal})`);
}

async function journalCount(orgId: string): Promise<number> {
  const r = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${orgId}`);
  return r.rows[0]!.n;
}

test(
  "a closed-period skip names the lease, sequence, date, book, entity, and refusal",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const accounts = await seedLeaseAccounts(org);
      await seedAugust(org);
      const { leaseId } = await createLeaseAgreement(org.orgId, null, {
        subsidiaryId: org.subsidiaryId,
        leaseNumber: "L-SKIP-1",
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
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        module: "gl",
        state: "closed",
        actorId,
        reason: "close July before the August run",
      });
      const before = await journalCount(org.orgId);

      // July is locked, August is open: the run must not throw, must still
      // post August, and must explain the July skip.
      const run = await postDueLeaseSchedules(org.orgId, "2026-08-31", null);
      assert.equal(run.posted, 1, `August must post, got ${JSON.stringify(run)}`);
      assert.equal(run.skipped, 1, `July must skip, got ${JSON.stringify(run)}`);
      assert.equal(
        run.problems.length,
        1,
        `the closed line must carry exactly one refusal, got ${JSON.stringify(run)}`,
      );
      const problem = run.problems[0]!;
      assert.match(problem, /L-SKIP-1/, "refusal names the lease");
      assert.match(problem, /sequence 1/, "refusal names the sequence");
      assert.match(problem, /2026-07/, "refusal names the refused date");
      assert.match(
        problem,
        /GL is closed for this period and accounting book/,
        "refusal carries the period gate's own message verbatim",
      );
      assert.match(problem, new RegExp(org.bookId), "refusal names the book");
      assert.match(
        problem,
        new RegExp(org.subsidiaryId),
        "refusal names the legal entity",
      );

      // Zero mutations for the closed line: no journals, no timestamps.
      const after = await journalCount(org.orgId);
      assert.equal(
        after - before,
        2,
        "only the open August line posts (payment + amortization); the closed July line writes nothing",
      );
      const july = (
        await db.execute<{
          payment_posted_at: string | null;
          accrual_posted_at: string | null;
          payment_entry_id: string | null;
          amortization_entry_id: string | null;
        }>(sql`
        select payment_posted_at::text, accrual_posted_at::text, payment_entry_id, amortization_entry_id
          from lease_agreement_schedule_lines
         where org_id = ${org.orgId} and lease_id = ${leaseId} and sequence = 1`)
      ).rows[0]!;
      assert.equal(july.payment_posted_at, null);
      assert.equal(july.accrual_posted_at, null);
      assert.equal(july.payment_entry_id, null);
      assert.equal(july.amortization_entry_id, null);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a replay with nothing due is silent: no error, no problem",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const accounts = await seedLeaseAccounts(org);
      const { leaseId } = await createLeaseAgreement(org.orgId, null, {
        subsidiaryId: org.subsidiaryId,
        leaseNumber: "L-SKIP-2",
        commencementOn: "2026-07-01",
        termPeriods: 1,
        paymentFrequency: "monthly",
        paymentAmount: "1000",
        annualDiscountRatePercent: "6",
        classificationInputs: { transfersOwnership: true },
        accounts,
      });
      await commenceLease(org.orgId, leaseId, null);
      const first = await postDueLeaseSchedules(org.orgId, "2026-07-31", null);
      assert.equal(first.posted, 1, `July must post, got ${JSON.stringify(first)}`);
      assert.deepEqual(first.problems, []);

      // Nothing is due anymore: a replay is a silent no-op, not a refusal.
      const replay = await postDueLeaseSchedules(org.orgId, "2026-07-31", null);
      assert.equal(replay.posted, 0);
      assert.equal(replay.skipped, 0);
      assert.deepEqual(replay.problems, []);
      assert.deepEqual(replay.entries, []);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
