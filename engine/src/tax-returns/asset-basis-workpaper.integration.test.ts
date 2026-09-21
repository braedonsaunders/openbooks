import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedApprovalFlow,
  seedFlowActors,
  type FlowActors,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import { buildSchedule } from "../assets/depreciation.ts";
import {
  applyAssetChange,
  proposeAssetChange,
  type AssetChangeInput,
} from "../assets/asset-changes.ts";
import {
  applyTaxAssetBasis,
  applyTaxAssetBasisReversal,
  listTaxAssetBasisSources,
  proposeTaxAssetBasis,
  proposeTaxAssetBasisReversal,
} from "./asset-basis-workpaper.ts";
import type { TaxAssetBasisInput } from "./asset-basis-policy.ts";
import { runTaxPool } from "./pool-run.ts";
import { ensureTaxYearWindow } from "./macrs-calendar.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
type Fixture = {
  org: ScratchOrg;
  actors: FlowActors;
  assetId: string;
  assetNumber: string;
  categoryId: string;
  sourceChangeId: string;
  receivingAssetId: string | null;
};

async function approve(f: Pick<Fixture, "org" | "actors">, changeId: string) {
  await submitFinancialChange(f.org.orgId, changeId, f.actors.submitterId);
  const gate = (
    await db.execute<{ id: string }>(sql`
      select id from flow_gates where org_id=${f.org.orgId}
       and subject_id=${changeId} and status='pending'`)
  ).rows[0];
  assert.ok(gate, "the real Flows submission must create an approval gate");
  await decideGate({
    gateId: gate.id,
    userId: f.actors.approver1Id,
    decision: "approved",
  });
}

