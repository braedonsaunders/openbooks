import { runTaxPool } from "../tax-returns/pool-run.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  seedApprovalFlow,
  type ScratchOrg,
  type FlowActors,
} from "../testing/fixtures.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import {
  buildSchedule,
  runDepreciation,
  recordDepreciationInput,
} from "./depreciation.ts";
import {
  proposeAssetChange,
  applyAssetChange,
  type AssetChangeInput,
} from "./asset-changes.ts";
import { disposeAsset, remeasureAsset } from "./asset-lifecycle.ts";
const DB = !!process.env.OPENBOOKS_DB_URL;
type Fixture = {
  org: ScratchOrg;
  actors: FlowActors;
  assetId: string;
  categoryId: string;
};
async function fixture(work: (f: Fixture) => Promise<void>, postJuly = true) {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId),
      assetId = randomUUID(),
      categoryId = randomUUID();
    await db.execute(
      sql`insert into user_permission_overrides(org_id,user_id,permission,effect) values(${org.orgId},${actors.submitterId},'assets.manage','grant')`,
    );
    const calendar = (
      await db.execute<{ id: string }>(
        sql`select fiscal_calendar_id as id from accounting_periods where org_id=${org.orgId} and id=${org.periodId}`,
      )
    ).rows[0]!.id;
    for (const [month, last] of [
      ["08", "31"],
      ["09", "30"],
    ])
      await db.execute(
        sql`insert into accounting_periods(id,org_id,fiscal_calendar_id,fiscal_year,period_number,name,starts_on,ends_on,is_adjustment,custom) values(${randomUUID()},${org.orgId},${calendar},2026,${Number(month)},${`2026-${month}`},${`2026-${month}-01`},${`2026-${month}-${last}`},false,'{}'::jsonb)`,
      );
    await db.execute(
      sql`insert into asset_categories(id,org_id,name,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,default_convention) values(${categoryId},${org.orgId},'Component test',${org.accounts.invAsset},${org.accounts.clearing},${org.accounts.adjustment},${org.accounts.adjustment},'straight_line',3,'full_month')`,
    );
    await db.execute(
      sql`insert into fixed_assets(id,org_id,subsidiary_id,category_id,asset_number,name,status,acquired_on,in_service_on,acquisition_cost,salvage_value,useful_life_months) values(${assetId},${org.orgId},${org.subsidiaryId},${categoryId},${`AST-${assetId}`},'Component asset','in_service','2026-07-01','2026-07-01',3000,0,3)`,
    );
    await buildSchedule(assetId, org.orgId, actors.submitterId, org.bookId);
    if (postJuly) {
      const result = await runDepreciation(
        org.orgId,
        "2026-07-31",
        actors.submitterId,
        assetId,
      );
      assert.equal(result.posted, 1);
      assert.deepEqual(result.problems, []);
    }
    await seedApprovalFlow(org.orgId, {
      subjectKind: "financial_change",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
      preventSelfApproval: false,
    });
    await work({ org, actors, assetId, categoryId });
  } finally {
    await dropScratchOrg(org.orgId);
  }
}
function input(
  f: Fixture,
  patch: Partial<AssetChangeInput> = {},
): AssetChangeInput {
  return {
    operation: "partial_disposal",
    effectiveOn: "2026-08-01",
    reason: "Sold one quarter of the homogeneous production fixtures",
    assessment:
      "Identical components have equal cost and service; one quarter is derecognized",
    idempotencyKey: randomUUID(),
    portion: { percent: "25" },
    proceeds: "600",
    proceedsAccountId: f.org.accounts.clearing,
    ...patch,
  };
}
async function approve(f: Fixture, id: string) {
  await submitFinancialChange(f.org.orgId, id, f.actors.submitterId);
  const gate = (
    await db.execute<{ id: string }>(
      sql`select id from flow_gates where org_id=${f.org.orgId} and subject_id=${id} and status='pending'`,
    )
  ).rows[0]!;
  await decideGate({
    gateId: gate.id,
    userId: f.actors.approver1Id,
    decision: "approved",
  });
}
async function carrying(f: Fixture) {
  return (
    await db.execute<{
      cost: string;
      accumulated: string;
      carrying_value: string;
    }>(
      sql`select cost::text,accumulated::text,carrying_value::text from asset_book_carrying_values where org_id=${f.org.orgId} and asset_id=${f.assetId} and book_id=${f.org.bookId}`,
    )
  ).rows[0]!;
}
test(
  "approved partial disposal keeps posted history and rebuilds only remaining basis",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      const old = (
        await db.execute(
          sql`select l.* from depreciation_schedule_lines l join depreciation_schedules s on s.org_id=l.org_id and s.id=l.schedule_id where s.org_id=${f.org.orgId} and s.asset_id=${f.assetId} and l.posted_amount is not null`,
        )
      ).rows;
      const p = input(f),
        id = await proposeAssetChange(
          f.org.orgId,
          f.assetId,
          f.actors.submitterId,
          p,
        );
      await assert.rejects(
        () => applyAssetChange(f.org.orgId, id, f.actors.submitterId),
        /independent approval/,
      );
      await approve(f, id);
      const result = await applyAssetChange(
        f.org.orgId,
        id,
        f.actors.submitterId,
      );
      assert.deepEqual(
        await applyAssetChange(f.org.orgId, id, f.actors.submitterId),
        result,
      );
      assert.equal(
        await proposeAssetChange(
          f.org.orgId,
          f.assetId,
          f.actors.submitterId,
          p,
        ),
        id,
      );
      assert.deepEqual(await carrying(f), {
        cost: "2250.0000",
        accumulated: "750.0000",
        carrying_value: "1500.0000",
      });
      const retained = (
        await db.execute(
          sql`select l.* from depreciation_schedule_lines l join depreciation_schedules s on s.org_id=l.org_id and s.id=l.schedule_id where s.org_id=${f.org.orgId} and s.asset_id=${f.assetId} and l.posted_amount is not null`,
        )
      ).rows;
      assert.deepEqual(retained, old);
      await buildSchedule(
        f.assetId,
        f.org.orgId,
        f.actors.submitterId,
        f.org.bookId,
      );
      const future = await runDepreciation(
        f.org.orgId,
        "2026-09-30",
        f.actors.submitterId,
        f.assetId,
      );
      assert.deepEqual(future.problems, []);
      assert.equal(future.totalAmount, "1500.0000");
      assert.equal((await carrying(f)).carrying_value, "0.0000");
      const cost = (
        await db.execute<{ cost: string }>(
          sql`select acquisition_cost::text as cost from fixed_assets where org_id=${f.org.orgId} and id=${f.assetId}`,
        )
      ).rows[0]!.cost;
      assert.equal(cost, "3000.0000");
    }),
);
test(
  "subsequent whole disposal clears only the remaining cost and accumulated depreciation",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      const id = await proposeAssetChange(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        input(f),
      );
      await approve(f, id);
      await applyAssetChange(f.org.orgId, id, f.actors.submitterId);
      const sale = await disposeAsset(f.org.orgId, f.assetId, {
        date: "2026-08-01",
        actorId: f.actors.submitterId,
        proceeds: "1600",
        proceedsAccountId: f.org.accounts.clearing,
      });
      assert.equal(sale.nbv, "1500.0000");
      assert.equal(sale.gainLoss, "100.0000");
    }),
);
test(
  "unposted earlier depreciation refuses by book and period",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      await assert.rejects(
        () =>
          proposeAssetChange(
            f.org.orgId,
            f.assetId,
            f.actors.submitterId,
            input(f, { effectiveOn: "2026-09-01" }),
          ),
        /post depreciation.*2026-08-31/,
      );
    }),
);
test("a stale independently approved change cannot post", { skip: !DB }, () =>
  fixture(async (f) => {
    const id = await proposeAssetChange(
      f.org.orgId,
      f.assetId,
      f.actors.submitterId,
      input(f),
    );
    await approve(f, id);
    await db.execute(
      sql`update fixed_assets set name='New evidence after approval',updated_at=clock_timestamp() where org_id=${f.org.orgId} and id=${f.assetId}`,
    );
    await assert.rejects(
      () => applyAssetChange(f.org.orgId, id, f.actors.submitterId),
      /changed after this proposal/,
    );
    assert.equal((await carrying(f)).cost, "3000.0000");
  }),
);
test(
  "a mid-period partial disposal accrues elapsed depreciation once and retains exact remaining basis",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      const id = await proposeAssetChange(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        input(f, { effectiveOn: "2026-07-16", proceeds: "0" }),
      );
      await approve(f, id);
      const result = await applyAssetChange(
        f.org.orgId,
        id,
        f.actors.submitterId,
      );
      assert.equal((result.entryIds as string[]).length, 2);
      const value = await carrying(f);
      assert.equal(value.cost, "2250.0000");
      assert.equal(value.accumulated, "362.9032");
      await runDepreciation(
        f.org.orgId,
        "2026-09-30",
        f.actors.submitterId,
        f.assetId,
      );
      assert.equal((await carrying(f)).carrying_value, "0.0000");
    }, false),
);

