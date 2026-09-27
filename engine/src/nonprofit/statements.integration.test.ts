import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { installEngineSeams } from "../composition/install.ts";
import { toUnits } from "../money/money.ts";
import { db, withBypass, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { postEntry } from "../journal/post-entry.ts";
import { NonprofitError } from "./errors.ts";
import { createFund, setFundPair } from "./funds.ts";
import { splitSharedCost, setFunctionalMapping } from "./functional.ts";
import { setFramework } from "./frameworks.ts";
import { provisionFundAccounting } from "./provision.ts";
import { awardGrant, createGrant, type GrantPostingAccounts } from "./grants.ts";
import { createFundRelease, submitFundRelease, voidFundRelease } from "./releases.ts";
import { loadNonprofitStatements } from "./statements.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("nonprofit statements observe posted balances, gross releases, and tied functional expense", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Statement Controller", "admin"));
    installEngineSeams();
    const departmentIds = [randomUUID(), randomUUID()];
    await withOrgContext(org.orgId, async () => {
      for (const [index, id] of departmentIds.entries()) {
        const made = await db.execute<{ id: string }>(sql`
          insert into departments (id, org_id, name, is_active, custom)
          values (${id}, ${org.orgId}, ${index === 0 ? "Program" : "Fundraising"}, true, '{}'::jsonb)
          returning id
        `);
        assert.equal(made.rows.length, 1);
      }
    });
    await assert.rejects(setFunctionalMapping({
      orgId: org.orgId, departmentId: departmentIds[0], functionKey: "program",
      effectiveFrom: org.date, actorId, reason: "Initial classification",
    }), (error: unknown) => error instanceof NonprofitError && error.code === "feature_off" &&
      error.message.includes("functionalExpenses") && error.remedy.includes("Company Settings → Features"));

    await withOrgContext(org.orgId, async () => {
      const enabled = await db.execute<{ id: string }>(sql`
        update orgs set settings = jsonb_set(
          coalesce(settings, '{}'::jsonb), '{features}',
          coalesce(settings->'features', '{}'::jsonb) ||
            '{"nonprofit":true,"fundAccounting":true,"functionalExpenses":true,"grantManagement":true}'::jsonb,
          true
        ) where id = ${org.orgId} returning id
      `);
      assert.equal(enabled.rows.length, 1);
    });
    const operating = await provisionFundAccounting({
      orgId: org.orgId,
      defaultFund: { code: "UNRESTRICTED", name: "Unrestricted Fund" },
      classifications: { UNRESTRICTED: { kind: "operating", restrictionClass: "without_donor_restrictions" } },
      actorId,
    });
    const restricted = await createFund({
      orgId: org.orgId, code: "COMMUNITY", name: "Community Fund", kind: "restricted",
      restrictionClass: "with_donor_restrictions", actorId,
    });
    await setFramework({ orgId: org.orgId, framework: "us_asc958", actorId, reason: "Adopt nonprofit reporting" });
    await setFundPair({
      orgId: org.orgId, fromFundId: operating.defaultFundId, toFundId: restricted.id,
      dueFromAccountId: org.accounts.ar, dueToAccountId: org.accounts.ap, actorId,
    });
    for (const [departmentId, functionKey] of [
      [departmentIds[0]!, "program"], [departmentIds[1]!, "fundraising"],
    ] as const) {
      await setFunctionalMapping({
        orgId: org.orgId, departmentId, functionKey, effectiveFrom: org.date,
        programKey: functionKey === "program" ? "food_access" : null,
        actorId, reason: "Classify shared occupancy expense",
      });
    }

    await withOrgTransaction(org.orgId, () => postEntry(db, {
      orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId,
      entryNumber: `GIFT-${randomUUID()}`, postingDate: org.date, periodId: org.periodId,
      currency: "CAD", actorId, origin: "gift", memo: "Restricted community gift",
      lines: [
        { accountId: org.accounts.bank, amount: "100.0000", extraDims: { fund: restricted.id } },
        { accountId: org.accounts.revenue, amount: "-100.0000", extraDims: { fund: restricted.id } },
      ],
    }));
    const groupId = await withOrgContext(org.orgId, async () => {
      const group = await db.execute<{ id: string }>(sql`
        insert into account_groups (org_id, dimension, key, name, match, is_catch_all, is_active, created_by, updated_by)
        values (${org.orgId}, 'grant_allowable_costs', 'grant_costs', 'Grant Allowable Costs', '{}'::jsonb, false, true, ${actorId}, ${actorId})
        returning id
      `);
      assert.equal(group.rows.length, 1);
      const member = await db.execute<{ id: string }>(sql`
        insert into account_group_members (org_id, group_id, account_id, dimension, created_by, updated_by)
        values (${org.orgId}, ${group.rows[0]!.id}, ${org.accounts.cogs}, 'grant_allowable_costs', ${actorId}, ${actorId})
        returning id
      `);
      assert.equal(member.rows.length, 1);
      return group.rows[0]!.id;
    });
    const grant = await createGrant({
      orgId: org.orgId, code: "COMMUNITY-AWARD", name: "Community Award",
      sponsorPartyId: org.customerId, sponsorKind: "foundation", determination: "contribution_unconditional",
      awardAmount: "40.00", periodFrom: "2026-01-01", periodTo: "2026-12-31",
      fundId: restricted.id, allowableAccountGroupId: groupId, actorId,
    });
    const grantAccounts: GrantPostingAccounts = {
      bankAccountId: org.accounts.bank, grantsReceivableAccountId: org.accounts.ar,
      refundableAdvanceAccountId: org.accounts.ap, grantRevenueAccountId: org.accounts.revenue,
      exchangeReceivableAccountId: org.accounts.ar, exchangeRevenueAccountId: org.accounts.revenue,
    };
    await awardGrant({ orgId: org.orgId, grantId: grant.id, accounts: grantAccounts, postingDate: org.date, actorId });

    const rentAccountId = await withOrgContext(org.orgId, async () => {
      const account = await db.execute<{ id: string }>(sql`
        insert into accounts (org_id, number, name, type, is_summary, is_active, required_dimensions, custom, created_by, updated_by)
        values (${org.orgId}, ${`RENT-${randomUUID().slice(0, 8)}`}, 'Shared rent', 'expense', false, true, '[]'::jsonb, '{}'::jsonb, ${actorId}, ${actorId})
        returning id
      `);
      assert.equal(account.rows.length, 1);
      return account.rows[0]!.id;
    });
    const split = splitSharedCost({
      total: "30.00",
      targets: [
        { key: departmentIds[0]!, functionKey: "program", programKey: "food_access", weight: "2" },
        { key: departmentIds[1]!, functionKey: "fundraising", weight: "1" },
      ],
      allocationRuleKey: "shared_occupancy", allocationRuleName: "Shared occupancy by area",
      driverKey: "occupied_area", driverName: "Occupied area", driverUnit: "square feet", asOf: org.date,
    });
    await withOrgTransaction(org.orgId, () => postEntry(db, {
      orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId,
      entryNumber: `RENT-${randomUUID()}`, postingDate: org.date, periodId: org.periodId,
      currency: "CAD", actorId, origin: "journal", memo: "Shared rent allocation",
      lines: [
        ...split.targets.map((target) => ({
          accountId: rentAccountId, amount: target.amount,
          departmentId: target.key,
          extraDims: { fund: operating.defaultFundId },
        })),
        { accountId: org.accounts.bank, amount: "-30.0000", extraDims: { fund: operating.defaultFundId } },
      ],
    }));

    const secondaryBook = await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
      insert into accounting_books (org_id, code, name, is_primary, created_by)
      values (${org.orgId}, ${`TAX-${randomUUID().slice(0, 8)}`}, 'Secondary tax book', false, ${actorId})
      returning id
    `));
    await withOrgTransaction(org.orgId, () => postEntry(db, {
      orgId: org.orgId, bookId: secondaryBook.rows[0]!.id, subsidiaryId: org.subsidiaryId,
      entryNumber: `TAX-${randomUUID()}`, postingDate: org.date, periodId: org.periodId,
      currency: "CAD", actorId, origin: "journal", memo: "Secondary book activity",
      lines: [
        { accountId: org.accounts.bank, amount: "7.0000", extraDims: { fund: operating.defaultFundId } },
        { accountId: org.accounts.revenue, amount: "-7.0000", extraDims: { fund: operating.defaultFundId } },
      ],
    }));

    const beforeRelease = await loadNonprofitStatements({
      orgId: org.orgId, asOf: org.date, periodFrom: "2026-01-01", periodTo: org.date,
    });
    const release = await createFundRelease({
      orgId: org.orgId, fromFundId: restricted.id, toFundId: operating.defaultFundId,
      releaseAccountId: org.accounts.revenue, releaseDate: org.date, amount: "20.0000",
      purpose: "Community program costs met", satisfactionRef: "Approved program expenditure", actorId,
    });
    assert.equal((await submitFundRelease({ orgId: org.orgId, releaseId: release.id, actorId })).status, "posted");

    const statements = await loadNonprofitStatements({
      orgId: org.orgId, asOf: org.date, periodFrom: "2026-01-01", periodTo: org.date,
    });
    const accounts = await withOrgContext(org.orgId, () => db.execute<{ id: string }>(sql`
      select id from accounts where org_id = ${org.orgId}
    `));
    assert.equal(new Set(statements.financialPosition.accounts.map((row) => row.accountId)).size, accounts.rows.length);
    assert.equal(statements.functionalExpenses.totalExpenseByCurrency[0]?.amount, "30.0000");
    assert.equal(statements.functionalExpenses.totals.reduce((sum, row) => sum + toUnits(row.amount), 0n), toUnits("30.0000"));
    assert.ok(statements.activities.rows.some((row) => row.grossReleasedFromClass === "20.0000"));
    assert.ok(statements.activities.rows.some((row) =>
      row.restrictionClass === "with_donor_restrictions" && row.revenue === "140.0000"));
    assert.ok(statements.financialPosition.netAssetsByClass.some((row) =>
      row.restrictionClass === "with_donor_restrictions" && row.restrictionClassLabel === "With donor restrictions"));
    assert.ok(statements.cashFlows.reconciliation.some((row) =>
      row.cashChange === "70.0000" && row.netActivity === "110.0000" &&
      row.closingNetAssets === "110.0000" && row.reconciliationDifference === "0.0000"));
    const voidedRelease = await voidFundRelease({
      orgId: org.orgId, releaseId: release.id, actorId, voidDate: org.date,
      reason: "The release was entered in error",
    });
    assert.equal(voidedRelease.status, "void");
    const afterVoid = await loadNonprofitStatements({
      orgId: org.orgId, asOf: org.date, periodFrom: "2026-01-01", periodTo: org.date,
    });
    assert.deepEqual(
      afterVoid.financialPosition.netAssetsByClass.map(({ restrictionClass, amount }) => ({ restrictionClass, amount })),
      beforeRelease.financialPosition.netAssetsByClass.map(({ restrictionClass, amount }) => ({ restrictionClass, amount })),
    );
    assert.ok(afterVoid.cashFlows.reconciliation.every((row) => row.reconciliationDifference === "0.0000"));
    const movement = await withOrgContext(org.orgId, () => db.execute<{ amount: string }>(sql`
      select coalesce(sum(jl.amount), 0)::text as amount
        from journal_lines jl join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
       where jl.org_id = ${org.orgId} and je.status in ('posted', 'reversed')
         and je.posting_date between '2026-01-01'::date and ${org.date}::date
    `));
    assert.equal(toUnits(movement.rows[0]?.amount ?? "0"), 0n);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