/** Native book disposal and native Flows decisions: no forged approved rows. */
async function fixture(
  work: (f: Fixture) => Promise<void>,
  operation: AssetChangeInput["operation"] = "partial_disposal",
) {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await db.execute(sql`
      insert into user_permission_overrides(org_id,user_id,permission,effect)
      values(${org.orgId},${actors.submitterId},'assets.manage','grant')`);
    await seedApprovalFlow(org.orgId, {
      subjectKind: "financial_change",
      assignees: [{ type: "user", userId: actors.approver1Id }],
      mode: "any",
      preventSelfApproval: false,
    });
    const categoryId = randomUUID();
    const assetId = randomUUID();
    const assetNumber = `TAX-${assetId}`;
    await db.execute(sql`
      insert into asset_categories(id,org_id,name,asset_account_id,
        accumulated_depreciation_account_id,depreciation_expense_account_id,
        gain_loss_account_id,default_method,default_life_months,default_convention,tax_attributes)
      values(${categoryId},${org.orgId},'Governed tax component',${org.accounts.invAsset},
        ${org.accounts.clearing},${org.accounts.adjustment},${org.accounts.adjustment},
        'straight_line',1,'full_month','{"ca_cca_class":"8"}'::jsonb)`);
    await db.execute(sql`
      insert into fixed_assets(id,org_id,subsidiary_id,category_id,asset_number,name,status,
        acquired_on,in_service_on,acquisition_cost,salvage_value,useful_life_months)
      values(${assetId},${org.orgId},${org.subsidiaryId},${categoryId},${assetNumber},
        'Governed tax component','in_service','2026-07-01','2026-07-01',3000,0,1)`);
    await buildSchedule(assetId, org.orgId, actors.submitterId, org.bookId);
    let source: AssetChangeInput = {
      operation: "partial_disposal",
      effectiveOn: "2026-07-01",
      reason: "Sell one of four identical separately usable components",
      assessment:
        "Equal historical cost and service support the one-quarter allocation",
      idempotencyKey: randomUUID(),
      portion: { percent: "25" },
      proceeds: "600",
      proceedsAccountId: org.accounts.clearing,
    };
    if (operation === "intercompany_transfer") {
      source = await transferSource(org, assetId, categoryId, source);
    }
    const sourceChangeId = await proposeAssetChange(
      org.orgId,
      assetId,
      actors.submitterId,
      source,
    );
    await approve({ org, actors }, sourceChangeId);
    const applied = await applyAssetChange(
      org.orgId,
      sourceChangeId,
      actors.submitterId,
    );
    await work({
      org,
      actors,
      assetId,
      assetNumber,
      categoryId,
      sourceChangeId,
      receivingAssetId:
        operation === "intercompany_transfer"
          ? String(applied.receivingAssetId)
          : null,
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

async function transferSource(
  org: ScratchOrg,
  assetId: string,
  categoryId: string,
  source: AssetChangeInput,
): Promise<AssetChangeInput> {
  const buyer = randomUUID(),
    elimination = randomUUID(),
    dueFrom = randomUUID(),
    dueTo = randomUUID();
  await db.execute(sql`
    insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
    values(${buyer},${org.orgId},${org.subsidiaryId},'Buyer','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb),
      (${elimination},${org.orgId},${org.subsidiaryId},'Elimination','CAD','CA','{}'::jsonb,true,true,'{}'::jsonb)`);
  for (const [id, number, type] of [
    [dueFrom, "1998", "asset_current_other"],
    [dueTo, "2998", "liability_current_other"],
  ]) {
    await db.execute(sql`
      insert into accounts(id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,
        required_dimensions,custom,subsidiary_include_children)
      values(${id},${org.orgId},${number},${number},${type},false,true,true,false,'[]'::jsonb,'{}'::jsonb,true)`);
  }
  await db.execute(sql`
    insert into intercompany_pairs(org_id,from_subsidiary_id,to_subsidiary_id,due_from_account_id,due_to_account_id)
    values(${org.orgId},${org.subsidiaryId},${buyer},${dueFrom},${dueTo})`);
  return {
    ...source,
    operation: "intercompany_transfer",
    portion: { percent: "100" },
    proceeds: "3600",
    proceedsAccountId: dueFrom,
    reason: "Transfer the whole asset to the receiving legal entity",
    assessment:
      "The buyer pays 3600; the group retains its original 3000 basis",
    transfer: {
      subsidiaryId: buyer,
      categoryId,
      assetNumber: `BUY-${assetId}`,
      name: "Received tax asset",
      buyerAmount: "3600",
      buyerSalvage: "0",
      lifeMonths: 1,
      payableAccountId: dueTo,
      eliminationSubsidiaryId: elimination,
      sellerToGroupRate: "1",
      buyerToGroupRate: "1",
      sellerToBuyerRate: "1",
      ctaAccountId: org.accounts.fxGainLoss,
      groupAssetAccountId: org.accounts.invAsset,
      groupAccumulatedAccountId: org.accounts.clearing,
      groupDepreciationAccountId: org.accounts.adjustment,
      groupGainLossAccountId: org.accounts.recognized,
      taxRatePercent: "25",
      deferredTaxAccountId: org.accounts.deferred,
      taxExpenseAccountId: org.accounts.fxGainLoss,
      exchangeRateEvidence:
        "Both entities use CAD with transaction and historical rates of one",
      groupAssessment:
        "Retain the original 3000 basis and July service; eliminate the 600 internal margin",
    },
  };
}

function input(f: Fixture, proceeds = "600.00"): TaxAssetBasisInput {
  return {
    sourceChangeId: f.sourceChangeId,
    reason: "Record statutory basis for the disposed component",
    assessment:
      "One of four identical components: capital cost 750 and actual proceeds as recorded",
    idempotencyKey: randomUUID(),
    regimes: [
      {
        regime: "ca_cca",
        relationship: "arms_length",
        originalCapitalCost: "3000.00",
        allocationMethod: "ascertainable_fraction",
        allocationFraction: "0.25",
        statutoryProceeds: proceeds,
        rolloverElection: "none",
      },
    ],
  };
}

const runYear = async (f: Fixture) => {
  await ensureTaxYearWindow(db, f.org.orgId, f.actors.submitterId, {
    subsidiaryId: f.org.subsidiaryId,
    regime: "ca_cca",
    yearStart: "2026-01-01",
    yearEnd: "2026-12-31",
    filingYear: 2026,
    reason: "calendar-year tax window",
  });
  return runTaxPool(f.org.orgId, f.org.bookId, f.org.subsidiaryId, "ca_cca", 2026, {
    yearStart: "2026-01-01",
    yearEnd: "2026-12-31",
    actorId: f.actors.submitterId,
  });
};

async function usTransferInput(f: Fixture): Promise<TaxAssetBasisInput> {
  assert.ok(
    f.receivingAssetId,
    "this fixture must create a native transfer receiver",
  );
  await db.execute(sql`
    insert into tax_regimes(org_id,code,name,country_code,calculation_model,class_attribute,is_active)
    values(${f.org.orgId},'us_macrs','United States MACRS','US','macrs','us_macrs_class',true)`);
  await db.execute(sql`
    update asset_categories set tax_attributes=tax_attributes||'{"us_macrs_class":"gds_5"}'::jsonb
     where org_id=${f.org.orgId} and id=${f.categoryId}`);
  return {
    sourceChangeId: f.sourceChangeId,
    reason: "Record the taxable intercompany acquisition basis",
    assessment:
      "Related-party taxable transfer; buyer takes 3600 cost with its own new MACRS schedule",
    idempotencyKey: randomUUID(),
    regimes: [
      {
        regime: "us_macrs",
        relationship: "non_arms_length",
        dispositionTrigger: "sale",
        originalUnadjustedBasis: "3000",
        remainingUnadjustedBasis: "0",
        disposedUnadjustedBasis: "3000",
        placedInServiceOn: "2026-07-01",
        recoveryPeriodYears: "5",
        method: "200_db",
        convention: "half_year",
        recognition: "taxable",
        relatedPerson: true,
        amountRealizedRule: "amount_realized",
        statutoryProceeds: "3600",
        buyerCost: "3600",
      },
    ],
  };
}

async function changeReceiverClass(f: Fixture) {
  const updated = await db.execute(sql`
    update fixed_assets set custom=custom||'{"taxDepreciation":{"us_macrs":{"classCode":"ads_10"}}}'::jsonb
     where org_id=${f.org.orgId} and id=${f.receivingAssetId} returning id`);
  assert.equal(updated.rows.length, 1);
}

test(
  "US workpaper replay uses the original buyer schedule while still rejecting changed money",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      const proposal = await usTransferInput(f);
      const original = await applyApproved(f, proposal);
      const frozen = original.result.computed.us_macrs as Record<
        string,
        unknown
      >;
      assert.equal(frozen.buyerPlacedInServiceOn, "2026-07-01");
      assert.equal(frozen.buyerMethod, "200_db");
      assert.match(String(frozen.buyerRecoveryPeriodYears), /^5(?:\.0+)?$/);
      await changeReceiverClass(f);
      assert.equal(
        await proposeTaxAssetBasis(
          f.org.orgId,
          f.assetId,
          f.actors.submitterId,
          proposal,
        ),
        original.id,
        "an identical retry must not reload the receiver's later ADS class",
      );
      assert.deepEqual(
        await applyTaxAssetBasis(
          f.org.orgId,
          original.id,
          f.actors.submitterId,
        ),
        original.result,
      );
      await assert.rejects(
        proposeTaxAssetBasis(f.org.orgId, f.assetId, f.actors.submitterId, {
          ...proposal,
          regimes: proposal.regimes.map((row) =>
            row.regime === "us_macrs" ? { ...row, buyerCost: "3601" } : row,
          ),
        }),
        /request key.*different/,
        "preserving derived history must not hide a changed incoming buyer cost",
      );
      const evidence = (
        await db.execute<{ computed: Record<string, unknown> }>(sql`
      select computed from tax_asset_basis_workpapers where org_id=${f.org.orgId}
       and change_id=${original.id} and regime='us_macrs'`)
      ).rows[0];
      assert.deepEqual(evidence?.computed, frozen);
    }, "intercompany_transfer"),
);

test(
  "initial US workpaper application refuses a buyer schedule changed after approval",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      const proposal = await usTransferInput(f);
      const id = await proposeTaxAssetBasis(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        proposal,
      );
      await approve(f, id);
      await changeReceiverClass(f);
      await assert.rejects(
        applyTaxAssetBasis(f.org.orgId, id, f.actors.submitterId),
        /financial record changed after this proposal/,
        "only replay uses frozen derived inputs; first application must detect stale approval",
      );
      assert.equal(
        (
          await db.execute(sql`
      select id from tax_asset_basis_workpapers where org_id=${f.org.orgId} and change_id=${id}`)
        ).rows.length,
        0,
      );
    }, "intercompany_transfer"),
);