test(
  "intercompany transfer creates the buyer, retains group basis, and consolidates idempotently",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      const buyer = randomUUID(),
        elim = randomUUID(),
        dueFrom = randomUUID(),
        dueTo = randomUUID();
      await db.execute(
        sql`insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom) values(${buyer},${f.org.orgId},${f.org.subsidiaryId},'Buyer','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb),(${elim},${f.org.orgId},${f.org.subsidiaryId},'Elimination','CAD','CA','{}'::jsonb,true,true,'{}'::jsonb)`,
      );
      for (const [id, number, type] of [
        [dueFrom, "1998", "asset_current_other"],
        [dueTo, "2998", "liability_current_other"],
      ])
        await db.execute(
          sql`insert into accounts(id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,required_dimensions,custom,subsidiary_include_children) values(${id},${f.org.orgId},${number},${number},${type},false,true,true,false,'[]'::jsonb,'{}'::jsonb,true)`,
        );
      await db.execute(
        sql`insert into intercompany_pairs(org_id,from_subsidiary_id,to_subsidiary_id,due_from_account_id,due_to_account_id) values(${f.org.orgId},${f.org.subsidiaryId},${buyer},${dueFrom},${dueTo})`,
      );
      const request = input(f, {
        operation: "intercompany_transfer",
        portion: { percent: "100" },
        proceeds: "2400",
        proceedsAccountId: dueFrom,
        transfer: {
          subsidiaryId: buyer,
          categoryId: f.categoryId,
          assetNumber: "RECEIVED-1",
          name: "Received equipment",
          buyerAmount: "2400",
          buyerSalvage: "0",
          lifeMonths: 2,
          payableAccountId: dueTo,
          eliminationSubsidiaryId: elim,
          sellerToGroupRate: "1",
          buyerToGroupRate: "1",
          sellerToBuyerRate: "1",
          ctaAccountId: f.org.accounts.fxGainLoss,
          groupAssetAccountId: f.org.accounts.invAsset,
          groupAccumulatedAccountId: f.org.accounts.clearing,
          groupDepreciationAccountId: f.org.accounts.adjustment,
          groupGainLossAccountId: f.org.accounts.recognized,
          taxRatePercent: "25",
          deferredTaxAccountId: f.org.accounts.deferred,
          taxExpenseAccountId: f.org.accounts.fxGainLoss,
          exchangeRateEvidence:
            "Both legal entities use CAD; transaction and historical rates are one",
          groupAssessment:
            "Group retains original cost and remaining two-month service; internal profit creates 25 percent deductible temporary difference",
        },
      });
      const id = await proposeAssetChange(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        request,
      );
      await approve(f, id);
      const applied = await applyAssetChange(
        f.org.orgId,
        id,
        f.actors.submitterId,
      );
      assert.equal((applied.entryIds as string[]).length, 2);
      const received = String(applied.receivingAssetId);
      assert.notEqual(received, f.assetId);
      const target = (
        await db.execute<{
          acquisition_cost: string;
          subsidiary_id: string;
          transferred_from_asset_id: string;
        }>(
          sql`select acquisition_cost::text,subsidiary_id,transferred_from_asset_id from fixed_assets where org_id=${f.org.orgId} and id=${received}`,
        )
      ).rows[0]!;
      assert.equal(target.acquisition_cost, "2400.0000");
      assert.equal(target.subsidiary_id, buyer);
      assert.equal(target.transferred_from_asset_id, f.assetId);
      const august = (
        await db.execute<{ id: string }>(
          sql`select id from accounting_periods where org_id=${f.org.orgId} and name='2026-08'`,
        )
      ).rows[0]!.id;
      const { consolidateAssetTransfers } =
        await import("../consolidation/asset-transfers.ts");
      const first = await db.transaction((tx) =>
        consolidateAssetTransfers(tx, f.org.orgId, august, f.actors.adminId),
      );
      assert.equal(first.length, 1);
      assert.deepEqual(
        await db.transaction((tx) =>
          consolidateAssetTransfers(tx, f.org.orgId, august, f.actors.adminId),
        ),
        [],
      );
      const result = await runDepreciation(
        f.org.orgId,
        "2026-08-31",
        f.actors.submitterId,
        received,
      );
      assert.deepEqual(result.problems, []);
      assert.equal(result.totalAmount, "1200.0000");
      const updated = await db.transaction((tx) =>
        consolidateAssetTransfers(tx, f.org.orgId, august, f.actors.adminId),
      );
      assert.equal(updated.length, 1);
      assert.deepEqual(
        await db.transaction((tx) =>
          consolidateAssetTransfers(tx, f.org.orgId, august, f.actors.adminId),
        ),
        [],
      );
      const basis = (
        await db.execute<{ target_balances: Record<string, string> }>(
          sql`select target_balances from asset_transfer_consolidation_entries where org_id=${f.org.orgId} and journal_entry_id=${updated[0]}`,
        )
      ).rows[0]!.target_balances;
      assert.equal(basis[f.org.accounts.invAsset], "600.0000");
      assert.equal(basis[f.org.accounts.clearing], "-800.0000");
      assert.equal(basis[f.org.accounts.deferred], "50.0000");
      const impairment = await remeasureAsset(f.org.orgId, received, {
        date: "2026-08-31",
        newCarryingValue: "1100",
        actorId: f.actors.submitterId,
      });
      await assert.rejects(
        () =>
          db.transaction((tx) =>
            consolidateAssetTransfers(
              tx,
              f.org.orgId,
              august,
              f.actors.adminId,
            ),
          ),
        /Group valuation/,
      );
      const sourceEvent = (
        await db.execute<{ id: string }>(
          sql`select id from asset_events where org_id=${f.org.orgId} and asset_id=${received} and journal_entry_id=${impairment.entryId}`,
        )
      ).rows[0]!.id;
      const { proposeAssetGroupValuation, applyAssetGroupValuation } =
        await import("./group-valuations.ts");
      const groupInput = {
        sourceEventId: sourceEvent,
        effectiveOn: "2026-08-31",
        carryingValue: "1000",
        buyerToGroupRate: "1",
        assessment:
          "Receiving book fair value decline remains above the retained group carrying basis",
        reason:
          "Independent group recoverability assessment after the legal valuation",
        idempotencyKey: randomUUID(),
        remainingPlan: [{ date: "2026-09-30", amount: "1000" }],
      };
      const groupChange = await proposeAssetGroupValuation(
        f.org.orgId,
        received,
        f.actors.submitterId,
        groupInput,
      );
      await assert.rejects(
        () =>
          applyAssetGroupValuation(
            f.org.orgId,
            groupChange,
            f.actors.submitterId,
          ),
        /independent approval/,
      );
      await approve(f, groupChange);
      const measured = await applyAssetGroupValuation(
        f.org.orgId,
        groupChange,
        f.actors.submitterId,
      );
      assert.equal(measured.groupValuationDelta, "0.0000");
      assert.deepEqual(
        await applyAssetGroupValuation(
          f.org.orgId,
          groupChange,
          f.actors.submitterId,
        ),
        measured,
      );
      assert.equal(
        await proposeAssetGroupValuation(
          f.org.orgId,
          received,
          f.actors.submitterId,
          groupInput,
        ),
        groupChange,
      );
      const groupEntries = await db.transaction((tx) =>
        consolidateAssetTransfers(tx, f.org.orgId, august, f.actors.adminId),
      );
      assert.equal(groupEntries.length, 1);
      const measuredTarget = (
        await db.execute<{ target_balances: Record<string, string> }>(
          sql`select target_balances from asset_transfer_consolidation_entries where org_id=${f.org.orgId} and journal_entry_id=${groupEntries[0]}`,
        )
      ).rows[0]!.target_balances;
      assert.equal(measuredTarget[f.org.accounts.deferred], "25.0000");
      assert.equal(measuredTarget[f.org.accounts.recognized], "300.0000");
      assert.deepEqual(
        await db.transaction((tx) =>
          consolidateAssetTransfers(tx, f.org.orgId, august, f.actors.adminId),
        ),
        [],
      );

      // A separately identified part carries different legal and group ratios.
      const requestComponent = input(f, {
        effectiveOn: "2026-09-01",
        proceeds: "250",
        portion: {
          books: [
            {
              bookId: f.org.bookId,
              cost: "600",
              accumulated: "400",
              salvage: "0",
              group: {
                cost: "1200",
                accumulated: "900",
                salvage: "0",
                remainingPlan: [{ date: "2026-09-30", amount: "700" }],
              },
            },
          ],
        },
      });
      const component = await proposeAssetChange(
        f.org.orgId,
        received,
        f.actors.submitterId,
        requestComponent,
      );
      await approve(f, component);
      await assert.rejects(
        () =>
          db.transaction(async (tx) => {
            await tx.execute(sql`
              insert into asset_basis_changes
                (org_id,asset_id,book_id,change_id,effective_on,cost_delta,
                 accumulated_delta,salvage_delta,group_component,created_by)
              values (${f.org.orgId},${received},${f.org.bookId},${component},
                      '2026-09-01',-600,-400,0,null,${f.actors.submitterId})
            `);
          }),
        /group component basis must match its independently approved/,
        "publishing the approved legal disposal without its group measurement must fail",
      );
      await applyAssetChange(f.org.orgId, component, f.actors.submitterId);
      const frozen = (
        await db.execute<{
          group_component: { removedCost: string; removedAccumulated: string };
        }>(
          sql`select group_component from asset_basis_changes where org_id=${f.org.orgId} and change_id=${component} and book_id=${f.org.bookId}`,
        )
      ).rows[0]!.group_component;
      assert.equal(frozen.removedCost, "1200.0000");
      assert.equal(frozen.removedAccumulated, "900.0000");
      const september = (
        await db.execute<{ id: string }>(
          sql`select id from accounting_periods where org_id=${f.org.orgId} and name='2026-09'`,
        )
      ).rows[0]!.id;
      const componentEntries = await db.transaction((tx) =>
        consolidateAssetTransfers(
          tx,
          f.org.orgId,
          september,
          f.actors.adminId,
          "2026-09-01",
        ),
      );
      const componentTarget = (
        await db.execute<{ target_balances: Record<string, string> }>(
          sql`select target_balances from asset_transfer_consolidation_entries where org_id=${f.org.orgId} and journal_entry_id=${componentEntries[0]}`,
        )
      ).rows[0]!.target_balances;
      assert.equal(
        componentTarget[f.org.accounts.invAsset],
        "0.0000",
        "group retains 1800 cost, not 2250 inferred from buyer's fraction",
      );
      assert.equal(
        componentTarget[f.org.accounts.recognized],
        "400.0000",
        "the disposed component releases its independently measured margin",
      );
      assert.deepEqual(
        await db.transaction((tx) =>
          consolidateAssetTransfers(
            tx,
            f.org.orgId,
            september,
            f.actors.adminId,
            "2026-09-01",
          ),
        ),
        [],
      );
      const { proposeAssetReversal } =
        await import("./asset-change-reversals.ts");
      const correcting = await proposeAssetReversal(
        f.org.orgId,
        component,
        f.actors.submitterId,
        {
          effectiveOn: "2026-09-01",
          reason: "Correct identified sale before subsequent asset use",
          idempotencyKey: randomUUID(),
        },
      );
      await approve(f, correcting);
      await applyAssetChange(f.org.orgId, correcting, f.actors.submitterId);
      const { assetGroupHistory } =
        await import("../organization/asset-group-history.ts");
      const transfer = (
        await db.execute<{ id: string }>(
          sql`select id from asset_transfer_bases where org_id=${f.org.orgId} and receiving_asset_id=${received} and book_id=${f.org.bookId}`,
        )
      ).rows[0]!.id;
      const correctedHistory = await assetGroupHistory(
        db,
        f.org.orgId,
        transfer,
        "2026-09-01",
      );
      assert.ok(
        correctedHistory.every((e) => e.kind !== "component"),
        "linked correction removes the component only from effective history",
      );
      const correctedEntries = await db.transaction((tx) =>
        consolidateAssetTransfers(
          tx,
          f.org.orgId,
          september,
          f.actors.adminId,
          "2026-09-01",
        ),
      );
      const correctedTarget = (
        await db.execute<{ target_balances: Record<string, string> }>(
          sql`select target_balances from asset_transfer_consolidation_entries where org_id=${f.org.orgId} and journal_entry_id=${correctedEntries[0]}`,
        )
      ).rows[0]!.target_balances;
      assert.equal(correctedTarget[f.org.accounts.invAsset], "600.0000");
      assert.equal(correctedTarget[f.org.accounts.recognized], "300.0000");

      // A second internal owner must retain both sides of the impaired
      // component's service evidence, including its recoverable ceiling.
      const impairment2 = await remeasureAsset(f.org.orgId, received, {
        date: "2026-09-01",
        newCarryingValue: "900",
        actorId: f.actors.submitterId,
      });
      const source2 = (
        await db.execute<{ id: string }>(sql`
        select id from asset_events where org_id=${f.org.orgId}
          and asset_id=${received} and journal_entry_id=${impairment2.entryId}
      `)
      ).rows[0]!.id;
      const group2 = await proposeAssetGroupValuation(
        f.org.orgId,
        received,
        f.actors.submitterId,
        {
          ...groupInput,
          sourceEventId: source2,
          effectiveOn: "2026-09-01",
          carryingValue: "800",
          idempotencyKey: randomUUID(),
          remainingPlan: [{ date: "2026-09-30", amount: "800" }],
        },
      );
      await approve(f, group2);
      await applyAssetGroupValuation(f.org.orgId, group2, f.actors.submitterId);
      const nextBuyer = randomUUID();
      await db.execute(sql`
        insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
        values(${nextBuyer},${f.org.orgId},${f.org.subsidiaryId},'Next owner','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb)
      `);
      await db.execute(sql`
        insert into intercompany_pairs(org_id,from_subsidiary_id,to_subsidiary_id,due_from_account_id,due_to_account_id)
        values(${f.org.orgId},${buyer},${nextBuyer},${dueFrom},${dueTo})
      `);
      const onward = await proposeAssetChange(
        f.org.orgId,
        received,
        f.actors.submitterId,
        {
          ...request,
          effectiveOn: "2026-09-01",
          idempotencyKey: randomUUID(),
          proceeds: "250",
          portion: {
            books: [
              {
                bookId: f.org.bookId,
                cost: "600",
                accumulated: "400",
                salvage: "0",
                group: {
                  cost: "1200",
                  accumulated: "1000",
                  salvage: "0",
                  remainingPlan: [{ date: "2026-09-30", amount: "600" }],
                  removedPlan: [{ date: "2026-09-30", amount: "200" }],
                  unimpairedAccumulated: "900",
                  unimpairedRemainingPlan: [
                    { date: "2026-09-30", amount: "700" },
                  ],
                  unimpairedRemovedPlan: [
                    { date: "2026-09-30", amount: "300" },
                  ],
                },
              },
            ],
          },
          transfer: {
            ...request.transfer!,
            subsidiaryId: nextBuyer,
            assetNumber: "RECEIVED-2",
            buyerAmount: "250",
            lifeMonths: 1,
          },
        },
      );
      await approve(f, onward);
      const onwardResult = await applyAssetChange(
        f.org.orgId,
        onward,
        f.actors.submitterId,
      );
      const nextBasis = (
        await db.execute<{
          basis: {
            groupCost: string;
            groupAccumulated: string;
            groupPlan: { amount: string }[];
            groupUnimpaired: {
              accumulatedDelta: string;
              plan: { amount: string }[];
            };
          };
        }>(sql`
        select basis from asset_transfer_bases where org_id=${f.org.orgId}
          and receiving_asset_id=${String(onwardResult.receivingAssetId)} and book_id=${f.org.bookId}
      `)
      ).rows[0]!.basis;
      assert.equal(nextBasis.groupCost, "1200.0000");
      assert.equal(nextBasis.groupAccumulated, "1000.0000");
      assert.equal(nextBasis.groupPlan[0]!.amount, "200.0000");
      assert.equal(nextBasis.groupUnimpaired.accumulatedDelta, "-100.0000");
      assert.equal(nextBasis.groupUnimpaired.plan[0]!.amount, "300.0000");
    }),
);

