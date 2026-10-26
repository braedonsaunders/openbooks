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
  contractCostAttentionItems,
  ContractCostError,
  importCommissionCosts,
  linkContractCostAsset,
  projectAmortizationSchedule,
  recognizeContractCostImpairment,
  runContractCostAmortization,
  scheduleForAsset,
} from "./contract-costs.ts";
import type { FlowActors } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test(
  "contract-cost attention respects the caller's subsidiary visibility",
  { skip: !DB },
  async () => {
    const world = await setupCostWorld();
    try {
      const asset = await capitalizeContractCost({
        orgId: world.org.orgId,
        actorId: world.managerId,
        revenueContractId: null,
        repPartyId: world.repPartyId,
        customerPartyId: world.org.customerId,
        costType: "commission",
        amountMinor: 10000n,
        currency: "CAD",
        capitalizedOn: world.org.date,
        method: "straight_line",
        originalExpenseAccountId: world.commissionExpenseAccountId,
        source: { kind: "import" },
      });

      const unrestricted = await contractCostAttentionItems(db, world.org.orgId);
      const restricted = await contractCostAttentionItems(db, world.org.orgId, new Set());
      assert.ok(unrestricted.some((item) => item.assetId === asset.assetId));
      assert.ok(!restricted.some((item) => item.assetId === asset.assetId));
    } finally {
      await dropScratchOrgReporting(world.org.orgId);
    }
  },
);

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
    org.orgId,
    "1400",
    "Capitalized Contract Costs",
    "asset_current_other",
  );
  const expenseAccountId = await seedPostingAccount(
    org.orgId,
    "6100",
    "Commission Amortization",
    "expense",
  );
  const commissionExpenseAccountId = await seedPostingAccount(
    org.orgId,
    "6110",
    "Commission Expense",
    "expense",
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
  return {
    org,
    actors,
    managerId,
    approverId,
    assetAccountId,
    expenseAccountId,
    commissionExpenseAccountId,
    repPartyId,
  };
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
  const cal = (
    await db.execute<{ id: string }>(
      sql`
    select id from fiscal_calendars where org_id = ${orgId} and is_default`,
      "objects",
    )
  )[0];
  assert.ok(cal, "scratch org ships a default fiscal calendar");
  const ids = new Map<string, string>();
  assert.ok(monthStarts.length > 0, "at least one fiscal period is requested");
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
    const row = (
      await db.execute<{ id: string }>(
        sql`
      select id from accounting_periods where org_id = ${orgId} and name = ${name}`,
        "objects",
      )
    )[0];
    assert.ok(row, `period ${name} exists after seeding`);
    ids.set(name, row.id);
  }
  return ids;
}

async function entryBalance(entryId: string): Promise<{ lines: number; balanced: boolean }> {
  const rows = (
    await db.execute<{ lines: string; balanced: boolean }>(
      sql`
    select count(*)::text as lines, coalesce(sum(jl.amount), 0) = 0 as balanced
      from journal_lines jl
      join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
     where jl.entry_id = ${entryId}
       and je.status in ('posted', 'reversed')`,
      "objects",
    )
  )[0]!;
  return { lines: Number(rows.lines), balanced: rows.balanced };
}