test(
  "CA propose then apply persists operator facts and freezes ITA 38(a) only in computed",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      const proposal = input(f);
      const id = await proposeTaxAssetBasis(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        proposal,
      );
      const change = (
        await db.execute<{ payload: Record<string, unknown> }>(sql`
          select payload from financial_changes
           where org_id=${f.org.orgId} and id=${id}`)
      ).rows[0];
      assert.ok(change, "the proposed tax basis change must exist");
      const regimes = change.payload.regimes;
      assert.ok(Array.isArray(regimes) && regimes[0] && typeof regimes[0] === "object");
      const stored = regimes[0] as Record<string, unknown>;
      assert.equal(stored.regime, "ca_cca");
      assert.equal(Object.hasOwn(stored, "capitalGainsInclusionRate"), false);
      assert.equal(Object.hasOwn(stored, "capitalGainsInclusionRateCitation"), false);
      assert.equal(stored.statutoryProceeds, "600.00");
      await approve(f, id);
      const result = await applyTaxAssetBasis(
        f.org.orgId,
        id,
        f.actors.submitterId,
      );
      assert.equal(result.effectiveOn, "2026-07-01");
      const paper = (
        await db.execute<{
          facts: Record<string, unknown>;
          computed: Record<string, unknown>;
        }>(sql`
          select facts, computed from tax_asset_basis_workpapers
           where org_id=${f.org.orgId} and change_id=${id} and regime='ca_cca'`)
      ).rows[0];
      assert.ok(paper, "apply must write the CA workpaper");
      assert.equal(paper.computed.capitalGainsInclusionRate, "0.5");
      assert.match(String(paper.computed.capitalGainsInclusionRateCitation ?? ""), /ITA 38\(a\)/);
      assert.equal(paper.computed.statutoryProceeds, "600.00");
      const persisted = (
        await db.execute<{ payload: Record<string, unknown> }>(sql`
          select payload from financial_changes
           where org_id=${f.org.orgId} and id=${id}`)
      ).rows[0];
      const afterApply = persisted?.payload.regimes;
      assert.ok(Array.isArray(afterApply) && afterApply[0] && typeof afterApply[0] === "object");
      assert.equal(
        Object.hasOwn(afterApply[0] as object, "capitalGainsInclusionRate"),
        false,
        "apply must not write the frozen rate back onto operator facts",
      );
      assert.deepEqual(
        await applyTaxAssetBasis(f.org.orgId, id, f.actors.submitterId),
        result,
      );
    }),
);