test(
  "an approved reversal restores basis without deleting the disposal or its journal",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      const id = await proposeAssetChange(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        input(f),
      );
      await approve(f, id);
      const disposed = await applyAssetChange(
        f.org.orgId,
        id,
        f.actors.submitterId,
      );
      const { proposeAssetReversal } =
        await import("./asset-change-reversals.ts");
      const proposal = {
        effectiveOn: "2026-08-01",
        reason: "Sale rescinded before any subsequent use or ownership change",
        idempotencyKey: randomUUID(),
      };
      const reversal = await proposeAssetReversal(
        f.org.orgId,
        id,
        f.actors.submitterId,
        proposal,
      );
      await approve(f, reversal);
      const applied = await applyAssetChange(
        f.org.orgId,
        reversal,
        f.actors.submitterId,
      );
      assert.deepEqual(
        await applyAssetChange(f.org.orgId, reversal, f.actors.submitterId),
        applied,
      );
      assert.equal(
        await proposeAssetReversal(
          f.org.orgId,
          id,
          f.actors.submitterId,
          proposal,
        ),
        reversal,
      );
      assert.deepEqual(await carrying(f), {
        cost: "3000.0000",
        accumulated: "1000.0000",
        carrying_value: "2000.0000",
      });
      const original = (
        await db.execute<{ status: string }>(
          sql`select status from journal_entries where org_id=${f.org.orgId} and id=${(disposed.entryIds as string[])[0]}`,
        )
      ).rows[0]!;
      assert.equal(original.status, "reversed");
      const links = (
        await db.execute<{
          source_id: string;
          reversal_id: string | null;
          book_id: string;
          reversed_book: string | null;
        }>(
          sql`select e.id as source_id,r.id as reversal_id,e.book_id,r.book_id as reversed_book from asset_events e left join asset_events r on r.org_id=e.org_id and r.reverses_event_id=e.id where e.org_id=${f.org.orgId} and e.financial_change_id=${id}`,
        )
      ).rows;
      assert.ok(
        links.length > 0 &&
          links.every((e) => e.reversal_id && e.book_id === e.reversed_book),
        "each original event must have exactly linked book reversal evidence",
      );
      await db.execute(
        sql`update asset_categories set tax_attributes=jsonb_build_object('ca_cca_class','8') where org_id=${f.org.orgId} and id=${f.categoryId}`,
      );
      const restoredTax = await runTaxPool(
        f.org.orgId,
        f.org.bookId,
        f.org.subsidiaryId,
        "ca_cca",
        2026,
        {
          yearStart: "2026-01-01",
          yearEnd: "2026-12-31",
          actorId: f.actors.submitterId,
        },
      );
      assert.equal(
        restoredTax.lines[0]!.dispositions,
        "0.00",
        "a corrected disposal is not an active tax disposition",
      );
      assert.equal(restoredTax.lines[0]!.allowance, "300.00");

      const future = await runDepreciation(
        f.org.orgId,
        "2026-09-30",
        f.actors.submitterId,
        f.assetId,
      );
      assert.deepEqual(future.problems, []);
      assert.equal(future.totalAmount, "2000.0000");
    }),
);

