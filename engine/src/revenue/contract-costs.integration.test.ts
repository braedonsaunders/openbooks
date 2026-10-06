import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  seedFlowActors,
  seedPostingAccount,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { daysInCivilMonth } from "../platform/civil-date.ts";
import {
  assetCarryingMinor,
  capitalizeContractCost,
  projectAmortizationSchedule,
  recognizeContractCostImpairment,
  runContractCostAmortization,
} from "./contract-costs.ts";
import type { FlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

interface CostWorld {
  org: ScratchOrg;
  actors: FlowActors;
  /** Day-to-day operator: holds contract_costs.read + manage, never approve. */
  managerId: string;
  /** Reviewer: holds contract_costs.read + approve, never manage. */
  approverId: string;
  assetAccountId: string;
  expenseAccountId: string;
  commissionExpenseAccountId: string;
  repPartyId: string;
}

/** Scratch tenant with the contract-costs gate open and a working policy. */
async function setupCostWorld(options: { expedient?: boolean } = {}): Promise<CostWorld> {
  const org = await createScratchOrg();
  const actors = await seedFlowActors(org.orgId);
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(settings, '{features,contractCosts}', 'true'::jsonb, true)
     where id = ${org.orgId}`);
  const assetAccountId = await seedPostingAccount(
    org.orgId, "1400", "Capitalized Contract Costs", "asset_current_other",
  );
  const expenseAccountId = await seedPostingAccount(
    org.orgId, "6100", "Commission Amortization", "expense",
  );
  const commissionExpenseAccountId = await seedPostingAccount(
    org.orgId, "6110", "Commission Expense", "expense",
  );
  await db.execute(sql`
    insert into contract_cost_policies
      (id, org_id, effective_from, capitalize_commissions, capitalize_fulfilment,
       practical_expedient, basis, customer_life_source, customer_life_months,
       renewal_commensurate_threshold_percent, asset_account_id,
       amortization_expense_account_id, created_by, updated_by)
    values (${randomUUID()}, ${org.orgId}, '2026-01-01', true, false,
      ${options.expedient ?? false}, 'contract_term', 'manual', null,
      '50.0000', ${assetAccountId}, ${expenseAccountId},
      ${actors.adminId}, ${actors.adminId})`);
  const repPartyId = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, custom)
    values (${repPartyId}, ${org.orgId}, 'person', 'Casey Closer', true, '{}'::jsonb)`);
  // Duty-split actors through live grants: the manager capitalizes and runs
  // amortization, the approver recognizes impairment, neither does both.
  const managerId = await createScratchUser(org.orgId, "Cost Manager", "cc_manager");
  await db.execute(sql`
    update app_roles
       set permissions = '["contract_costs.read", "contract_costs.manage"]'::jsonb
     where org_id = ${org.orgId} and key = 'cc_manager'`);
  const approverId = await createScratchUser(org.orgId, "Cost Approver", "cc_approver");
  await db.execute(sql`
    update app_roles
       set permissions = '["contract_costs.read", "contract_costs.approve"]'::jsonb
     where org_id = ${org.orgId} and key = 'cc_approver'`);
  return { org, actors, managerId, approverId, assetAccountId, expenseAccountId, commissionExpenseAccountId, repPartyId };
}

