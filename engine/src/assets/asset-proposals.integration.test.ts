import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgContext, withOrgTransaction } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  grantScratchPermissions,
  seedFlowActors,
  seedPostingAccount,
} from "../testing/fixtures.ts";
import { sum, toUnits, fromUnits, neg } from "../money/money.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { installEngineSeams } from "../composition/install.ts";
import { AssetRefusal } from "./asset-refusal.ts";
import { postCapitalizationEntry } from "./capitalization-journal.ts";
import {
  acceptAssetProposals,
  generateAssetProposalsForEntries,
  rejectAssetProposal,
  restoreAssetProposal,
  reverseAssetProposalAcceptance,
} from "./asset-proposals.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

/** Database refusals arrive wrapped by the driver; match anywhere in the cause chain. */
async function rejectsMatching(run: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    for (
      let current: unknown = error;
      current instanceof Error;
      current = (current as Error & { cause?: unknown }).cause
    ) {
      if (pattern.test(current.message)) return true;
    }
    return false;
  });
}

async function refusedWith(code: string, run: () => Promise<unknown>): Promise<void> {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof AssetRefusal, `expected AssetRefusal ${code}, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

async function setup(org: Org) {
  const actors = await seedFlowActors(org.orgId);
  await grantScratchPermissions(org.orgId, actors.adminId, ["assets.capitalize"]);
  return withOrgContext(org.orgId, async () => {
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"assetProposals": true, "assetComponents": true, "constructionInProgress": true}'::jsonb)
       where id = ${org.orgId}`);
    const clearing = await seedPostingAccount(
      org.orgId,
      "1590",
      "Asset clearing",
      "asset_current_other",
    );
    const equipment = await seedPostingAccount(org.orgId, "1600", "Equipment", "asset_fixed");
    const accumulated = await seedPostingAccount(
      org.orgId,
      "1690",
      "Accumulated depreciation — equipment",
      "asset_fixed",
    );
    const depreciation = await seedPostingAccount(
      org.orgId,
      "6100",
      "Depreciation expense",
      "expense",
    );
    const categoryId = randomUUID();
    await db.execute(sql`
      insert into asset_categories
        (id, org_id, name, asset_account_id, accumulated_depreciation_account_id, depreciation_expense_account_id,
         gain_loss_account_id, default_method, default_life_months, default_convention, tax_attributes, is_active)
      values (${categoryId}, ${org.orgId}, 'Equipment', ${equipment}, ${accumulated}, ${depreciation}, ${depreciation},
              'straight_line', 60, 'full_month', '{}'::jsonb, true)`);
    await db.execute(sql`
      insert into asset_capitalization_rules
        (org_id, name, match_kind, account_id, asset_category_id, minimum_amount, effective_from, created_by, updated_by)
      values (${org.orgId}, 'Equipment clearing', 'account', ${clearing}, ${categoryId}, 1000, '2026-01-01', ${actors.adminId}, ${actors.adminId})`);
    return { actors, clearing, equipment, categoryId };
  });
}

/** A posted purchase: debit the clearing account (one line above, one below the threshold), credit AP. */
async function postPurchase(
  org: Org,
  clearing: string,
  amounts: string[],
): Promise<{ entryId: string; lineIds: string[] }> {
  const total = sum(amounts);
  const posted = await withOrgContext(org.orgId, () =>
    postEntry(db, {
      orgId: org.orgId,
      bookId: org.bookId,
      subsidiaryId: org.subsidiaryId,
      entryNumber: `PUR-${randomUUID()}`,
      postingDate: org.date,
      periodId: org.periodId,
      origin: "manual",
      currency: "CAD",
      lines: [
        ...amounts.map((amount, index) => ({
          accountId: clearing,
          amount,
          memo: `Purchase line ${index + 1}`,
        })),
        { accountId: org.accounts.bank, amount: `-${total}` },
      ],
    }),
  );
  return {
    entryId: posted.entryId,
    lineIds: posted.lines.slice(0, amounts.length).map((line) => line.id),
  };
}