test(
  "a failed later write rolls back every asset journal even when an ambient caller catches the refusal",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      const id = await proposeAssetChange(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        input(f),
      );
      await approve(f, id);
      const functionName = `reject_asset_${randomUUID().replaceAll("-", "")}`;
      try {
        await db.execute(
          sql.raw(
            `create function ${functionName}() returns trigger language plpgsql as $$ begin if new.org_id='${f.org.orgId}'::uuid then raise exception 'injected asset basis failure'; end if; return new; end $$`,
          ),
        );
        await db.execute(
          sql.raw(
            `create trigger ${functionName} before insert on asset_basis_changes for each row execute function ${functionName}()`,
          ),
        );
        await withOrg(f.org.orgId, async () => {
          await assert.rejects(() =>
            applyAssetChange(f.org.orgId, id, f.actors.submitterId),
          );
          assert.equal((await carrying(f)).cost, "3000.0000");
        });
        const count = (
          await db.execute<{ n: number }>(
            sql`select count(*)::int as n from journal_entries where org_id=${f.org.orgId} and entry_number like ${`AST-${id}%`}`,
          )
        ).rows[0]!.n;
        assert.equal(count, 0);
      } finally {
        await db.execute(
          sql.raw(
            `drop trigger if exists ${functionName} on asset_basis_changes`,
          ),
        );
        await db.execute(sql.raw(`drop function if exists ${functionName}()`));
      }
    }),
);