test(
  "contract-cost capitalization and amortization authorize and post in the contract subsidiary",
  { skip: !DB },
  async () => {
    const world = await setupCostWorld();
    try {
      const subsidiaryId = randomUUID();
      await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      values (${subsidiaryId}, ${world.org.orgId}, ${world.org.subsidiaryId}, 'Contract Cost Branch', 'CAD', 'CA')
    `);
      const contractId = await seedContract(world, {
        number: "C-ENTITY-COST",
        startsOn: "2026-07-01",
        endsOn: "2026-09-30",
      });
      await db.execute(sql`
      update revenue_contracts set subsidiary_id = ${subsidiaryId}
       where org_id = ${world.org.orgId} and id = ${contractId}
    `);
      await db.execute(sql`
      update app_roles
         set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [world.org.subsidiaryId] })}::jsonb
       where org_id = ${world.org.orgId} and key = 'cc_manager'
    `);

      const input = {
        orgId: world.org.orgId,
        actorId: world.managerId,
        revenueContractId: contractId,
        repPartyId: world.repPartyId,
        customerPartyId: world.org.customerId,
        costType: "commission" as const,
        amountMinor: 90000n,
        currency: "CAD",
        capitalizedOn: "2026-07-15",
        method: "straight_line" as const,
        originalExpenseAccountId: world.commissionExpenseAccountId,
        source: { kind: "manual" as const },
      };
      await assert.rejects(capitalizeContractCost(input), (error: unknown) => {
        assert.ok(error instanceof ContractCostError);
        assert.equal(error.status, 403);
        assert.equal(error.code, "contract_cost_forbidden");
        return true;
      });

      await db.execute(sql`
      update app_roles
         set subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [subsidiaryId] })}::jsonb
       where org_id = ${world.org.orgId} and key = 'cc_manager'
    `);
      const capitalized = await capitalizeContractCost(input);
      assert.ok(capitalized.capitalizeEntryId);
      const capitalization = (
        await db.execute<{ subsidiary_id: string }>(
          sql`
      select subsidiary_id from journal_entries where org_id = ${world.org.orgId} and id = ${capitalized.capitalizeEntryId}
    `,
          "objects",
        )
      )[0];
      assert.equal(capitalization?.subsidiary_id, subsidiaryId);

      const periods = await seedPeriods(world.org.orgId, ["2026-07"]);
      const amortization = await runContractCostAmortization({
        orgId: world.org.orgId,
        actorId: world.managerId,
        periodId: periods.get("2026-07")!,
      });
      assert.equal(amortization.posted, 1);
      const posted = (
        await db.execute<{ subsidiary_id: string }>(
          sql`
      select subsidiary_id
        from journal_entries
       where org_id = ${world.org.orgId} and id = ${amortization.entries[0]!.entryId}
    `,
          "objects",
        )
      )[0];
      assert.equal(posted?.subsidiary_id, subsidiaryId);
    } finally {
      await dropScratchOrgReporting(world.org.orgId);
    }
  },
);

test(
  "contract cost carrying uses the primary book and unlinked assets retain their source amount",
  { skip: !DB },
  async () => {
    const world = await setupCostWorld();
    try {
      const unlinked = await capitalizeContractCost({
        orgId: world.org.orgId,
        actorId: world.managerId,
        repPartyId: world.repPartyId,
        customerPartyId: world.org.customerId,
        costType: "commission",
        amountMinor: 120000n,
        currency: "CAD",
        capitalizedOn: "2026-07-15",
        originalExpenseAccountId: world.commissionExpenseAccountId,
        source: { kind: "manual" },
      });
      assert.equal(unlinked.capitalizeEntryId, null);
      const attention = await contractCostAttentionItems(db, world.org.orgId);
      assert.equal(
        attention.find((item) => item.assetId === unlinked.assetId)?.carryingMinor,
        "120000",
      );

      const contractId = await seedContract(world, {
        number: "C-PRIMARY-BOOK",
        startsOn: "2026-07-01",
        endsOn: "2026-09-30",
      });
      const capitalized = await capitalizeContractCost({
        orgId: world.org.orgId,
        actorId: world.managerId,
        revenueContractId: contractId,
        repPartyId: world.repPartyId,
        customerPartyId: world.org.customerId,
        costType: "commission",
        amountMinor: 100000n,
        currency: "CAD",
        capitalizedOn: "2026-07-15",
        originalExpenseAccountId: world.commissionExpenseAccountId,
        source: { kind: "manual" },
      });
      assert.ok(capitalized.capitalizeEntryId);
      const primaryCarrying = await assetCarryingMinor(db, world.org.orgId, capitalized.assetId);
      assert.equal(primaryCarrying, 100000n);

      const secondaryBookId = (
        await db.execute<{ id: string }>(
          sql`
        insert into accounting_books
          (org_id, code, name, is_primary, is_active, posts_gl, created_by, updated_by)
        values (${world.org.orgId}, 'CC-SECONDARY', 'Contract cost secondary', false, true, true,
          ${world.actors.adminId}, ${world.actors.adminId})
        returning id`,
          "objects",
        )
      )[0]?.id;
      assert.ok(secondaryBookId);
      const secondaryEntryId = randomUUID();
      await db.execute(sql`
        insert into journal_entries
          (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id,
           memo, origin, custom, created_by, updated_by)
        select ${secondaryEntryId}, org_id, ${secondaryBookId}, subsidiary_id,
               ${`CC-SECONDARY-${secondaryEntryId}`}, posting_date, period_id,
               memo, origin,
               (custom - 'idempotencyKey') || jsonb_build_object(
                 'idempotencyKey', ${`contract-cost:secondary-book:${secondaryEntryId}`}::text
               )::jsonb,
               created_by, updated_by
          from journal_entries
         where org_id = ${world.org.orgId} and id = ${capitalized.capitalizeEntryId}`);
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
           currency, txn_amount, contributor_kind, contributor_ref)
        select org_id, ${secondaryEntryId}, line_number, account_id, subsidiary_id,
               amount, currency, txn_amount, contributor_kind, contributor_ref
          from journal_lines
         where org_id = ${world.org.orgId} and entry_id = ${capitalized.capitalizeEntryId}`);
      await db.execute(sql`
        update journal_entries
           set status = 'posted', posted_at = now(), posted_by = ${world.managerId}
         where org_id = ${world.org.orgId} and id = ${secondaryEntryId}`);

      assert.equal(
        await assetCarryingMinor(db, world.org.orgId, capitalized.assetId),
        primaryCarrying,
        "a replica in a secondary book does not change primary carrying value",
      );
    } finally {
      await dropScratchOrgReporting(world.org.orgId);
    }
  },
);

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
        const periodId = name === "2026-07" ? world.org.periodId : periods.get(name);
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
      const posted = (
        await db.execute<{ total: string }>(
          sql`
        select coalesce(sum(amount_minor), 0)::text as total
          from contract_cost_amortization where org_id = ${world.org.orgId}`,
          "objects",
        )
      )[0]!;
      assert.equal(posted.total, "100000");
      assert.equal(await assetCarryingMinor(db, world.org.orgId, cap.assetId), 0n);
      const status = (
        await db.execute<{ status: string }>(
          sql`
        select status from contract_cost_assets
         where org_id = ${world.org.orgId} and id = ${cap.assetId}`,
          "objects",
        )
      )[0]!;
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
      const journals = (
        await db.execute<{ n: string }>(
          sql`
        select count(*)::text as n from journal_entries
         where org_id = ${world.org.orgId} and origin like 'contract_cost%'`,
          "objects",
        )
      )[0]!;
      assert.equal(journals.n, "0");
    } finally {
      await dropScratchOrgReporting(world.org.orgId);
    }
  },
);