async function applyApproved(f: Fixture, proposal: TaxAssetBasisInput) {
  const id = await proposeTaxAssetBasis(
    f.org.orgId,
    f.assetId,
    f.actors.submitterId,
    proposal,
  );
  await approve(f, id);
  const result = await applyTaxAssetBasis(
    f.org.orgId,
    id,
    f.actors.submitterId,
  );
  return { id, result };
}

test(
  "native partial disposal reaches CCA once through independent tax approval",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      const sources = await listTaxAssetBasisSources(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
      );
      assert.equal(sources.sources.length, 1);
      assert.equal(sources.sources[0]!.sourceChangeId, f.sourceChangeId);
      assert.equal(sources.sources[0]!.regimes[0]!.applicable, "seller");
      await assert.rejects(runYear(f), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(
          error.message.includes(f.assetNumber),
          "refusal names the actual asset",
        );
        assert.match(error.message, /applied tax basis workpaper/i);
        return true;
      });
      assert.equal(
        (
          await db.execute(
            sql`select id from tax_pool_periods where org_id=${f.org.orgId}`,
          )
        ).rows.length,
        0,
      );
      const proposal = input(f);
      const id = await proposeTaxAssetBasis(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        proposal,
      );
      await assert.rejects(
        applyTaxAssetBasis(f.org.orgId, id, f.actors.submitterId),
        /independent approval/,
      );
      await approve(f, id);
      const result = await applyTaxAssetBasis(
        f.org.orgId,
        id,
        f.actors.submitterId,
      );
      assert.deepEqual(
        await applyTaxAssetBasis(f.org.orgId, id, f.actors.submitterId),
        result,
      );
      assert.equal(
        await proposeTaxAssetBasis(
          f.org.orgId,
          f.assetId,
          f.actors.submitterId,
          proposal,
        ),
        id,
      );
      const rows = (
        await db.execute<{
          disposition: string;
          buyer: string | null;
          remaining: string | null;
        }>(sql`
      select seller_disposition::text as disposition,buyer_addition::text as buyer,
        remaining_basis::text as remaining from tax_asset_basis_workpapers
       where org_id=${f.org.orgId} and change_id=${id}`)
      ).rows;
      assert.deepEqual(rows, [
        { disposition: "600.0000", buyer: null, remaining: null },
      ]);
      const run = await runYear(f);
      assert.equal(run.lines.length, 1);
      assert.equal(run.lines[0]!.additions, "3000.00");
      assert.equal(run.lines[0]!.dispositions, "600.00");
      assert.equal(run.lines[0]!.allowance, "240.00");
      assert.equal(run.lines[0]!.closingBalance, "2160.00");
      assert.deepEqual(
        await runYear(f),
        run,
        "rerun neither repeats the disposition nor compounds the allowance",
      );
      const changed = {
        ...input(f, "500.00"),
        idempotencyKey: proposal.idempotencyKey,
      };
      await assert.rejects(
        proposeTaxAssetBasis(
          f.org.orgId,
          f.assetId,
          f.actors.submitterId,
          changed,
        ),
        /request key.*different/,
      );
    }),
);