for (const impair of [false, true])
  test(
    `partial disposal retains production capacity${impair ? " after a later impairment" : ""}`,
    { skip: !DB },
    () =>
      fixture(async (f) => {
        await db.execute(
          sql`update fixed_assets set depreciation_method='units_of_production',depreciation_units_total=300 where org_id=${f.org.orgId} and id=${f.assetId}`,
        );
        await buildSchedule(
          f.assetId,
          f.org.orgId,
          f.actors.submitterId,
          f.org.bookId,
        );
        const folderId = randomUUID();
        await db.execute(
          sql`insert into folders(id,org_id,name,record_table,record_id,created_by,updated_by) values(${folderId},${f.org.orgId},'Production evidence','fixed_assets',${f.assetId},${f.actors.submitterId},${f.actors.submitterId})`,
        );
        const evidenceFileId = (
          await db.execute<{ id: string }>(
            sql`insert into files(org_id,folder_id,name,file_type,content_type,size_bytes,created_by,updated_by) values(${f.org.orgId},${folderId},'Production meter.pdf','pdf','application/pdf',1,${f.actors.submitterId},${f.actors.submitterId}) returning id`,
          )
        ).rows[0]!.id;
        await db.execute(
          sql`insert into file_attachments(org_id,file_id,target_table,target_id,created_by) values(${f.org.orgId},${evidenceFileId},'fixed_assets',${f.assetId},${f.actors.submitterId})`,
        );
        const evidence = {
          orgId: f.org.orgId,
          assetId: f.assetId,
          actorId: f.actors.submitterId,
          bookId: f.org.bookId,
          kind: "production_usage" as const,
          memo: "Meter readings from the retained production units",
          evidenceFileId,
        };
        const first = await recordDepreciationInput({
          ...evidence,
          effectiveDate: "2026-07-31",
          value: "100",
        });
        assert.equal(first.plannedAmount, "1000.0000");
        const posted = await runDepreciation(
          f.org.orgId,
          "2026-07-31",
          f.actors.submitterId,
          f.assetId,
        );
        assert.deepEqual(posted.problems, []);
        const id = await proposeAssetChange(
          f.org.orgId,
          f.assetId,
          f.actors.submitterId,
          input(f),
        );
        await approve(f, id);
        await applyAssetChange(f.org.orgId, id, f.actors.submitterId);
        const basis = (
          await db.execute<{ units: string; amount: string }>(
            sql`select units_remaining::text as units,depreciable_after::text as amount from asset_basis_changes where org_id=${f.org.orgId} and change_id=${id}`,
          )
        ).rows[0]!;
        assert.deepEqual(basis, { units: "150.0000", amount: "1500.0000" });
        if (impair)
          await remeasureAsset(f.org.orgId, f.assetId, {
            date: "2026-08-01",
            newCarryingValue: "1200",
            actorId: f.actors.submitterId,
          });
        const after = await recordDepreciationInput({
          ...evidence,
          effectiveDate: "2026-08-31",
          value: "75",
        });
        assert.equal(after.plannedAmount, impair ? "600.0000" : "750.0000");
        await assert.rejects(
          () =>
            recordDepreciationInput({
              ...evidence,
              effectiveDate: "2026-08-31",
              value: "151",
            }),
          /approved remaining capacity/,
        );
      }, false),
  );