async function seedContract(
  world: CostWorld,
  options: { number: string; startsOn: string; endsOn: string },
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into revenue_contracts
      (id, org_id, customer_id, contract_number, status, starts_on, ends_on,
       currency, total_transaction_price, created_by, updated_by)
    values (${id}, ${world.org.orgId}, ${world.org.customerId}, ${options.number}, 'active',
      ${options.startsOn}, ${options.endsOn}, 'CAD', '12000',
      ${world.actors.adminId}, ${world.actors.adminId})`);
  return id;
}

/** Seed one open monthly period per given month start (scratch ships July only). */
async function seedPeriods(orgId: string, monthStarts: string[]): Promise<Map<string, string>> {
  const cal = (await db.execute<{ id: string }>(sql`
    select id from fiscal_calendars where org_id = ${orgId} and is_default`)).rows[0];
  assert.ok(cal, "scratch org ships a default fiscal calendar");
  const ids = new Map<string, string>();
  for (const month of monthStarts) {
    const id = randomUUID();
    const year = Number(month.slice(0, 4));
    const mon = Number(month.slice(5, 7));
    const lastDay = daysInCivilMonth(year, mon);
    const name = month.slice(0, 7);
    await db.execute(sql`
      insert into accounting_periods
        (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${id}, ${orgId}, ${year}, ${mon}, ${name},
        ${`${name}-01`}, ${`${name}-${String(lastDay).padStart(2, "0")}`}, false, ${cal.id})
      on conflict do nothing`);
    const row = (await db.execute<{ id: string }>(sql`
      select id from accounting_periods where org_id = ${orgId} and name = ${name}`)).rows[0];
    assert.ok(row, `period ${name} exists after seeding`);
    ids.set(name, row.id);
  }
  return ids;
}

async function entryBalance(entryId: string): Promise<{ lines: number; balanced: boolean }> {
  const rows = (await db.execute<{ lines: string; balanced: boolean }>(sql`
    select count(*)::text as lines, coalesce(sum(jl.amount), 0) = 0 as balanced
      from journal_lines jl
      join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
     where jl.entry_id = ${entryId}
       and je.status in ('posted', 'reversed')`)).rows[0]!;
  return { lines: Number(rows.lines), balanced: rows.balanced };
}

test(
  "straight-line capitalization amortizes to the exact minor-unit total",
  { skip: !DB },
  async () => {
    const world = await setupCostWorld();
    try {
      const contractId = await seedContract(world, {
        number: "C-STRAIGHT",
        startsOn: "2026-07-01",
        endsOn: "2026-09-30",
      });
      const cap = await capitalizeContractCost({
        orgId: world.org.orgId,
        actorId: world.managerId,
        revenueContractId: contractId,
        repPartyId: world.repPartyId,
        customerPartyId: world.org.customerId,
        costType: "commission",
        amountMinor: 100000n,
        currency: "CAD",
        capitalizedOn: "2026-07-15",
        method: "straight_line",
        originalExpenseAccountId: world.commissionExpenseAccountId,
        source: { kind: "manual" },
      });
      assert.equal(cap.status, "active");
      assert.deepEqual(cap.months, ["2026-07", "2026-08", "2026-09"]);
      assert.deepEqual(cap.scheduleMinor, ["33334", "33333", "33333"]);
      assert.ok(cap.capitalizeEntryId, "a capitalized cost carries its journal entry");
      const capBalance = await entryBalance(cap.capitalizeEntryId);
      assert.equal(capBalance.lines, 2);
      assert.equal(capBalance.balanced, true, "the capitalization entry balances");

      const periods = await seedPeriods(world.org.orgId, ["2026-08-01", "2026-09-01"]);
      for (const name of ["2026-07", "2026-08", "2026-09"] as const) {
        const periodId = name === "2026-07"
          ? world.org.periodId
          : periods.get(name);
        assert.ok(periodId, `period ${name} is seeded`);
        const run = await runContractCostAmortization({
          orgId: world.org.orgId,
          actorId: world.managerId,
          periodId,
        });
        assert.equal(run.posted, 1, `period ${name} posts one amortization`);
        assert.deepEqual(run.problems, []);
        assert.equal(run.entries.length, 1, `period ${name} returns its amortization entry`);
        const balance = await entryBalance(run.entries[0]!.entryId);
        assert.equal(balance.lines, 2);
        assert.equal(balance.balanced, true, `period ${name} amortization entry balances`);
      }
      const posted = (await db.execute<{ total: string }>(sql`
        select coalesce(sum(amount_minor), 0)::text as total
          from contract_cost_amortization where org_id = ${world.org.orgId}`)).rows[0]!;
      assert.equal(posted.total, "100000");
      assert.equal(await assetCarryingMinor(db, world.org.orgId, cap.assetId), 0n);
      const status = (await db.execute<{ status: string }>(sql`
        select status from contract_cost_assets
         where org_id = ${world.org.orgId} and id = ${cap.assetId}`)).rows[0]!;
      assert.equal(status.status, "fully_amortized");
    } finally {
      await dropScratchOrgReporting(world.org.orgId);
    }
  },
);

test(
  "a renewal commission below the threshold amortizes over the customer life",
  { skip: !DB },
  async () => {
    const world = await setupCostWorld();
    try {
      await db.execute(sql`
        update contract_cost_policies
           set basis = 'customer_life', customer_life_source = 'manual',
               customer_life_months = 24
         where org_id = ${world.org.orgId}`);
      const contractId = await seedContract(world, {
        number: "C-LIFE",
        startsOn: "2026-07-01",
        endsOn: "2027-06-30",
      });
      const cap = await capitalizeContractCost({
        orgId: world.org.orgId,
        actorId: world.managerId,
        revenueContractId: contractId,
        repPartyId: world.repPartyId,
        customerPartyId: world.org.customerId,
        costType: "commission",
        amountMinor: 240000n,
        currency: "CAD",
        capitalizedOn: "2026-07-15",
        method: "straight_line",
        originalExpenseAccountId: world.commissionExpenseAccountId,
        renewalCommissionMinor: 24000n,
        source: { kind: "manual" },
      });
      assert.equal(cap.status, "active");
      assert.equal(cap.months.length, 24);
      assert.equal(cap.months[0], "2026-07");
      assert.equal(cap.months[23], "2028-06");
      const total = cap.scheduleMinor.reduce((acc, m) => acc + BigInt(m), 0n);
      assert.equal(total, 240000n);
    } finally {
      await dropScratchOrgReporting(world.org.orgId);
    }
  },
);

test(
  "a commensurate renewal commission amortizes over the contract term",
  { skip: !DB },
  async () => {
    const world = await setupCostWorld();
    try {
      await db.execute(sql`
        update contract_cost_policies
           set basis = 'customer_life', customer_life_source = 'manual',
               customer_life_months = 24
         where org_id = ${world.org.orgId}`);
      const contractId = await seedContract(world, {
        number: "C-COMMENSURATE",
        startsOn: "2026-07-01",
        endsOn: "2027-06-30",
      });
      const cap = await capitalizeContractCost({
        orgId: world.org.orgId,
        actorId: world.managerId,
        revenueContractId: contractId,
        repPartyId: world.repPartyId,
        customerPartyId: world.org.customerId,
        costType: "commission",
        amountMinor: 240000n,
        currency: "CAD",
        capitalizedOn: "2026-07-15",
        method: "straight_line",
        originalExpenseAccountId: world.commissionExpenseAccountId,
        renewalCommissionMinor: 240000n,
        source: { kind: "manual" },
      });
      assert.equal(cap.status, "active");
      assert.deepEqual(cap.months[0], "2026-07");
      assert.equal(cap.months.length, 12);
    } finally {
      await dropScratchOrgReporting(world.org.orgId);
    }
  },
);

test(
  "the one-year practical expedient expenses immediately with no journal",
  { skip: !DB },
  async () => {
    const world = await setupCostWorld({ expedient: true });
    try {
      const contractId = await seedContract(world, {
        number: "C-EXPEDIENT",
        startsOn: "2026-07-01",
        endsOn: "2027-06-30",
      });
      const cap = await capitalizeContractCost({
        orgId: world.org.orgId,
        actorId: world.managerId,
        revenueContractId: contractId,
        repPartyId: world.repPartyId,
        customerPartyId: world.org.customerId,
        costType: "commission",
        amountMinor: 120000n,
        currency: "CAD",
        capitalizedOn: "2026-07-15",
        method: "straight_line",
        originalExpenseAccountId: world.commissionExpenseAccountId,
        source: { kind: "manual" },
      });
      assert.equal(cap.status, "expensed");
      assert.equal(cap.capitalizeEntryId, null);
      const journals = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from journal_entries
         where org_id = ${world.org.orgId} and origin like 'contract_cost%'`)).rows[0]!;
      assert.equal(journals.n, "0");
    } finally {
      await dropScratchOrgReporting(world.org.orgId);
    }
  },
);