test(
  "approved tax reversal preserves book history and permits a controlled replacement",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      const proposal = input(f);
      const original = await applyApproved(f, proposal);
      await runYear(f);
      const bookEvents = (
        await db.execute(sql`
      select * from asset_events where org_id=${f.org.orgId} and financial_change_id=${f.sourceChangeId}
       order by id`)
      ).rows;
      const reversalInput = {
        reason: "Correct the independently assessed proceeds evidence",
        idempotencyKey: randomUUID(),
      };
      const reversalId = await proposeTaxAssetBasisReversal(
        f.org.orgId,
        original.id,
        f.actors.submitterId,
        reversalInput,
      );
      await assert.rejects(
        applyTaxAssetBasisReversal(
          f.org.orgId,
          reversalId,
          f.actors.submitterId,
        ),
        /independent approval/,
      );
      await approve(f, reversalId);
      const reversed = await applyTaxAssetBasisReversal(
        f.org.orgId,
        reversalId,
        f.actors.submitterId,
      );
      assert.deepEqual(
        await applyTaxAssetBasisReversal(
          f.org.orgId,
          reversalId,
          f.actors.submitterId,
        ),
        reversed,
      );
      assert.equal(
        await proposeTaxAssetBasisReversal(
          f.org.orgId,
          original.id,
          f.actors.submitterId,
          reversalInput,
        ),
        reversalId,
      );
      assert.equal(
        await proposeTaxAssetBasis(
          f.org.orgId,
          f.assetId,
          f.actors.submitterId,
          proposal,
        ),
        original.id,
      );
      const old = (
        await db.execute<{
          reversed_on: string;
          reversed_by_change_id: string;
          amount: string;
        }>(sql`
      select reversed_on::text,reversed_by_change_id,seller_disposition::text as amount
        from tax_asset_basis_workpapers where org_id=${f.org.orgId} and change_id=${original.id}`)
      ).rows;
      assert.deepEqual(old, [
        {
          reversed_on: "2026-07-01",
          reversed_by_change_id: reversalId,
          amount: "600.0000",
        },
      ]);
      await assert.rejects(runYear(f), /applied tax basis workpaper/i);
      await applyApproved(f, input(f, "500.00"));
      const corrected = await runYear(f);
      assert.equal(corrected.lines[0]!.dispositions, "500.00");
      assert.equal(corrected.lines[0]!.allowance, "250.00");
      assert.equal(corrected.lines[0]!.closingBalance, "2250.00");
      assert.deepEqual(
        (
          await db.execute(sql`
      select * from asset_events where org_id=${f.org.orgId} and financial_change_id=${f.sourceChangeId}
       order by id`)
        ).rows,
        bookEvents,
        "tax correction must not rewrite the book disposal",
      );
    }),
);

test(
  "workpaper storage rejects money different from the approved assessment",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      const id = await proposeTaxAssetBasis(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        input(f),
      );
      await approve(f, id);
      await assert.rejects(
        db.execute(sql`
      insert into tax_asset_basis_workpapers(org_id,asset_id,change_id,source_change_id,
        effective_on,source_operation,applicable,regime,assessment,facts,computed,created_by)
      select org_id,${f.assetId},id,${f.sourceChangeId},effective_on,'partial_disposal','seller',
        'ca_cca',payload->>'assessment',payload->'regimes'->0,
        jsonb_set(payload->'computed'->'ca_cca','{dispositionAmount}','"999.00"'::jsonb),${f.actors.submitterId}
      from financial_changes where org_id=${f.org.orgId} and id=${id}`),
        /facts and computed outcomes must match/,
      );
      assert.equal(
        (
          await db.execute(sql`
      select id from tax_asset_basis_workpapers where org_id=${f.org.orgId}`)
        ).rows.length,
        0,
      );
      const result = await applyTaxAssetBasis(
        f.org.orgId,
        id,
        f.actors.submitterId,
      );
      assert.equal(
        result.workpaperIds.length,
        1,
        "refused direct write must not poison the approved command",
      );
    }),
);

async function classifyUs(f: Fixture) {
  await db.execute(sql`
    insert into tax_regimes(org_id,code,name,country_code,calculation_model,class_attribute,is_active)
    values(${f.org.orgId},'us_macrs','United States MACRS','US','macrs','us_macrs_class',true)`);
  const updated = await db.execute(sql`
    update asset_categories set tax_attributes=tax_attributes||'{"us_macrs_class":"gds_5"}'::jsonb
     where org_id=${f.org.orgId} and id=${f.categoryId} returning id`);
  assert.equal(updated.rows.length, 1);
  await ensureTaxYearWindow(db, f.org.orgId, f.actors.submitterId, {
    subsidiaryId: f.org.subsidiaryId,
    regime: "us_macrs",
    yearStart: "2026-01-01",
    yearEnd: "2026-12-31",
    filingYear: 2026,
    reason: "calendar-year tax window",
  });
}

function usSellerPaper(
  f: Fixture,
  extras: Partial<Extract<TaxAssetBasisInput["regimes"][number], { regime: "us_macrs" }>> = {},
): TaxAssetBasisInput {
  return {
    sourceChangeId: f.sourceChangeId,
    reason: "Record the original MACRS vintage for the disposed component",
    assessment:
      "First seller declaration of the statutory vintage; remaining 2250 continues the same placed date",
    idempotencyKey: randomUUID(),
    regimes: [
      {
        regime: "us_macrs",
        relationship: "arms_length",
        dispositionTrigger: "sale",
        originalUnadjustedBasis: "3000.00",
        remainingUnadjustedBasis: "2250.00",
        disposedUnadjustedBasis: "750.00",
        placedInServiceOn: "2026-07-01",
        recoveryPeriodYears: "5",
        method: "200_db",
        convention: "half_year",
        recognition: "taxable",
        relatedPerson: false,
        amountRealizedRule: "amount_realized",
        statutoryProceeds: "600.00",
        ...extras,
      },
    ],
  };
}