test(
  "tax depreciation cannot silently omit an approved partial disposal",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      await db.execute(
        sql`update asset_categories set tax_attributes=jsonb_build_object('ca_cca_class','8') where org_id=${f.org.orgId} and id=${f.categoryId}`,
      );
      // A pre-event historical run is unaffected by the future book change.
      const id = await proposeAssetChange(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        input(f),
      );
      await approve(f, id);
      await applyAssetChange(f.org.orgId, id, f.actors.submitterId);
      await runTaxPool(
        f.org.orgId,
        f.org.bookId,
        f.org.subsidiaryId,
        "ca_cca",
        2025,
        {
          yearStart: "2025-01-01",
          yearEnd: "2025-12-31",
          actorId: f.actors.submitterId,
        },
      );
      const before = (
        await db.execute(
          sql`select * from tax_pool_periods where org_id=${f.org.orgId} order by id`,
        )
      ).rows;
      await assert.rejects(
        runTaxPool(
          f.org.orgId,
          f.org.bookId,
          f.org.subsidiaryId,
          "ca_cca",
          2026,
          {
            yearStart: "2026-01-01",
            yearEnd: "2026-12-31",
            actorId: f.actors.submitterId,
          },
        ),
        /requires native statutory basis treatment.*no tax result has been produced/,
      );
      assert.deepEqual(
        (
          await db.execute(
            sql`select * from tax_pool_periods where org_id=${f.org.orgId} order by id`,
          )
        ).rows,
        before,
        "refusal must persist no calculated tax period",
      );
    }),
);