test(
  "impairment refuses without approval and posts with it",
  { skip: !DB },
  async () => {
    const world = await setupCostWorld();
    try {
      const contractId = await seedContract(world, {
        number: "C-IMPAIR",
        startsOn: "2026-07-01",
        endsOn: "2028-06-30",
      });
      const cap = await capitalizeContractCost({
        orgId: world.org.orgId,
        actorId: world.managerId,
        revenueContractId: contractId,
        repPartyId: world.repPartyId,
        customerPartyId: world.org.customerId,
        costType: "commission",
        amountMinor: 240000n,
        currency: "CAD",
        capitalizedOn: "2026-07-15",
        method: "straight_line",
        originalExpenseAccountId: world.commissionExpenseAccountId,
        source: { kind: "manual" },
      });
      await runContractCostAmortization({
        orgId: world.org.orgId,
        actorId: world.managerId,
        periodId: world.org.periodId,
      });
      assert.equal(await assetCarryingMinor(db, world.org.orgId, cap.assetId), 230000n);

      await assert.rejects(
        recognizeContractCostImpairment({
          orgId: world.org.orgId,
          actorId: world.managerId,
          assetId: cap.assetId,
          remainingConsiderationMinor: 100000n,
          costsNotYetRecognizedMinor: 0n,
          reason: "Customer churned after month one",
          assessedOn: "2026-07-20",
        }),
        /approve/im,
        "impairment without approval names the approval remedy",
      );

      const result = await recognizeContractCostImpairment({
        orgId: world.org.orgId,
        actorId: world.approverId,
        assetId: cap.assetId,
        remainingConsiderationMinor: 100000n,
        costsNotYetRecognizedMinor: 0n,
        reason: "Customer churned after month one",
        assessedOn: "2026-07-20",
      });
      assert.equal(result.posted, true);
      assert.equal(result.impairmentMinor, "130000");
      assert.ok(result.entryId, "a posted impairment carries its journal entry");
      const balance = await entryBalance(result.entryId);
      assert.equal(balance.balanced, true, "the impairment entry balances");
      assert.equal(await assetCarryingMinor(db, world.org.orgId, cap.assetId), 100000n);
      const status = (await db.execute<{ status: string }>(sql`
        select status from contract_cost_assets
         where org_id = ${world.org.orgId} and id = ${cap.assetId}`)).rows[0]!;
      assert.equal(status.status, "impaired");
    } finally {
      await dropScratchOrgReporting(world.org.orgId);
    }
  },
);