test(
  "a later US source refuses first-declaration mode when an earlier source has no workpaper",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      await classifyUs(f);
      const first = (
        await listTaxAssetBasisSources(f.org.orgId, f.assetId, f.actors.submitterId)
      ).sources[0];
      assert.equal(first?.openMacrsVintages?.status, "original_declaration_required");
      const secondChangeId = await proposeAssetChange(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        {
          operation: "partial_disposal",
          effectiveOn: "2026-08-01",
          reason: "Sell a second identical component",
          assessment:
            "Equal historical cost and service support the second quarter allocation",
          idempotencyKey: randomUUID(),
          portion: { percent: "25" },
          proceeds: "600",
          proceedsAccountId: f.org.accounts.clearing,
        },
      );
      await approve(f, secondChangeId);
      await applyAssetChange(f.org.orgId, secondChangeId, f.actors.submitterId);
      const second = (
        await listTaxAssetBasisSources(f.org.orgId, f.assetId, f.actors.submitterId)
      ).sources.find((row) => row.sourceChangeId === secondChangeId);
      assert.ok(second, "the second posted disposal must be a tax source");
      assert.equal(second.openMacrsVintages?.status, "history_refused");
      if (second.openMacrsVintages?.status === "history_refused") {
        assert.match(second.openMacrsVintages.refusal, /do not treat a missing prerequisite paper as a first original declaration/);
      }
      await assert.rejects(
        proposeTaxAssetBasis(f.org.orgId, f.assetId, f.actors.submitterId, {
          ...usSellerPaper(f),
          sourceChangeId: secondChangeId,
          idempotencyKey: randomUUID(),
        }),
        /do not treat a missing prerequisite paper as a first original declaration/,
      );
    }),
);

test(
  "US seller source context requires an original declaration then revalidates open vintage keys",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      await classifyUs(f);
      const firstSources = await listTaxAssetBasisSources(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
      );
      assert.equal(firstSources.sources[0]!.openMacrsVintages?.status, "original_declaration_required");
      await applyApproved(f, usSellerPaper(f));

      const secondChangeId = await proposeAssetChange(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        {
          operation: "partial_disposal",
          effectiveOn: "2026-08-01",
          reason: "Sell a second identical component",
          assessment:
            "Equal historical cost and service support the second quarter allocation",
          idempotencyKey: randomUUID(),
          portion: { percent: "25" },
          proceeds: "600",
          proceedsAccountId: f.org.accounts.clearing,
        },
      );
      await approve(f, secondChangeId);
      await applyAssetChange(f.org.orgId, secondChangeId, f.actors.submitterId);

      const listed = await listTaxAssetBasisSources(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
      );
      const second = listed.sources.find((row) => row.sourceChangeId === secondChangeId);
      assert.ok(second, "the second posted disposal must be a tax source");
      assert.equal(second.openMacrsVintages?.status, "ready");
      if (second.openMacrsVintages?.status !== "ready") return;
      assert.deepEqual(second.openMacrsVintages.vintages.map((row) => row.key), [
        "original:2026-07-01",
      ]);
      assert.equal(second.openMacrsVintages.vintages[0]!.unadjustedBasis, "2250.0000");

      const readyBase = {
        sourceChangeId: secondChangeId,
        reason: "Allocate the remaining MACRS vintage for the second component",
        assessment:
          "The remaining open vintage is the first declaration's leftover unadjusted basis",
        idempotencyKey: randomUUID(),
        regimes: [
          {
            regime: "us_macrs" as const,
            relationship: "arms_length" as const,
            dispositionTrigger: "sale" as const,
            remainingUnadjustedBasis: "1500.00",
            disposedUnadjustedBasis: "750.00",
            recognition: "taxable" as const,
            relatedPerson: false,
            amountRealizedRule: "amount_realized" as const,
            statutoryProceeds: "600.00",
          },
        ],
      };
      await assert.rejects(
        proposeTaxAssetBasis(f.org.orgId, f.assetId, f.actors.submitterId, readyBase),
        /vintageAllocations must name every open MACRS vintage/,
      );
      await assert.rejects(
        proposeTaxAssetBasis(f.org.orgId, f.assetId, f.actors.submitterId, {
          ...readyBase,
          idempotencyKey: randomUUID(),
          regimes: readyBase.regimes.map((row) => ({
            ...row,
            vintageAllocations: [
              {
                source: "carryover",
                placedInServiceOn: "2023-03-15",
                transferOn: "2025-08-01",
                disposedUnadjustedBasis: "750.00",
                remainingUnadjustedBasis: "1500.00",
              },
            ],
          })),
        }),
        /is not an open MACRS vintage/,
      );
      const proposed = await proposeTaxAssetBasis(f.org.orgId, f.assetId, f.actors.submitterId, {
        ...readyBase,
        idempotencyKey: randomUUID(),
        regimes: readyBase.regimes.map((row) => ({
          ...row,
          vintageAllocations: [
            {
              source: "original",
              placedInServiceOn: "2026-07-01",
              disposedUnadjustedBasis: "750.00",
              remainingUnadjustedBasis: "1500.00",
            },
          ],
        })),
      });
      assert.ok(proposed);
    }),
);