test(
  "approved corrections retain non-posting book events without manufacturing GL entries",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      const secondary = randomUUID();
      await db.execute(
        sql`insert into accounting_books(id,org_id,code,name,is_primary,is_active,posts_gl) values(${secondary},${f.org.orgId},'ALT','Alternate non-posting',false,true,false)`,
      );
      await buildSchedule(
        f.assetId,
        f.org.orgId,
        f.actors.submitterId,
        secondary,
      );
      await runDepreciation(
        f.org.orgId,
        "2026-07-31",
        f.actors.submitterId,
        f.assetId,
      );
      const change = await proposeAssetChange(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        input(f),
      );
      await approve(f, change);
      await applyAssetChange(f.org.orgId, change, f.actors.submitterId);
      const { proposeAssetReversal } =
        await import("./asset-change-reversals.ts");
      const reverse = await proposeAssetReversal(
        f.org.orgId,
        change,
        f.actors.submitterId,
        {
          effectiveOn: "2026-08-01",
          reason: "Correction of the approved sale before further use",
          idempotencyKey: randomUUID(),
        },
      );
      await approve(f, reverse);
      await applyAssetChange(f.org.orgId, reverse, f.actors.submitterId);
      const rows = (
        await db.execute<{
          book_id: string;
          journal_entry_id: string | null;
          reverses_event_id: string | null;
        }>(
          sql`select book_id,journal_entry_id,reverses_event_id from asset_events where org_id=${f.org.orgId} and financial_change_id=${reverse} order by book_id`,
        )
      ).rows;
      assert.equal(rows.length, 2);
      assert.ok(rows.every((r) => r.reverses_event_id));
      assert.equal(
        rows.find((r) => r.book_id === secondary)!.journal_entry_id,
        null,
      );
      const basis = (
        await db.execute<{ cost: string }>(
          sql`select cost::text from asset_book_carrying_values where org_id=${f.org.orgId} and asset_id=${f.assetId} and book_id=${secondary}`,
        )
      ).rows[0]!;
      assert.equal(basis.cost, "3000.0000");
    }),
);