test(
  "an amortization run is idempotent per asset and period",
  { skip: !DB },
  async () => {
    const world = await setupCostWorld();
    try {
      const contractId = await seedContract(world, {
        number: "C-IDEMPOTENT",
        startsOn: "2026-07-01",
        endsOn: "2028-06-30",
      });
      await capitalizeContractCost({
        orgId: world.org.orgId,
        actorId: world.managerId,
        revenueContractId: contractId,
        repPartyId: world.repPartyId,
        customerPartyId: world.org.customerId,
        costType: "commission",
        amountMinor: 240000n,
        currency: "CAD",
        capitalizedOn: "2026-07-15",
        method: "straight_line",
        originalExpenseAccountId: world.commissionExpenseAccountId,
        source: { kind: "manual" },
      });
      const first = await runContractCostAmortization({
        orgId: world.org.orgId,
        actorId: world.managerId,
        periodId: world.org.periodId,
      });
      assert.equal(first.posted, 1);
      const second = await runContractCostAmortization({
        orgId: world.org.orgId,
        actorId: world.managerId,
        periodId: world.org.periodId,
      });
      assert.equal(second.posted, 0);
      assert.equal(second.skipped, 1);
      const rows = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n from contract_cost_amortization
         where org_id = ${world.org.orgId}`)).rows[0]!;
      assert.equal(rows.n, "1");
    } finally {
      await dropScratchOrgReporting(world.org.orgId);
    }
  },
);

test("the projected schedule sums exactly to the capitalized cost", () => {
  const schedule = projectAmortizationSchedule(100000n, 3);
  assert.deepEqual(schedule, [33334n, 33333n, 33333n]);
  assert.equal(schedule.reduce((acc, m) => acc + m, 0n), 100000n);
});