test(
  "a first-declaration paper with empty taxYearWindows still dates 2023–2025 on a later source",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      await classifyUs(f);
      for (const year of [2023, 2024, 2025]) {
        await ensureTaxYearWindow(db, f.org.orgId, f.actors.submitterId, {
          subsidiaryId: f.org.subsidiaryId,
          regime: "us_macrs",
          yearStart: `${year}-01-01`,
          yearEnd: `${year}-12-31`,
          filingYear: year,
          reason: "calendar-year tax window",
        });
      }
      const first = await applyApproved(f, usSellerPaper(f, { placedInServiceOn: "2023-01-01" }));
      const stored = (
        await db.execute<{ tax_year_windows: unknown }>(sql`
          select computed->'taxYearWindows' as tax_year_windows
            from tax_asset_basis_workpapers
           where org_id=${f.org.orgId} and change_id=${first.id} and regime='us_macrs'`)
      ).rows[0];
      assert.deepEqual(stored?.tax_year_windows, []);

      const secondChangeId = await proposeAssetChange(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        {
          operation: "partial_disposal",
          effectiveOn: "2026-08-01",
          reason: "Sell a second identical component",
          assessment:
            "Equal historical cost and service support the second quarter allocation",
          idempotencyKey: randomUUID(),
          portion: { percent: "25" },
          proceeds: "600",
          proceedsAccountId: f.org.accounts.clearing,
        },
      );
      await approve(f, secondChangeId);
      await applyAssetChange(f.org.orgId, secondChangeId, f.actors.submitterId);
      const second = (
        await listTaxAssetBasisSources(f.org.orgId, f.assetId, f.actors.submitterId)
      ).sources.find((row) => row.sourceChangeId === secondChangeId);
      assert.ok(second, "the later posted disposal must be a tax source");
      assert.equal(second.openMacrsVintages?.status, "ready");
      if (second.openMacrsVintages?.status !== "ready") return;
      const starts = (second.openMacrsVintages.taxYearWindows ?? []).map((row) => row.yearStart);
      assert.ok(starts.includes("2023-01-01"), "2023 history must be read after an empty first declaration");
      assert.ok(starts.includes("2024-01-01"));
      assert.ok(starts.includes("2025-01-01"));
      const proposed = await proposeTaxAssetBasis(f.org.orgId, f.assetId, f.actors.submitterId, {
        sourceChangeId: secondChangeId,
        reason: "Allocate the remaining MACRS vintage after the first declaration",
        assessment: "Ready history must still walk 2023 through this source",
        idempotencyKey: randomUUID(),
        regimes: [{
          regime: "us_macrs",
          relationship: "arms_length",
          dispositionTrigger: "sale",
          remainingUnadjustedBasis: "1500.00",
          disposedUnadjustedBasis: "750.00",
          recognition: "taxable",
          relatedPerson: false,
          amountRealizedRule: "amount_realized",
          statutoryProceeds: "600.00",
          vintageAllocations: [{
            source: "original",
            placedInServiceOn: "2023-01-01",
            disposedUnadjustedBasis: "750.00",
            remainingUnadjustedBasis: "1500.00",
          }],
        }],
      });
      assert.ok(proposed);
    }),
);

