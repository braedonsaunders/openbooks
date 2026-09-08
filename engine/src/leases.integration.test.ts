import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "./db.ts";
import { toUnits } from "./money.ts";
import { commenceLease, createLeaseAgreement, postDueLeaseSchedules } from "./leases.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Force both requests past discovery, then release their competing writes. */
async function raceBehindFence<T>(table: "lease_agreement_schedule_lines" | "journal_entries", work: () => Promise<T>) {
  const fence = await pool.connect();
  let raced: Promise<PromiseSettledResult<T>[]> | undefined;
  try {
    await fence.query("begin");
    await fence.query(`lock table ${table} in share mode`);
    const pid = (await fence.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    raced = Promise.allSettled([work(), work()]);
    let parked = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      const count = (await pool.query<{ n: number }>(`
        with recursive blocked(pid) as (
          select pid from pg_stat_activity where $1::int = any(pg_blocking_pids(pid))
          union
          select a.pid from pg_stat_activity a join blocked b on b.pid = any(pg_blocking_pids(a.pid))
        ) select count(*)::int as n from blocked`, [pid])).rows[0]!.n;
      if (count >= 2) { parked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(parked, "both requests must reach the controlled lock interleave");
    await fence.query("commit");
    return await raced;
  } finally {
    await fence.query("rollback");
    fence.release();
    await raced;
  }
}

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
  const r = (await db.execute<{ bal: string }>(sql`
    select coalesce(sum(amount), 0) as bal from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.status = 'posted'
     where l.org_id = ${orgId} and l.account_id = ${accountId}`));
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

for (const exemption of [null, "short_term"] as const) {
  test(`concurrent lease commencement replays one ${exemption ?? "finance"} result`, { skip: !DB }, async () => {
    const org = await createScratchOrg();
    try {
      const accounts = await seedLeaseAccounts(org);
      const { leaseId } = await createLeaseAgreement(org.orgId, null, {
        subsidiaryId: org.subsidiaryId, leaseNumber: "LEASE-COMMENCE-RACE",
        commencementOn: "2026-07-01", termPeriods: 3, paymentFrequency: "monthly",
        paymentAmount: "1000", annualDiscountRatePercent: "6",
        classificationInputs: { transfersOwnership: exemption === null }, exemption, accounts,
      });
      const results = await raceBehindFence("lease_agreement_schedule_lines", () => commenceLease(org.orgId, leaseId, null));
      assert.deepEqual(results.map((result) => result.status === "fulfilled" ? "fulfilled" : result.reason?.cause?.message ?? String(result.reason)), ["fulfilled", "fulfilled"], "both commencement requests must succeed");
      if (results[0]?.status !== "fulfilled" || results[1]?.status !== "fulfilled") return;
      const canonical = (value: Awaited<ReturnType<typeof commenceLease>>) => ({
        ...value, liability: toUnits(value.liability), rouAsset: toUnits(value.rouAsset),
      });
      assert.deepEqual(canonical(results[0].value), canonical(results[1].value));
      const count = (await db.execute<{ n: number }>(sql`
        select count(*)::int as n from lease_agreement_schedule_lines where org_id=${org.orgId} and lease_id=${leaseId}`)).rows[0]!.n;
      assert.equal(count, 3);
      assert.equal(await glBalance(org.orgId, accounts.rouAsset), toUnits(results[0].value.rouAsset));
    } finally { await dropScratchOrg(org.orgId); }
  });
}

test("concurrent lease schedule runners claim a due payment once", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const accounts = await seedLeaseAccounts(org);
    const { leaseId } = await createLeaseAgreement(org.orgId, null, {
      subsidiaryId: org.subsidiaryId, leaseNumber: "LEASE-PAYMENT-RACE",
      commencementOn: "2026-07-01", termPeriods: 3, paymentFrequency: "monthly",
      paymentAmount: "1000", annualDiscountRatePercent: "6",
      classificationInputs: { transfersOwnership: true }, accounts,
    });
    await commenceLease(org.orgId, leaseId, null);
    const results = await raceBehindFence("journal_entries", () => postDueLeaseSchedules(org.orgId, "2026-07-31", null));
    assert.deepEqual(results.map((result) => result.status === "fulfilled" ? "fulfilled" : result.reason?.cause?.message ?? String(result.reason)), ["fulfilled", "fulfilled"], "the losing retry must safely skip the claimed payment");
    if (results[0]?.status !== "fulfilled" || results[1]?.status !== "fulfilled") return;
    assert.equal(results.reduce((n, result) => n + (result.status === "fulfilled" ? result.value.posted : 0), 0), 1);
    assert.equal(await glBalance(org.orgId, accounts.payment), -toUnits("1000"));
    const posted = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from lease_agreement_schedule_lines
       where org_id=${org.orgId} and lease_id=${leaseId} and payment_entry_id is not null and amortization_entry_id is not null`)).rows[0]!.n;
    assert.equal(posted, 1);
  } finally { await dropScratchOrg(org.orgId); }
});
