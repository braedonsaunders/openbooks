import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { toUnits } from "./money.ts";
import { commenceLease, createLeaseAgreement, postDueLeaseSchedules } from "./leases.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

interface LeaseAccounts {
  rouAsset: string;
  leaseLiability: string;
  interestExpense: string;
  amortizationExpense: string;
  leaseExpense: string;
  payment: string;
}

/** The scratch fixture has no lease accounts; add them. */
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

async function glBalance(orgId: string, accountId: string): Promise<bigint> {
  const r = (await db.execute(sql`
    select coalesce(sum(amount), 0) as bal from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
     where l.org_id = ${orgId} and l.account_id = ${accountId}`)) as unknown as { rows: { bal: string }[] };
  return toUnits(r.rows[0]!.bal);
}

test("finance lease: commencement, payments, amortization — full lifecycle to zero", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const accounts = await seedLeaseAccounts(org);
    // Monthly lease inside the fixture's open period: 3 payments of 1,000 at
    // 6% annual (0.5%/month exact), commencing 2026-07-01.
    const { leaseId, classification } = await createLeaseAgreement(org.orgId, null, {
      subsidiaryId: org.subsidiaryId,
      leaseNumber: "L-FIN-1",
      commencementOn: "2026-07-01",
      termPeriods: 3,
      paymentFrequency: "monthly",
      paymentAmount: "1000",
      annualDiscountRatePercent: "6",
      classificationInputs: { transfersOwnership: true },
      accounts,
    });
    assert.equal(classification.model, "finance");

    const commenced = await commenceLease(org.orgId, leaseId, null);
    // PV of 3×1000 at 0.5%: 2,970.2481
    assert.equal(commenced.liability, "2970.2481");
    assert.equal(await glBalance(org.orgId, accounts.rouAsset), toUnits("2970.2481"));
    assert.equal(await glBalance(org.orgId, accounts.leaseLiability), -toUnits("2970.2481"));

    // Idempotent commencement.
    const again = await commenceLease(org.orgId, leaseId, null);
    assert.equal(again.commencementEntryId, commenced.commencementEntryId);
    assert.equal(await glBalance(org.orgId, accounts.rouAsset), toUnits("2970.2481"));

    // Fixture only opens July — post the July payment (due 7/31).
    const run = await postDueLeaseSchedules(org.orgId, "2026-07-31", null);
    assert.equal(run.posted, 1);
    // Interest month 1 = round(2970.2481 × 0.005) = 14.8512
    assert.equal(await glBalance(org.orgId, accounts.interestExpense), toUnits("14.8512"));
    assert.equal(
      await glBalance(org.orgId, accounts.leaseLiability),
      -(toUnits("2970.2481") - (toUnits("1000") - toUnits("14.8512"))),
    );
    // Amortization month 1 = apportion(2970.2481 / 3) → 990.0827
    assert.equal(await glBalance(org.orgId, accounts.amortizationExpense), toUnits("990.0827"));

    // Idempotent: re-running as of the same date posts nothing further.
    const rerun = await postDueLeaseSchedules(org.orgId, "2026-07-31", null);
    assert.equal(rerun.posted, 0);
    assert.equal(await glBalance(org.orgId, accounts.interestExpense), toUnits("14.8512"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("short-term exempt lease stays off balance sheet; payments expense straight-line", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const accounts = await seedLeaseAccounts(org);
    const { leaseId } = await createLeaseAgreement(org.orgId, null, {
      subsidiaryId: org.subsidiaryId,
      leaseNumber: "L-ST-1",
      commencementOn: "2026-07-01",
      termPeriods: 1,
      paymentFrequency: "monthly",
      paymentAmount: "1000",
      annualDiscountRatePercent: "6",
      exemption: "short_term",
      accounts,
    });
    const commenced = await commenceLease(org.orgId, leaseId, null);
    assert.equal(commenced.liability, "0");
    assert.equal(commenced.commencementEntryId, null);
    assert.equal(await glBalance(org.orgId, accounts.rouAsset), 0n);
    assert.equal(await glBalance(org.orgId, accounts.leaseLiability), 0n);

    const run = await postDueLeaseSchedules(org.orgId, "2026-07-31", null);
    assert.equal(run.posted, 1);
    assert.equal(await glBalance(org.orgId, accounts.leaseExpense), toUnits("1000"));
    assert.equal(await glBalance(org.orgId, accounts.rouAsset), 0n);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a 13-month lease cannot elect the short-term exemption", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const accounts = await seedLeaseAccounts(org);
    await assert.rejects(
      createLeaseAgreement(org.orgId, null, {
        subsidiaryId: org.subsidiaryId,
        leaseNumber: "L-ST-2",
        commencementOn: "2026-07-01",
        termPeriods: 13,
        paymentFrequency: "monthly",
        paymentAmount: "1000",
        annualDiscountRatePercent: "6",
        exemption: "short_term",
        accounts,
      }),
      /short-term exemption requires/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