test(
  "a later source can use a context-only successor's own later convention year",
  { skip: !DB },
  () =>
    fixture(async (f) => {
      await db.execute(sql`
        insert into tax_regimes(org_id,code,name,country_code,calculation_model,class_attribute,is_active)
        values(${f.org.orgId},'us_macrs','United States MACRS','US','macrs','us_macrs_class',true)`);
      await db.execute(sql`
        update asset_categories set tax_attributes=tax_attributes||'{"us_macrs_class":"gds_5"}'::jsonb
         where org_id=${f.org.orgId} and id=${f.categoryId}`);
      const w1 = await ensureTaxYearWindow(db, f.org.orgId, f.actors.submitterId, {
        subsidiaryId: f.org.subsidiaryId,
        regime: "us_macrs",
        yearStart: "2026-07-01",
        yearEnd: "2026-07-15",
        filingYear: 2026,
        reason: "first short year",
      });
      const w2 = await ensureTaxYearWindow(db, f.org.orgId, f.actors.submitterId, {
        subsidiaryId: f.org.subsidiaryId,
        regime: "us_macrs",
        yearStart: "2026-07-16",
        yearEnd: "2026-09-15",
        filingYear: 2026,
        reason: "convention-only successor",
      });
      await applyApproved(f, usSellerPaper(f));
      const secondChangeId = await proposeAssetChange(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        {
          operation: "partial_disposal",
          effectiveOn: "2026-07-10",
          reason: "Sell a second identical component",
          assessment: "Source still in the first short year so W2 is convention context only",
          idempotencyKey: randomUUID(),
          portion: { percent: "25" },
          proceeds: "600",
          proceedsAccountId: f.org.accounts.clearing,
        },
      );
      await approve(f, secondChangeId);
      await applyAssetChange(f.org.orgId, secondChangeId, f.actors.submitterId);
      const readySecond = await proposeTaxAssetBasis(f.org.orgId, f.assetId, f.actors.submitterId, {
        sourceChangeId: secondChangeId,
        reason: "Freeze W1 calculation and W2 as convention context",
        assessment: "W2 yearStart is after this source; do not seal W2 absence",
        idempotencyKey: randomUUID(),
        regimes: [{
          regime: "us_macrs",
          relationship: "arms_length",
          dispositionTrigger: "sale",
          remainingUnadjustedBasis: "1500.00",
          disposedUnadjustedBasis: "750.00",
          recognition: "taxable",
          relatedPerson: false,
          amountRealizedRule: "amount_realized",
          statutoryProceeds: "600.00",
          vintageAllocations: [{
            source: "original",
            placedInServiceOn: "2026-07-01",
            disposedUnadjustedBasis: "750.00",
            remainingUnadjustedBasis: "1500.00",
          }],
        }],
      });
      await approve(f, readySecond);
      await applyTaxAssetBasis(f.org.orgId, readySecond, f.actors.submitterId);
      const secondWindows = (
        await db.execute<{ tax_year_windows: { id: string; yearStart: string }[] }>(sql`
          select computed->'taxYearWindows' as tax_year_windows
            from tax_asset_basis_workpapers
           where org_id=${f.org.orgId} and change_id=${readySecond} and regime='us_macrs'`)
      ).rows[0]?.tax_year_windows ?? [];
      assert.ok(secondWindows.some((row) => row.id === w1.id));
      assert.ok(secondWindows.some((row) => row.id === w2.id));

      const w3 = await ensureTaxYearWindow(db, f.org.orgId, f.actors.submitterId, {
        subsidiaryId: f.org.subsidiaryId,
        regime: "us_macrs",
        yearStart: "2026-09-16",
        yearEnd: "2026-12-31",
        filingYear: 2026,
        reason: "later convention year for W2",
      });
      const thirdChangeId = await proposeAssetChange(
        f.org.orgId,
        f.assetId,
        f.actors.submitterId,
        {
          operation: "partial_disposal",
          effectiveOn: "2026-10-01",
          reason: "Sell a third identical component",
          assessment: "W2 is now a calculated year and may read W3 as convention context",
          idempotencyKey: randomUUID(),
          portion: { percent: "25" },
          proceeds: "600",
          proceedsAccountId: f.org.accounts.clearing,
        },
      );
      await approve(f, thirdChangeId);
      await applyAssetChange(f.org.orgId, thirdChangeId, f.actors.submitterId);
      const third = (
        await listTaxAssetBasisSources(f.org.orgId, f.assetId, f.actors.submitterId)
      ).sources.find((row) => row.sourceChangeId === thirdChangeId);
      assert.ok(third, "the later posted disposal must be a tax source");
      assert.equal(third.openMacrsVintages?.status, "ready");
      if (third.openMacrsVintages?.status !== "ready") return;
      const laterIds = (third.openMacrsVintages.taxYearWindows ?? []).map((row) => row.id);
      assert.ok(laterIds.includes(w3.id), "W3 must be readable as W2 convention context, not excluded by a sealed W2 absence");
      const proposed = await proposeTaxAssetBasis(f.org.orgId, f.assetId, f.actors.submitterId, {
        sourceChangeId: thirdChangeId,
        reason: "Continue the remaining vintage after W3 was declared",
        assessment: "Context-only W2 must not have frozen successor absence",
        idempotencyKey: randomUUID(),
        regimes: [{
          regime: "us_macrs",
          relationship: "arms_length",
          dispositionTrigger: "sale",
          remainingUnadjustedBasis: "750.00",
          disposedUnadjustedBasis: "750.00",
          recognition: "taxable",
          relatedPerson: false,
          amountRealizedRule: "amount_realized",
          statutoryProceeds: "600.00",
          vintageAllocations: [{
            source: "original",
            placedInServiceOn: "2026-07-01",
            disposedUnadjustedBasis: "750.00",
            remainingUnadjustedBasis: "750.00",
          }],
        }],
      });
      assert.ok(proposed);
    }),
);