async function balance(org: Org, accountId: string): Promise<string> {
  const row = (
    await withOrgContext(org.orgId, () =>
      db.execute<{ total: string }>(
        sql`
    select coalesce(sum(jl.amount), 0)::numeric(19,4)::text as total from journal_lines jl
      join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id and je.status in ('posted', 'reversed')
     where jl.org_id = ${org.orgId} and jl.account_id = ${accountId}`,
        "objects",
      ),
    )
  )[0];
  return row!.total;
}

test(
  "posted purchase lines become one proposal each, idempotently, and only above the rule threshold",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { clearing, actors } = await setup(org);
      const purchase = await postPurchase(org, clearing, ["5000.00", "400.00"]);
      const first = await withOrgTransaction(org.orgId, () =>
        generateAssetProposalsForEntries(db, {
          orgId: org.orgId,
          entryIds: [purchase.entryId],
          actorId: actors.adminId,
        }),
      );
      const replay = await withOrgTransaction(org.orgId, () =>
        generateAssetProposalsForEntries(db, {
          orgId: org.orgId,
          entryIds: [purchase.entryId],
          actorId: actors.adminId,
        }),
      );
      assert.equal(first, 1, "only the 5,000 line clears the 1,000 threshold");
      assert.equal(replay, 0, "a second run proposes nothing new");
      const proposals = await withOrgContext(org.orgId, () =>
        db.execute<{ source_line_id: string; amount: string; status: string }>(
          sql`
        select source_line_id, amount::text as amount, status from asset_proposals where org_id = ${org.orgId}`,
          "objects",
        ),
      );
      assert.deepEqual(proposals, [
        { source_line_id: purchase.lineIds[0], amount: "5000.0000", status: "pending" },
      ]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "accepting a split reclasses clearing to the asset account once, replays exactly and reverses cleanly",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { clearing, equipment, categoryId, actors } = await setup(org);
      const purchase = await postPurchase(org, clearing, ["5000.00"]);
      await withOrgTransaction(org.orgId, () =>
        generateAssetProposalsForEntries(db, {
          orgId: org.orgId,
          entryIds: [purchase.entryId],
          actorId: actors.adminId,
        }),
      );
      const proposalId = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ id: string }>(
            sql`
        select id from asset_proposals where org_id = ${org.orgId}`,
            "objects",
          ),
        )
      )[0]!.id;
      const key = randomUUID();
      const request = {
        idempotencyKey: key,
        operation: "split" as const,
        proposalIds: [proposalId],
        acceptedOn: org.date,
        reason: "Two forklifts on one invoice line",
        targets: [
          { name: "Forklift A", categoryId, amount: "3000.00" },
          { name: "Forklift B", categoryId, amount: "2000.00" },
        ],
      };
      const accepted = await acceptAssetProposals(org.orgId, request, { actorId: actors.adminId });
      assert.equal(accepted.replayed, false);
      assert.ok(accepted.reclassEntryId);
      assert.deepEqual(accepted.assets.map((asset) => fromUnits(toUnits(asset.amount))).sort(), [
        "2000.0000",
        "3000.0000",
      ]);
      assert.equal(
        await balance(org, clearing),
        "0.0000",
        "the purchase left clearing exactly once",
      );
      assert.equal(
        await balance(org, equipment),
        "5000.0000",
        "the asset account holds the purchase, not twice",
      );

      const replay = await acceptAssetProposals(org.orgId, request, { actorId: actors.adminId });
      assert.equal(replay.replayed, true);
      assert.equal(replay.acceptanceId, accepted.acceptanceId);
      assert.equal(await balance(org, equipment), "5000.0000", "a replay posts nothing");
      await refusedWith("idempotency_conflict", () =>
        acceptAssetProposals(
          org.orgId,
          { ...request, reason: "different" },
          { actorId: actors.adminId },
        ),
      );

      const assets = await withOrgContext(org.orgId, () =>
        db.execute<{ status: string; acquisition_cost: string; category_id: string }>(
          sql`
        select status, acquisition_cost::text as acquisition_cost, category_id from fixed_assets
         where org_id = ${org.orgId} and id = any(${`{${accepted.assets.map((asset) => asset.id).join(",")}}`}::uuid[])
         order by acquisition_cost`,
          "objects",
        ),
      );
      assert.deepEqual(assets, [
        { status: "draft", acquisition_cost: "2000.0000", category_id: categoryId },
        { status: "draft", acquisition_cost: "3000.0000", category_id: categoryId },
      ]);
      // The capitalized cost is fixed while the acceptance stands.
      await rejectsMatching(
        withOrgContext(org.orgId, () =>
          db.execute(sql`
        update fixed_assets set acquisition_cost = 9999 where org_id = ${org.orgId} and id = ${accepted.assets[0]!.id}`),
        ),
        /capitalized from posted transactions/,
      );
      // The source purchase cannot be reversed under an accepted proposal.
      await rejectsMatching(
        withOrgTransaction(org.orgId, () =>
          markEntryReversed(db, {
            orgId: org.orgId,
            entryId: purchase.entryId,
            actorId: actors.adminId,
          }),
        ),
        /reverse the acceptance/,
      );

      const reversal = await reverseAssetProposalAcceptance(org.orgId, {
        acceptanceId: accepted.acceptanceId,
        date: org.date,
        reason: "Wrong category",
        actorId: actors.adminId,
      });
      assert.equal(reversal.replayed, false);
      assert.equal(reversal.removedAssets.length, 2);
      assert.equal(await balance(org, equipment), "0.0000");
      assert.equal(await balance(org, clearing), "5000.0000");
      const status = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ status: string }>(
            sql`
        select status from asset_proposals where org_id = ${org.orgId} and id = ${proposalId}`,
            "objects",
          ),
        )
      )[0]!.status;
      assert.equal(status, "pending", "the proposal returns to the queue");
      await refusedWith("acceptance_reversed", () =>
        acceptAssetProposals(org.orgId, request, { actorId: actors.adminId }),
      );
      const again = await reverseAssetProposalAcceptance(org.orgId, {
        acceptanceId: accepted.acceptanceId,
        date: org.date,
        reason: "repeat",
        actorId: actors.adminId,
      });
      assert.equal(again.replayed, true, "reversing twice changes nothing");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "capitalization uses the subsidiary period and honors the assets close fence",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const calendarId = randomUUID();
      const periodId = randomUUID();
      await withOrgContext(org.orgId, async () => {
        await db.execute(sql`insert into fiscal_calendars (id,org_id,name,is_active,is_default)
        values (${calendarId},${org.orgId},'Entity asset calendar',true,false)`);
        await db.execute(sql`insert into accounting_periods
        (id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on)
        select ${periodId},org_id,${calendarId},fiscal_year,period_number,'Entity July',starts_on,ends_on
          from accounting_periods where org_id=${org.orgId} and id=${org.periodId}`);
        await db.execute(sql`insert into subsidiary_accounting_preferences
        (org_id,subsidiary_id,effective_from,fiscal_calendar_id,reason)
        values (${org.orgId},${org.subsidiaryId},'2026-07-01',${calendarId},'Use the entity asset calendar')`);
        await db.execute(sql`insert into period_locks
        (org_id,period_id,book_id,subsidiary_id,module,state,reason)
        values (${org.orgId},${periodId},${org.bookId},${org.subsidiaryId},'assets','closed','Asset period close')`);
      });

      await assert.rejects(
        withOrgContext(org.orgId, () =>
          postCapitalizationEntry(db, {
            orgId: org.orgId,
            actorId,
            subsidiaryId: org.subsidiaryId,
            date: org.date,
            entryNumber: `CAP-CLOSED-${randomUUID()}`,
            memo: "Test the entity close fence",
            idempotencyKey: `cap-closed:${randomUUID()}`,
            lines: [
              { accountId: org.accounts.invAsset, amount: "10", memo: "Capitalize" },
              { accountId: org.accounts.clearing, amount: "-10", memo: "Reclassify" },
            ],
          }),
        ),
        (error: unknown) => error instanceof AssetRefusal && error.code === "period_closed",
      );
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "capitalization result excludes appended department-balancing legs",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      installEngineSeams();
      const actorId = (await seedFlowActors(org.orgId)).adminId;
      const departments = [randomUUID(), randomUUID()];
      await withOrgContext(org.orgId, async () => {
        await db.execute(sql`insert into departments (id,org_id,name)
        values (${departments[0]},${org.orgId},'Operations'),(${departments[1]},${org.orgId},'Sales')`);
        await db.execute(sql`insert into segment_definitions
        (org_id,key,name,plural_name,source_kind,storage_column,is_balancing)
        values (${org.orgId},'department','Department','Departments','builtin','department_id',true)
        on conflict (org_id,key) do update set is_balancing=true`);
        await db.execute(sql`insert into segment_balancing_policies
        (org_id,segment_key,effective_from,clearing_account_id,reason)
        values (${org.orgId},'department','2026-01-01',${org.accounts.clearing},'Balance asset reclasses by department')`);
      });

      const posted = await withOrgContext(org.orgId, () =>
        postCapitalizationEntry(db, {
          orgId: org.orgId,
          actorId,
          subsidiaryId: org.subsidiaryId,
          date: org.date,
          entryNumber: `CAP-SEGMENT-${randomUUID()}`,
          memo: "Balance capitalization by department",
          idempotencyKey: `cap-segment:${randomUUID()}`,
          lines: [
            {
              accountId: org.accounts.invAsset,
              amount: "10",
              memo: "Capitalize",
              departmentId: departments[0],
            },
            {
              accountId: org.accounts.clearing,
              amount: "-10",
              memo: "Reclassify",
              departmentId: departments[1],
            },
          ],
        }),
      );
      assert.ok(posted);
      assert.equal(posted.lines.length, 2, "the result contains the two requested lines only");
      const lineCount = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ count: number }>(
            sql`
      select count(*)::int as count from journal_lines where org_id=${org.orgId} and entry_id=${posted.entryId}`,
            "objects",
          ),
        )
      )[0]!.count;
      assert.equal(lineCount, 4, "the kernel also posts one balancing leg for each department");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "merge, reject with reason, restore, and void of a pending proposal when its source is reversed",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const { clearing, equipment, categoryId, actors } = await setup(org);
      const purchase = await postPurchase(org, clearing, ["1500.00", "2500.00", "3000.00"]);
      await withOrgTransaction(org.orgId, () =>
        generateAssetProposalsForEntries(db, {
          orgId: org.orgId,
          entryIds: [purchase.entryId],
          actorId: actors.adminId,
        }),
      );
      const ids = await withOrgContext(org.orgId, () =>
        db.execute<{ id: string; amount: string }>(
          sql`
        select id, amount::text as amount from asset_proposals where org_id = ${org.orgId} order by amount`,
          "objects",
        ),
      );
      assert.equal(ids.length, 3);
      await refusedWith("amount_mismatch", () =>
        acceptAssetProposals(
          org.orgId,
          {
            idempotencyKey: randomUUID(),
            operation: "merge",
            proposalIds: [ids[0]!.id, ids[1]!.id],
            acceptedOn: org.date,
            targets: [{ name: "Server rack", categoryId, amount: "3999.99" }],
          },
          { actorId: actors.adminId },
        ),
      );
      const merged = await acceptAssetProposals(
        org.orgId,
        {
          idempotencyKey: randomUUID(),
          operation: "merge",
          proposalIds: [ids[0]!.id, ids[1]!.id],
          acceptedOn: org.date,
          targets: [{ name: "Server rack", categoryId, amount: "4000.00" }],
        },
        { actorId: actors.adminId },
      );
      assert.equal(merged.assets.length, 1);
      assert.equal(await balance(org, equipment), "4000.0000");

      await refusedWith("reason_required", () =>
        rejectAssetProposal(org.orgId, {
          proposalId: ids[2]!.id,
          reason: "  ",
          actorId: actors.adminId,
        }),
      );
      await rejectAssetProposal(org.orgId, {
        proposalId: ids[2]!.id,
        reason: "Repairs, not a new asset",
        actorId: actors.adminId,
      });
      await refusedWith("proposal_not_pending", () =>
        rejectAssetProposal(org.orgId, {
          proposalId: ids[2]!.id,
          reason: "again",
          actorId: actors.adminId,
        }),
      );
      await restoreAssetProposal(org.orgId, {
        proposalId: ids[2]!.id,
        reason: "Reconsidered",
        actorId: actors.adminId,
      });

      // Reversing the merged acceptance first, the source can then be reversed;
      // the still-pending proposals on it are voided by the fence.
      await reverseAssetProposalAcceptance(org.orgId, {
        acceptanceId: merged.acceptanceId,
        date: org.date,
        reason: "Bill voided",
        actorId: actors.adminId,
      });
      await withOrgTransaction(org.orgId, async () => {
        const original = await db.execute<{
          account_id: string;
          amount: string;
          line_number: number;
        }>(
          sql`
          select account_id, amount::text, line_number from journal_lines
           where org_id = ${org.orgId} and entry_id = ${purchase.entryId} order by line_number`,
          "objects",
        );
        await postEntry(db, {
          orgId: org.orgId,
          bookId: org.bookId,
          subsidiaryId: org.subsidiaryId,
          entryNumber: `PUR-REV-${randomUUID()}`,
          postingDate: org.date,
          periodId: org.periodId,
          origin: "manual",
          currency: "CAD",
          reversesEntryId: purchase.entryId,
          actorId: actors.adminId,
          lines: original.map((line) => ({
            accountId: line.account_id,
            amount: neg(line.amount),
            lineNumber: line.line_number,
          })),
        });
        await markEntryReversed(db, {
          orgId: org.orgId,
          entryId: purchase.entryId,
          actorId: actors.adminId,
        });
      });
      const statuses = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ status: string }>(
            sql`
        select distinct status from asset_proposals where org_id = ${org.orgId}`,
            "objects",
          ),
        )
      ).map((row) => row.status);
      assert.deepEqual(statuses, ["voided"]);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "acceptance is refused without the permission, the feature, or the organization's own proposal",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    const other = await createScratchOrg();
    try {
      const { clearing, categoryId, actors } = await setup(org);
      const otherActors = await seedFlowActors(other.orgId);
      await grantScratchPermissions(other.orgId, otherActors.adminId, ["assets.capitalize"]);
      const purchase = await postPurchase(org, clearing, ["5000.00"]);
      await withOrgTransaction(org.orgId, () =>
        generateAssetProposalsForEntries(db, {
          orgId: org.orgId,
          entryIds: [purchase.entryId],
          actorId: actors.adminId,
        }),
      );
      const proposalId = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ id: string }>(
            sql`
        select id from asset_proposals where org_id = ${org.orgId}`,
            "objects",
          ),
        )
      )[0]!.id;
      const request = (key: string) => ({
        idempotencyKey: key,
        operation: "asset" as const,
        proposalIds: [proposalId],
        acceptedOn: org.date,
        targets: [{ name: "Forklift", categoryId, amount: "5000.00" }],
      });
      await refusedWith("permission_required", () =>
        acceptAssetProposals(org.orgId, request(randomUUID()), { actorId: actors.outsiderId }),
      );
      await refusedWith("proposal_not_found", () =>
        acceptAssetProposals(other.orgId, request(randomUUID()), { actorId: otherActors.adminId }),
      );
      await withOrgContext(org.orgId, () =>
        db.execute(sql`
        update orgs set settings = jsonb_set(settings, '{features,assetProposals}', 'false'::jsonb) where id = ${org.orgId}`),
      );
      await refusedWith("feature_disabled", () =>
        acceptAssetProposals(org.orgId, request(randomUUID()), { actorId: actors.adminId }),
      );
      await refusedWith("acceptance_before_source", async () => {
        await withOrgContext(org.orgId, () =>
          db.execute(sql`
          update orgs set settings = jsonb_set(settings, '{features,assetProposals}', 'true'::jsonb) where id = ${org.orgId}`),
        );
        return acceptAssetProposals(
          org.orgId,
          { ...request(randomUUID()), acceptedOn: "2026-07-01" },
          { actorId: actors.adminId },
        );
      });
      const pending = (
        await withOrgContext(org.orgId, () =>
          db.execute<{ status: string }>(
            sql`
        select status from asset_proposals where org_id = ${org.orgId} and id = ${proposalId}`,
            "objects",
          ),
        )
      )[0]!.status;
      assert.equal(pending, "pending", "every refusal leaves the proposal untouched");
    } finally {
      await dropScratchOrg(org.orgId);
      await dropScratchOrg(other.orgId);
    }
  },
);
