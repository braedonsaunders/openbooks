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

for (const phase of ["commencement", "payment"] as const) {
  for (const restriction of ["account", "location", "inactive entity", "allowed descendant"] as const) {
    test(`lease ${phase} enforces ${restriction} posting scope`, { skip: !DB }, async () => {
      const org = await createScratchOrg();
      try {
        const accounts = await seedLeaseAccounts(org);
        const branchId = randomUUID();
        await db.execute(sql`
          insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
          values(${branchId},${org.orgId},${org.subsidiaryId},'Lease branch','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb)`);
        const allowed = restriction === "allowed descendant";
        const subsidiaryId = allowed || restriction === "inactive entity" ? branchId : org.subsidiaryId;
        const { leaseId } = await createLeaseAgreement(org.orgId, null, {
          subsidiaryId, leaseNumber: "LEASE-SCOPE", commencementOn: "2026-07-01",
          termPeriods: 3, paymentFrequency: "monthly", paymentAmount: "1000",
          annualDiscountRatePercent: "6", classificationInputs: { transfersOwnership: true },
          accounts, locationId: org.locationId,
        });
        if (phase === "payment") await commenceLease(org.orgId, leaseId, null);
        const accountId = phase === "commencement" ? accounts.rouAsset : accounts.payment;
        if (restriction === "account" || allowed) {
          await db.execute(sql`update accounts set subsidiary_id=${allowed ? org.subsidiaryId : branchId},
            subsidiary_include_children=${allowed} where org_id=${org.orgId} and id=${accountId}`);
        } else if (restriction === "location") {
          await db.execute(sql`update locations set subsidiary_id=${branchId},subsidiary_include_children=false
            where org_id=${org.orgId} and id=${org.locationId}`);
        } else {
          await db.execute(sql`update subsidiaries set is_active=false where org_id=${org.orgId} and id=${subsidiaryId}`);
        }
        const run = () => phase === "commencement"
          ? commenceLease(org.orgId, leaseId, null)
          : postDueLeaseSchedules(org.orgId, "2026-07-31", null);
        if (allowed) {
          await run();
        } else {
          await assert.rejects(run, /restricted to another subsidiary|inactive/);
          const count = (await db.execute<{ n: number }>(sql`
            select count(*)::int as n from journal_entries where org_id=${org.orgId} and origin='lease'`)).rows[0]!.n;
          assert.equal(count, phase === "commencement" ? 0 : 1, "refusal leaves no partial journal");
          await db.execute(sql`update accounts set subsidiary_id=null where org_id=${org.orgId} and id=${accountId}`);
          await db.execute(sql`update locations set subsidiary_id=null where org_id=${org.orgId} and id=${org.locationId}`);
          await db.execute(sql`update subsidiaries set is_active=true where org_id=${org.orgId} and id=${subsidiaryId}`);
          await run();
        }
        const lease = (await db.execute<{ status: string }>(sql`
          select status from lease_agreements where org_id=${org.orgId} and id=${leaseId}`)).rows[0]!;
        assert.equal(lease.status, "active");
      } finally { await dropScratchOrg(org.orgId); }
    });
  }
}

test("lease posting rechecks account scope after a concurrent restriction edit commits", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const writer = await pool.connect();
  let pending: Promise<PromiseSettledResult<Awaited<ReturnType<typeof commenceLease>>>> | undefined;
  try {
    const accounts = await seedLeaseAccounts(org);
    const branchId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
      values(${branchId},${org.orgId},${org.subsidiaryId},'Restriction owner','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb)`);
    const { leaseId } = await createLeaseAgreement(org.orgId, null, {
      subsidiaryId: org.subsidiaryId, leaseNumber: "LEASE-SCOPE-RACE", commencementOn: "2026-07-01",
      termPeriods: 3, paymentFrequency: "monthly", paymentAmount: "1000", annualDiscountRatePercent: "6",
      classificationInputs: { transfersOwnership: true }, accounts,
    });
    await writer.query("begin");
    await writer.query("select set_config('app.bypass_rls','on',true)");
    await writer.query("update accounts set subsidiary_id=$1,subsidiary_include_children=false where org_id=$2 and id=$3", [branchId, org.orgId, accounts.rouAsset]);
    const pid = (await writer.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
    pending = commenceLease(org.orgId, leaseId, null).then(
      (value) => ({ status: "fulfilled", value }),
      (reason: unknown) => ({ status: "rejected", reason }),
    );
    let blocked = false;
    for (let attempt = 0; attempt < 400; attempt++) {
      const count = (await pool.query<{ n: number }>(
        "select count(*)::int as n from pg_stat_activity where $1::int=any(pg_blocking_pids(pid))", [pid],
      )).rows[0]!.n;
      if (count) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(blocked, "posting must wait for the authoritative account edit");
    await writer.query("commit");
    const outcome = await pending;
    assert.equal(outcome.status, "rejected");
    if (outcome.status === "rejected") assert.match(String(outcome.reason), /restricted to another subsidiary/);
    const count = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries where org_id=${org.orgId} and origin='lease'`)).rows[0]!.n;
    assert.equal(count, 0);
  } finally {
    await writer.query("rollback");
    writer.release();
    await pending;
    await dropScratchOrg(org.orgId);
  }
});

for (const phase of ["commencement", "payment"] as const) {
  for (const flag of ["is_active", "posts_gl"] as const) {
    test(`lease ${phase} refuses a primary book with ${flag} disabled`, { skip: !DB }, async () => {
      const org = await createScratchOrg();
      try {
        const accounts = await seedLeaseAccounts(org);
        const { leaseId } = await createLeaseAgreement(org.orgId, null, {
          subsidiaryId: org.subsidiaryId, leaseNumber: "LEASE-BOOK-POLICY",
          commencementOn: "2026-07-01", termPeriods: 3, paymentFrequency: "monthly",
          paymentAmount: "1000", annualDiscountRatePercent: "6",
          classificationInputs: { transfersOwnership: true }, accounts,
        });
        if (phase === "payment") await commenceLease(org.orgId, leaseId, null);
        await db.execute(sql`update accounting_books set ${sql.raw(flag)}=false
          where org_id=${org.orgId} and id=${org.bookId}`);
        const run = () => phase === "commencement"
          ? commenceLease(org.orgId, leaseId, null)
          : postDueLeaseSchedules(org.orgId, "2026-07-31", null);
        await assert.rejects(run(), /active primary posting book/);
        const state = (await db.execute<{ status: string; journals: number; claimed: number }>(sql`
          select status,(select count(*)::int from journal_entries where org_id=${org.orgId}) as journals,
            (select count(*)::int from lease_agreement_schedule_lines where org_id=${org.orgId}
              and lease_id=${leaseId} and payment_entry_id is not null) as claimed
          from lease_agreements where org_id=${org.orgId} and id=${leaseId}`)).rows[0]!;
        assert.deepEqual(state,{status:phase === "payment" ? "active" : "draft",journals:phase === "payment" ? 1 : 0,claimed:0});
        await db.execute(sql`update accounting_books set ${sql.raw(flag)}=true
          where org_id=${org.orgId} and id=${org.bookId}`);
        await run();
      } finally { await dropScratchOrg(org.orgId); }
    });
  }
}