test("impairment refuses without approval and posts with it", { skip: !DB }, async () => {
  const world = await setupCostWorld();
  try {
    const contractId = await seedContract(world, {
      number: "C-IMPAIR",
      startsOn: "2026-07-01",
      endsOn: "2028-06-30",
    });
    const periods = await seedPeriods(world.org.orgId, ["2026-08-01"]);
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
    const status = (
      await db.execute<{ status: string }>(
        sql`
        select status from contract_cost_assets
         where org_id = ${world.org.orgId} and id = ${cap.assetId}`,
        "objects",
      )
    )[0]!;
    assert.equal(status.status, "active", "a remaining carrying balance stays amortizable");
    const schedule = await scheduleForAsset(db, world.org.orgId, cap.assetId);
    assert.equal(
      schedule.find((line) => line.month === "2026-08")?.amountMinor,
      4348n,
      "the recoverable balance is re-spread over the remaining unposted months",
    );
    const nextMonth = await runContractCostAmortization({
      orgId: world.org.orgId,
      actorId: world.managerId,
      periodId: periods.get("2026-08")!,
    });
    assert.equal(nextMonth.posted, 1);
    assert.equal(nextMonth.entries[0]?.amountMinor, "4348");
    assert.equal(await assetCarryingMinor(db, world.org.orgId, cap.assetId), 95652n);
  } finally {
    await dropScratchOrgReporting(world.org.orgId);
  }
});

