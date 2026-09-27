import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import { postEntry } from "../journal/post-entry.ts";
import { reverseProjectGlEntry } from "../journal/origin-entry.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { activateGrant, amendGrant, awardGrant, createGrant, recognizeGrantDrawdown, recordGrantDrawdown, satisfyGrantBarrier, type GrantPostingAccounts } from "./grants.ts";
import { createFund } from "./funds.ts";
import { provisionFundAccounting } from "./provision.ts";
import { NonprofitError } from "./errors.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("grant awards preserve conditional liabilities, enforce drawdown limits, and version amendments", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Grant Controller", "admin"));
    const baseGrant = {
      orgId: org.orgId,
      code: "FEATURE-OFF",
      name: "Disabled grant entry point",
      sponsorPartyId: org.customerId,
      sponsorKind: "foundation" as const,
      determination: "contribution_unconditional" as const,
      awardAmount: "1.00",
      periodFrom: "2026-01-01",
      periodTo: "2026-12-31",
      fundId: randomUUID(),
      allowableAccountGroupId: randomUUID(),
      actorId,
    };
    await assert.rejects(createGrant(baseGrant), (error: unknown) =>
      error instanceof NonprofitError && error.code === "feature_off" &&
      error.message.includes("grantManagement") && error.remedy.includes("Company Settings → Features"));

    await withOrgContext(org.orgId, async () => {
      const enabled = await db.execute<{ id: string }>(sql`
        update orgs set settings = jsonb_set(
          coalesce(settings, '{}'::jsonb), '{features}',
          coalesce(settings->'features', '{}'::jsonb) ||
            '{"nonprofit":true,"fundAccounting":true,"grantManagement":true}'::jsonb,
          true
        ) where id = ${org.orgId} returning id
      `);
      assert.equal(enabled.rows.length, 1);
    });
    await provisionFundAccounting({
      orgId: org.orgId,
      defaultFund: { code: "GRANT-OPS", name: "Grant Operating Fund" },
      classifications: { "GRANT-OPS": { kind: "operating", restrictionClass: "without_donor_restrictions" } },
      actorId,
    });
    const restrictedFund = await createFund({
      orgId: org.orgId,
      code: "GRANT-RESTRICTED",
      name: "Grant Restricted Fund",
      kind: "restricted",
      restrictionClass: "with_donor_restrictions",
      actorId,
    });
    const groupId = await withOrgContext(org.orgId, async () => {
      const created = await db.execute<{ id: string }>(sql`
        insert into account_groups (org_id, dimension, key, name, match, is_catch_all, is_active, created_by, updated_by)
        values (${org.orgId}, 'grant_allowable_costs', 'grant_costs', 'Grant Allowable Costs', '{}'::jsonb, false, true, ${actorId}, ${actorId})
        returning id
      `);
      assert.equal(created.rows.length, 1);
      const group = created.rows[0]!.id;
      const member = await db.execute<{ id: string }>(sql`
        insert into account_group_members (org_id, group_id, account_id, dimension, created_by, updated_by)
        values (${org.orgId}, ${group}, ${org.accounts.cogs}, 'grant_allowable_costs', ${actorId}, ${actorId})
        returning id
      `);
      assert.equal(member.rows.length, 1);
      return group;
    });
    const refundableAdvanceAccountId = await withOrgContext(org.orgId, async () => {
      const created = await db.execute<{ id: string }>(sql`
        insert into accounts (org_id, number, name, type, is_summary, is_active, required_dimensions, custom, created_by, updated_by)
        values (${org.orgId}, ${`GRA-${randomUUID().slice(0, 8)}`}, 'Refundable Grant Advance', 'liability_current_other', false, true, '[]'::jsonb, '{}'::jsonb, ${actorId}, ${actorId})
        returning id
      `);
      assert.equal(created.rows.length, 1);
      return created.rows[0]!.id;
    });
    const accounts: GrantPostingAccounts = {
      bankAccountId: org.accounts.bank,
      grantsReceivableAccountId: org.accounts.ar,
      refundableAdvanceAccountId,
      grantRevenueAccountId: org.accounts.revenue,
      exchangeReceivableAccountId: org.accounts.ar,
      exchangeRevenueAccountId: org.accounts.revenue,
    };
    await withOrgTransaction(org.orgId, () => postEntry(db, {
      orgId: org.orgId,
      bookId: org.bookId,
      subsidiaryId: org.subsidiaryId,
      entryNumber: `GRANT-COST-${randomUUID().slice(0, 8)}`,
      postingDate: org.date,
      periodId: org.periodId,
      origin: "manual",
      currency: "CAD",
      lines: [
        { accountId: org.accounts.cogs, amount: "50.00", extraDims: { fund: restrictedFund.id } },
        { accountId: org.accounts.bank, amount: "-50.00", extraDims: { fund: restrictedFund.id } },
      ],
    }));

    const conditional = await createGrant({
      orgId: org.orgId,
      code: "GRANT-COND-1",
      name: "Youth Program Award",
      sponsorPartyId: org.customerId,
      sponsorKind: "foundation",
      determination: "contribution_conditional",
      barrier: "Submit the year-end program report",
      rightOfReturn: true,
      awardAmount: "100.00",
      periodFrom: "2026-01-01",
      periodTo: "2026-12-31",
      indirectRate: "10",
      indirectBase: "direct_costs",
      fundId: restrictedFund.id,
      allowableAccountGroupId: groupId,
      actorId,
    });
    await awardGrant({ orgId: org.orgId, grantId: conditional.id, accounts, postingDate: org.date, actorId });
    await activateGrant({ orgId: org.orgId, grantId: conditional.id, actorId });
    const advance = await recordGrantDrawdown({
      orgId: org.orgId,
      grantId: conditional.id,
      amount: "40.01",
      kind: "advance",
      accounts,
      postingDate: org.date,
      actorId,
    });
    const advanceLines = await withOrgContext(org.orgId, () => db.execute<{ account_id: string; amount: string }>(sql`
      select account_id, amount::text as amount from journal_lines where org_id = ${org.orgId} and entry_id = ${advance.entryId} order by line_number
    `));
    assert.deepEqual(advanceLines.rows.map((row) => [row.account_id, row.amount]), [
      [org.accounts.bank, "40.0100"],
      [refundableAdvanceAccountId, "-40.0100"],
    ]);
    await assert.rejects(
      recognizeGrantDrawdown({
        orgId: org.orgId,
        drawdownId: advance.id,
        grantRevenueAccountId: accounts.grantRevenueAccountId,
        refundableAdvanceAccountId,
        postingDate: org.date,
        actorId,
      }),
      (error: unknown) => error instanceof NonprofitError && error.code === "grant_barrier_unmet" &&
        error.message.includes("Submit the year-end program report") && error.remedy.includes("Record barrier satisfaction"),
    );
    await satisfyGrantBarrier({ orgId: org.orgId, grantId: conditional.id, evidence: "The sponsor accepted the report.", actorId });
    const recognized = await recognizeGrantDrawdown({
      orgId: org.orgId,
      drawdownId: advance.id,
      grantRevenueAccountId: accounts.grantRevenueAccountId,
      refundableAdvanceAccountId,
      postingDate: org.date,
      actorId,
    });
    const recognizedLines = await withOrgContext(org.orgId, () => db.execute<{ account_id: string; amount: string }>(sql`
      select account_id, amount::text as amount from journal_lines where org_id = ${org.orgId} and entry_id = ${recognized.entryId} order by line_number
    `));
    assert.deepEqual(recognizedLines.rows.map((row) => [row.account_id, row.amount]), [
      [refundableAdvanceAccountId, "40.0100"],
      [org.accounts.revenue, "-40.0100"],
    ]);
    await assert.rejects(
      recordGrantDrawdown({ orgId: org.orgId, grantId: conditional.id, amount: "60.00", kind: "advance", accounts, postingDate: org.date, actorId }),
      (error: unknown) => error instanceof NonprofitError && error.code === "grant_drawdown_over_award" && error.message.includes("59.9900"),
    );
    const allowableLimitRefusal = async (): Promise<string> => {
      let message = "";
      await assert.rejects(
        recordGrantDrawdown({ orgId: org.orgId, grantId: conditional.id, amount: "55.01", kind: "reimbursement", accounts, postingDate: org.date, actorId }),
        (error: unknown) => {
          if (!(error instanceof NonprofitError) || error.code !== "grant_drawdown_over_allowable_spend") return false;
          message = error.message;
          return true;
        },
      );
      assert.match(message, /55\.0000.*Grant Allowable Costs/);
      return message;
    };
    const allowableLimitBefore = await allowableLimitRefusal();
    const expense = await withOrgTransaction(org.orgId, () => postEntry(db, {
      orgId: org.orgId, bookId: org.bookId, subsidiaryId: org.subsidiaryId,
      entryNumber: `GRANT-COST-REVERSED-${randomUUID().slice(0, 8)}`,
      postingDate: org.date, periodId: org.periodId, origin: "manual", currency: "CAD",
      lines: [
        { accountId: org.accounts.cogs, amount: "25.00", extraDims: { fund: restrictedFund.id } },
        { accountId: org.accounts.bank, amount: "-25.00", extraDims: { fund: restrictedFund.id } },
      ],
    }));
    const reversalId = await withOrgTransaction(org.orgId, () => reverseProjectGlEntry(
      org.orgId, actorId, expense.entryId, "Correct the grant cost", org.date,
    ));
    assert.ok(reversalId);
    assert.equal(await allowableLimitRefusal(), allowableLimitBefore);

    const unconditional = await createGrant({
      orgId: org.orgId,
      code: "GRANT-UNCOND-1",
      name: "Food Access Award",
      sponsorPartyId: org.customerId,
      sponsorKind: "government",
      determination: "contribution_unconditional",
      awardAmount: "25.00",
      periodFrom: "2026-01-01",
      periodTo: "2026-12-31",
      fundId: restrictedFund.id,
      allowableAccountGroupId: groupId,
      actorId,
    });
    const awarded = await awardGrant({ orgId: org.orgId, grantId: unconditional.id, accounts, postingDate: org.date, actorId });
    assert.ok(awarded.entryId);
    const awardLines = await withOrgContext(org.orgId, () => db.execute<{ account_id: string; amount: string }>(sql`
      select account_id, amount::text as amount from journal_lines where org_id = ${org.orgId} and entry_id = ${awarded.entryId} order by line_number
    `));
    assert.deepEqual(awardLines.rows.map((row) => [row.account_id, row.amount]), [
      [org.accounts.ar, "25.0000"],
      [org.accounts.revenue, "-25.0000"],
    ]);

    const draft = await createGrant({
      orgId: org.orgId,
      code: "GRANT-AMEND-1",
      name: "Library Award",
      sponsorPartyId: org.customerId,
      sponsorKind: "corporate",
      determination: "contribution_unconditional",
      awardAmount: "10.00",
      periodFrom: "2026-01-01",
      periodTo: "2026-12-31",
      fundId: restrictedFund.id,
      allowableAccountGroupId: groupId,
      actorId,
    });
    const amended = await amendGrant({
      orgId: org.orgId,
      grantId: draft.id,
      reason: "The signed award letter increased the funding cap.",
      changes: { awardAmount: "30.00" },
      accounts,
      postingDate: org.date,
      actorId,
    });
    assert.equal(amended.version, 2);
    assert.equal(amended.supersedesId, draft.id);
    assert.equal(amended.awardAmount, "30.0000");
    assert.equal(amended.status, "draft");
    const versions = await withOrgContext(org.orgId, () => db.execute<{ version: number; award_amount: string; supersedes_id: string | null }>(sql`
      select version, award_amount::text as award_amount, supersedes_id from grants
       where org_id = ${org.orgId} and code = 'GRANT-AMEND-1' order by version
    `));
    assert.deepEqual(versions.rows, [
      { version: 1, award_amount: "10.0000", supersedes_id: null },
      { version: 2, award_amount: "30.0000", supersedes_id: draft.id },
    ]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
