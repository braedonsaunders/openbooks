import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { add, neg } from "../money/money.ts";
import { commenceLease, createLeaseAgreement, postDueLeaseSchedules } from "./leases.ts";
import { presentValueOfLevelStream, periodRateFromAnnualPercent } from "../money/present-value.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "../testing/fixtures.ts";

/**
 * Continue-from-opening onboarding for mid-life lessee leases.
 *
 * A tenant arriving with history in a legacy system onboards the lease at its
 * contractual terms (original commencement, full term, payment, rate) plus the
 * opening liability and right-of-use carrying amounts measured through the
 * cutover as-of date. Commencement then inserts schedule rows only for the
 * remaining periods (full-term sequence numbering continues), accretes forward
 * from the STATED opening liability, amortises the STATED opening ROU, posts
 * no commencement journal (the opening-TB import owns the GL balances), and
 * the periodic runner ties out to those figures with nothing pre-cutover ever
 * posting.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

interface LeaseAccounts {
  rouAsset: string;
  leaseLiability: string;
  interestExpense: string;
  amortizationExpense: string;
  leaseExpense: string;
  payment: string;
}

async function seedLeaseAccounts(org: ScratchOrg): Promise<LeaseAccounts> {
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

async function seedMonthlyPeriods(
  orgId: string,
  months: { n: number; name: string; from: string; to: string }[],
): Promise<void> {
  const cal = (await db.execute<{ id: string }>(sql`
    select fiscal_calendar_id as id from accounting_periods where org_id = ${orgId} limit 1`)).rows[0]!.id;
  for (const m of months) {
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${orgId}, 2026, ${m.n}, ${m.name}, ${m.from}, ${m.to}, false, ${cal})`);
  }
}

const MONTHS_2026 = [
  { n: 1, name: "2026-01", from: "2026-01-01", to: "2026-01-31" },
  { n: 2, name: "2026-02", from: "2026-02-01", to: "2026-02-28" },
  { n: 3, name: "2026-03", from: "2026-03-01", to: "2026-03-31" },
  { n: 4, name: "2026-04", from: "2026-04-01", to: "2026-04-30" },
  { n: 5, name: "2026-05", from: "2026-05-01", to: "2026-05-31" },
  { n: 6, name: "2026-06", from: "2026-06-01", to: "2026-06-30" },
  { n: 8, name: "2026-08", from: "2026-08-01", to: "2026-08-31" },
  { n: 9, name: "2026-09", from: "2026-09-01", to: "2026-09-30" },
  { n: 10, name: "2026-10", from: "2026-10-01", to: "2026-10-31" },
  { n: 11, name: "2026-11", from: "2026-11-01", to: "2026-11-30" },
  { n: 12, name: "2026-12", from: "2026-12-01", to: "2026-12-31" },
];

async function scheduleRows(orgId: string, leaseId: string) {
  return (await db.execute<{
    sequence: number; due_on: string; period_start: string; period_end: string;
    opening_liability: string; payment: string; interest: string; principal: string;
    closing_liability: string; amortization: string | null; single_cost: string | null;
    rou_adjustment: string | null;
  }>(sql`
    select sequence, due_on::text, period_start::text, period_end::text,
           opening_liability::text, payment::text, interest::text, principal::text,
           closing_liability::text, amortization::text, single_cost::text,
           rou_adjustment::text
      from lease_agreement_schedule_lines
     where org_id = ${orgId} and lease_id = ${leaseId}
     order by sequence`)).rows;
}

async function journalCount(orgId: string): Promise<number> {
  return (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${orgId}`)).rows[0]!.n;
}

test("a finance lease onboarded mid-life continues from its stated opening balances", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const accounts = await seedLeaseAccounts(org);
    await seedMonthlyPeriods(org.orgId, MONTHS_2026);
    // Six-year lease from 2021-01-01, 2000/month at 6%: 60 periods sit in
    // the legacy system; 12 remain after the 2025-12-31 cutover.
    const rate = periodRateFromAnnualPercent("6", 12);
    const openingLiability = presentValueOfLevelStream({ payment: "2000", periods: 12, rate, timing: "arrears" });
    const { leaseId } = await createLeaseAgreement(org.orgId, null, {
      subsidiaryId: org.subsidiaryId,
      leaseNumber: "L-ONBOARD-1",
      commencementOn: "2021-01-01",
      termPeriods: 72,
      paymentFrequency: "monthly",
      paymentAmount: "2000",
      annualDiscountRatePercent: "6",
      classificationInputs: { transfersOwnership: true },
      openingBalances: { liability: openingLiability, rouCarrying: openingLiability, asOf: "2025-12-31" },
      accounts,
    });

    const commenced = await commenceLease(org.orgId, leaseId, null);
    assert.equal(commenced.liability, openingLiability, "commencement echoes the stated opening liability");
    assert.equal(commenced.rouAsset, openingLiability);
    assert.equal(commenced.commencementEntryId, null, "no commencement journal — the opening-TB import owns the GL balances");
    assert.equal(await journalCount(org.orgId), 0, "commencement posts nothing");

    const rows = await scheduleRows(org.orgId, leaseId);
    assert.equal(rows.length, 12, `only the 12 remaining periods schedule (got ${rows.length})`);
    assert.deepEqual(
      rows.map((r) => r.sequence),
      [61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72],
      "full-term sequence numbering continues",
    );
    assert.ok(rows.every((r) => r.period_end > "2025-12-31"), "no pre-cutover row exists to catch up");
    assert.equal(rows[0]!.opening_liability, openingLiability, "accretion starts from the stated opening");
    assert.equal(rows[11]!.closing_liability, "0.0000", "the continued schedule retires to exactly zero");
    assert.equal(
      rows.map((r) => r.principal).reduce(add),
      openingLiability,
      "principals consume exactly the stated opening liability",
    );
    assert.equal(
      rows.map((r) => r.amortization!).reduce(add),
      openingLiability,
      "amortization consumes exactly the stated opening ROU",
    );

    // Post Q1: carrying amounts tie to opening minus posted.
    const run = await postDueLeaseSchedules(org.orgId, "2026-03-31", null);
    assert.equal(run.posted, 3);
    const postedPrincipal = rows.slice(0, 3).map((r) => r.principal).reduce(add);
    const postedAmort = rows.slice(0, 3).map((r) => r.amortization!).reduce(add);
    const liabilityRow = (await db.execute<{ v: string }>(sql`
      select (initial_liability - coalesce((
        select sum(principal) from lease_agreement_schedule_lines
         where org_id = ${org.orgId} and lease_id = ${leaseId} and payment_entry_id is not null
      ), 0))::text as v from lease_agreements where org_id = ${org.orgId} and id = ${leaseId}`)).rows[0]!.v;
    const rouRow = (await db.execute<{ v: string }>(sql`
      select (initial_rou_asset - coalesce((
        select sum(amortization) from lease_agreement_schedule_lines
         where org_id = ${org.orgId} and lease_id = ${leaseId} and payment_entry_id is not null
      ), 0))::text as v from lease_agreements where org_id = ${org.orgId} and id = ${leaseId}`)).rows[0]!.v;
    assert.equal(liabilityRow, add(openingLiability, neg(postedPrincipal)));
    assert.equal(rouRow, add(openingLiability, neg(postedAmort)));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an operating lease with divergent opening ROU retires exactly that ROU", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const accounts = await seedLeaseAccounts(org);
    await seedMonthlyPeriods(org.orgId, MONTHS_2026);
    const rate = periodRateFromAnnualPercent("6", 12);
    const openingLiability = presentValueOfLevelStream({ payment: "2000", periods: 12, rate, timing: "arrears" });
    // Legacy ROU differs from the liability (unamortised initial direct
    // costs in the outgoing system): the continuation must retire THIS
    // figure, not re-derive it.
    const openingRou = add(openingLiability, "500.0000");
    const { leaseId } = await createLeaseAgreement(org.orgId, null, {
      subsidiaryId: org.subsidiaryId,
      leaseNumber: "L-ONBOARD-OP",
      commencementOn: "2021-01-01",
      termPeriods: 72,
      paymentFrequency: "monthly",
      paymentAmount: "2000",
      annualDiscountRatePercent: "6",
      openingBalances: { liability: openingLiability, rouCarrying: openingRou, asOf: "2025-12-31" },
      accounts,
    });
    const commenced = await commenceLease(org.orgId, leaseId, null);
    assert.equal(commenced.liability, openingLiability);
    assert.equal(commenced.rouAsset, openingRou);
    const rows = await scheduleRows(org.orgId, leaseId);
    assert.equal(rows.length, 12);
    assert.equal(rows[11]!.closing_liability, "0.0000");
    assert.equal(
      rows.map((r) => r.rou_adjustment!).reduce(add),
      openingRou,
      `ROU adjustments must consume exactly the stated opening ROU ${openingRou}`,
    );
    assert.equal(
      rows.map((r) => r.principal).reduce(add),
      openingLiability,
      "principals still consume exactly the stated opening liability",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("opening balances fail closed on bad cutover input", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const accounts = await seedLeaseAccounts(org);
    const base = {
      subsidiaryId: org.subsidiaryId,
      commencementOn: "2021-01-01",
      termPeriods: 72,
      paymentFrequency: "monthly" as const,
      paymentAmount: "2000",
      annualDiscountRatePercent: "6",
      classificationInputs: { transfersOwnership: true },
      accounts,
    };
    // as-of before commencement.
    await assert.rejects(
      createLeaseAgreement(org.orgId, null, {
        ...base,
        leaseNumber: "L-BAD-1",
        openingBalances: { liability: "1000", rouCarrying: "1000", asOf: "2020-12-31" },
      }),
      /as-of|asOf|commencement/i,
    );
    // Negative opening.
    await assert.rejects(
      createLeaseAgreement(org.orgId, null, {
        ...base,
        leaseNumber: "L-BAD-2",
        openingBalances: { liability: "-1000", rouCarrying: "1000", asOf: "2025-12-31" },
      }),
      /non-negative|exact decimal/i,
    );
    // Exempt leases recognise no balances.
    await assert.rejects(
      createLeaseAgreement(org.orgId, null, {
        ...base,
        leaseNumber: "L-BAD-3",
        termPeriods: 6,
        exemption: "short_term",
        openingBalances: { liability: "1000", rouCarrying: "1000", asOf: "2021-03-31" },
      }),
      /exempt/i,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an as-of past the term end refuses commencement", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const accounts = await seedLeaseAccounts(org);
    const { leaseId } = await createLeaseAgreement(org.orgId, null, {
      subsidiaryId: org.subsidiaryId,
      leaseNumber: "L-BAD-4",
      commencementOn: "2021-01-01",
      termPeriods: 72,
      paymentFrequency: "monthly",
      paymentAmount: "2000",
      annualDiscountRatePercent: "6",
      classificationInputs: { transfersOwnership: true },
      openingBalances: { liability: "1000", rouCarrying: "1000", asOf: "2027-06-30" },
      accounts,
    });
    await assert.rejects(commenceLease(org.orgId, leaseId, null), /term|remain/i);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