test(
  "late links honor cost capitalization policy and the one-year expedient",
  { skip: !DB },
  async () => {
    const world = await setupCostWorld();
    try {
      const longContract = await seedContract(world, {
        number: "C-LINK-EXCLUDED",
        startsOn: "2026-07-01",
        endsOn: "2028-06-30",
      });
      const excluded = await capitalizeContractCost({
        orgId: world.org.orgId,
        actorId: world.managerId,
        revenueContractId: null,
        repPartyId: world.repPartyId,
        customerPartyId: world.org.customerId,
        costType: "commission",
        amountMinor: 10000n,
        currency: "CAD",
        capitalizedOn: "2026-07-15",
        method: "straight_line",
        originalExpenseAccountId: world.commissionExpenseAccountId,
        source: { kind: "import" },
      });
      await db.execute(sql`
        update contract_cost_policies set capitalize_commissions = false
         where org_id = ${world.org.orgId}`);
      await linkContractCostAsset({
        orgId: world.org.orgId,
        actorId: world.managerId,
        assetId: excluded.assetId,
        revenueContractId: longContract,
      });
      const excludedRow = (
        await db.execute<{ status: string; revenue_contract_id: string | null }>(
          sql`
        select status, revenue_contract_id from contract_cost_assets
         where org_id = ${world.org.orgId} and id = ${excluded.assetId}`,
          "objects",
        )
      )[0]!;
      assert.equal(excludedRow.status, "expensed");
      assert.equal(excludedRow.revenue_contract_id, longContract);

      const shortContract = await seedContract(world, {
        number: "C-LINK-EXPEDIENT",
        startsOn: "2026-07-01",
        endsOn: "2026-12-31",
      });
      const expedientAsset = await capitalizeContractCost({
        orgId: world.org.orgId,
        actorId: world.managerId,
        revenueContractId: null,
        repPartyId: world.repPartyId,
        customerPartyId: world.org.customerId,
        costType: "commission",
        amountMinor: 10000n,
        currency: "CAD",
        capitalizedOn: "2026-07-15",
        method: "straight_line",
        originalExpenseAccountId: world.commissionExpenseAccountId,
        source: { kind: "import" },
      });
      await db.execute(sql`
        update contract_cost_policies
           set capitalize_commissions = true, practical_expedient = true
         where org_id = ${world.org.orgId}`);
      await linkContractCostAsset({
        orgId: world.org.orgId,
        actorId: world.managerId,
        assetId: expedientAsset.assetId,
        revenueContractId: shortContract,
      });
      const expedientRow = (
        await db.execute<{ status: string }>(
          sql`
        select status from contract_cost_assets
         where org_id = ${world.org.orgId} and id = ${expedientAsset.assetId}`,
          "objects",
        )
      )[0]!;
      assert.equal(expedientRow.status, "expensed");
      const journals = (
        await db.execute<{ count: string }>(
          sql`
        select count(*)::text as count from journal_entries
         where org_id = ${world.org.orgId} and origin = 'contract_cost_capitalize'`,
          "objects",
        )
      )[0]!;
      assert.equal(
        journals.count,
        "0",
        "policy and expedient refusals do not post capitalization journals",
      );
    } finally {
      await dropScratchOrgReporting(world.org.orgId);
    }
  },
);

test(
  "a failed imported commission row rolls back without poisoning its siblings",
  { skip: !DB },
  async () => {
    const world = await setupCostWorld();
    try {
      const contractId = await seedContract(world, {
        number: "C-IMPORT-SAVEPOINT",
        startsOn: "2026-07-01",
        endsOn: "2028-06-30",
      });
      const result = await importCommissionCosts({
        orgId: world.org.orgId,
        actorId: world.managerId,
        rows: [
          {
            repPartyId: randomUUID(),
            contractNumber: "C-IMPORT-SAVEPOINT",
            amountMinor: 10000n,
            currency: "CAD",
            date: "2026-07-15",
            originalExpenseAccountId: world.commissionExpenseAccountId,
            ref: "batch row 1",
          },
          {
            repPartyId: world.repPartyId,
            contractNumber: "C-IMPORT-SAVEPOINT",
            amountMinor: 12000n,
            currency: "CAD",
            date: "2026-07-15",
            originalExpenseAccountId: world.commissionExpenseAccountId,
            ref: "batch row 2",
          },
        ],
      });
      assert.equal(result[0]?.ok, false);
      assert.equal(result[1]?.ok, true);
      const assets = (
        await db.execute<{ count: string }>(
          sql`
        select count(*)::text as count from contract_cost_assets
         where org_id = ${world.org.orgId} and revenue_contract_id = ${contractId}`,
          "objects",
        )
      )[0]!;
      assert.equal(
        assets.count,
        "1",
        "the failed row leaves no asset and the valid sibling commits",
      );
    } finally {
      await dropScratchOrgReporting(world.org.orgId);
    }
  },
);

test("ledger carrying uses the currency minor-unit exponent", { skip: !DB }, async () => {
  const world = await setupCostWorld();
  try {
    await db.execute(sql`
        insert into currencies (code, name, minor_units)
        values ('JPY', 'Japanese Yen', 0) on conflict (code) do nothing`);
    await db.execute(sql`update orgs set base_currency = 'JPY' where id = ${world.org.orgId}`);
    await db.execute(
      sql`update subsidiaries set base_currency = 'JPY' where org_id = ${world.org.orgId}`,
    );
    const contractId = await seedContract(world, {
      number: "C-JPY-CARRYING",
      startsOn: "2026-07-01",
      endsOn: "2028-06-30",
    });
    await db.execute(sql`
        update revenue_contracts set currency = 'JPY'
         where org_id = ${world.org.orgId} and id = ${contractId}`);
    const cap = await capitalizeContractCost({
      orgId: world.org.orgId,
      actorId: world.managerId,
      revenueContractId: contractId,
      repPartyId: world.repPartyId,
      customerPartyId: world.org.customerId,
      costType: "commission",
      amountMinor: 100000n,
      currency: "JPY",
      capitalizedOn: "2026-07-15",
      method: "straight_line",
      originalExpenseAccountId: world.commissionExpenseAccountId,
      source: { kind: "manual" },
    });
    assert.equal(await assetCarryingMinor(db, world.org.orgId, cap.assetId), 100000n);
  } finally {
    await dropScratchOrgReporting(world.org.orgId);
  }
});

test("an amortization run is idempotent per asset and period", { skip: !DB }, async () => {
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
    const rows = (
      await db.execute<{ n: string }>(
        sql`
        select count(*)::text as n from contract_cost_amortization
         where org_id = ${world.org.orgId}`,
        "objects",
      )
    )[0]!;
    assert.equal(rows.n, "1");
  } finally {
    await dropScratchOrgReporting(world.org.orgId);
  }
});

test("the projected schedule sums exactly to the capitalized cost", () => {
  const schedule = projectAmortizationSchedule(100000n, 3);
  assert.deepEqual(schedule, [33334n, 33333n, 33333n]);
  assert.equal(
    schedule.reduce((acc, m) => acc + m, 0n),
    100000n,
  );
});
