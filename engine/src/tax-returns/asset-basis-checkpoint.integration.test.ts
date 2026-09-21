import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypassContext, withOrgContext } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedApprovalFlow, seedFlowActors,
  type FlowActors, type ScratchOrg } from "../testing/fixtures.ts";
import { submitFinancialChange } from "../flows/financial-changes-adapter.ts";
import { decideGate } from "../flows/gates.ts";
import { buildSchedule } from "../assets/depreciation.ts";
import { applyAssetChange, proposeAssetChange } from "../assets/asset-changes.ts";
import { applyTaxAssetBasis, listTaxAssetBasisSources, proposeTaxAssetBasis } from "./asset-basis-workpaper.ts";
import { ensureTaxYearWindow } from "./macrs-calendar.ts";
import type { TaxAssetBasisInput } from "./asset-basis-policy.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

async function approve(org: ScratchOrg, actors: FlowActors, id: string) {
  await submitFinancialChange(org.orgId, id, actors.submitterId);
  const gates = (await db.execute<{ id: string }>(sql`
    select id from flow_gates where org_id=${org.orgId}
      and subject_id=${id} and status='pending'`)).rows;
  assert.equal(gates.length, 1, "the native submission must create one approval gate");
  await decideGate({ gateId: gates[0]!.id, userId: actors.approver1Id, decision: "approved" });
}

test("an applied buyer-only declared MACRS checkpoint survives later source loading and replay", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    await withOrgContext(org.orgId, async () => {
      const actors = await seedFlowActors(org.orgId);
      await db.execute(sql`
        insert into user_permission_overrides(org_id,user_id,permission,effect)
        values(${org.orgId},${actors.submitterId},'assets.manage','grant')`);
      await seedApprovalFlow(org.orgId, {
        subjectKind: "financial_change", mode: "any", preventSelfApproval: false,
        assignees: [{ type: "user", userId: actors.approver1Id }],
      });

      const buyer = randomUUID(), elimination = randomUUID();
      const dueFrom = randomUUID(), dueTo = randomUUID();
      await db.execute(sql`
        insert into subsidiaries(id,org_id,parent_id,name,base_currency,country,tax_ids,is_elimination,is_active,custom)
        values(${buyer},${org.orgId},${org.subsidiaryId},'Checkpoint buyer','CAD','CA','{}'::jsonb,false,true,'{}'::jsonb),
          (${elimination},${org.orgId},${org.subsidiaryId},'Checkpoint elimination','CAD','CA','{}'::jsonb,true,true,'{}'::jsonb)`);
      for (const [id, number, type] of [
        [dueFrom, "1998", "asset_current_other"], [dueTo, "2998", "liability_current_other"],
      ]) {
        await db.execute(sql`
          insert into accounts(id,org_id,number,name,type,is_summary,is_active,eliminate,reconcilable,
            required_dimensions,custom,subsidiary_include_children)
          values(${id},${org.orgId},${number},${number},${type},false,true,true,false,'[]'::jsonb,'{}'::jsonb,true)`);
      }
      await db.execute(sql`
        insert into intercompany_pairs(org_id,from_subsidiary_id,to_subsidiary_id,due_from_account_id,due_to_account_id)
        values(${org.orgId},${org.subsidiaryId},${buyer},${dueFrom},${dueTo})`);

      const sellerCategory = randomUUID(), buyerCategory = randomUUID(), assetId = randomUUID();
      for (const [id, name, attributes] of [
        [sellerCategory, "Book-only seller", {}],
        [buyerCategory, "Classified MACRS buyer", { us_macrs_class: "gds_5" }],
      ] as const) {
        await db.execute(sql`
          insert into asset_categories(id,org_id,name,asset_account_id,accumulated_depreciation_account_id,
            depreciation_expense_account_id,gain_loss_account_id,default_method,default_life_months,
            default_convention,tax_attributes)
          values(${id},${org.orgId},${name},${org.accounts.invAsset},${org.accounts.clearing},
            ${org.accounts.adjustment},${org.accounts.adjustment},'straight_line',1,'full_month',${JSON.stringify(attributes)}::jsonb)`);
      }
      await db.execute(sql`
        insert into tax_regimes(org_id,code,name,country_code,calculation_model,class_attribute,is_active)
        values(${org.orgId},'us_macrs','United States MACRS','US','macrs','us_macrs_class',true)`);
      await db.execute(sql`
        insert into fixed_assets(id,org_id,subsidiary_id,category_id,asset_number,name,status,
          acquired_on,in_service_on,acquisition_cost,salvage_value,useful_life_months)
        values(${assetId},${org.orgId},${org.subsidiaryId},${sellerCategory},${`CHECK-${assetId}`},
          'Book asset with distinct statutory history','in_service','2026-07-01','2026-07-01',3000,0,1)`);
      await buildSchedule(assetId, org.orgId, actors.submitterId, org.bookId);
      const transferId = await proposeAssetChange(org.orgId, assetId, actors.submitterId, {
        operation: "intercompany_transfer", effectiveOn: "2026-07-01",
        reason: "Transfer to the legal entity with the MACRS classification",
        assessment: "Book basis is 3000; the buyer separately declares its statutory carryover history",
        idempotencyKey: randomUUID(), portion: { percent: "100" }, proceeds: "3600", proceedsAccountId: dueFrom,
        transfer: {
          subsidiaryId: buyer, categoryId: buyerCategory, assetNumber: `RECEIVED-${assetId}`,
          name: "Received MACRS checkpoint", buyerAmount: "3600", buyerSalvage: "0", lifeMonths: 1,
          payableAccountId: dueTo, eliminationSubsidiaryId: elimination,
          sellerToGroupRate: "1", buyerToGroupRate: "1", sellerToBuyerRate: "1",
          ctaAccountId: org.accounts.fxGainLoss, groupAssetAccountId: org.accounts.invAsset,
          groupAccumulatedAccountId: org.accounts.clearing, groupDepreciationAccountId: org.accounts.adjustment,
          groupGainLossAccountId: org.accounts.recognized, taxRatePercent: "25",
          deferredTaxAccountId: org.accounts.deferred, taxExpenseAccountId: org.accounts.fxGainLoss,
          exchangeRateEvidence: "Both legal entities and group report CAD at a rate of one",
          groupAssessment: "Preserve the original book cost of 3000 and eliminate the 600 margin",
        },
      });
      await approve(org, actors, transferId);
      const transferred = await applyAssetChange(org.orgId, transferId, actors.submitterId);
      assert.equal(typeof transferred.receivingAssetId, "string");
      const receivingAssetId = String(transferred.receivingAssetId);

      // Statutory history deliberately differs from both book purchase prices.
      // 5-year HY original 10000: prior years 2000+3200+1920; Jan–Jun 2026 576.
      for (const [subsidiaryId, years] of [
        [org.subsidiaryId, [2023, 2024, 2025, 2026]], [buyer, [2026]],
      ] as const) {
        for (const year of years) {
          await ensureTaxYearWindow(db, org.orgId, actors.submitterId, {
            subsidiaryId, regime: "us_macrs", yearStart: `${year}-01-01`, yearEnd: `${year}-12-31`,
            filingYear: year, reason: "Declared statutory calendar year for checkpoint history",
          });
        }
      }
      const source = (await listTaxAssetBasisSources(org.orgId, assetId, actors.submitterId))
        .sources.find((row) => row.sourceChangeId === transferId);
      assert.ok(source, "the applied book transfer must be selectable");
      assert.deepEqual(source.regimes.map(({ code, applicable }) => ({ code, applicable })), [
        { code: "us_macrs", applicable: "buyer" },
      ]);
      assert.equal(source.openMacrsVintages, null, "a buyer-only paper must not require invented seller history");
      const proposal: TaxAssetBasisInput = {
        sourceChangeId: transferId, reason: "Declare the buyer statutory carryover checkpoint",
        assessment: "Declared elections and regular depreciation conserve 10000 independently of book prices",
        idempotencyKey: randomUUID(), regimes: [{
          regime: "us_macrs", relationship: "non_arms_length", recognition: "nontaxable", relatedPerson: true,
          section168i7Kind: "nonrecognition", originalUnadjustedBasis: "10000.0000",
          placedInServiceOn: "2023-03-15", recoveryPeriodYears: "5", method: "200_db", convention: "half_year",
          section179: "0", bonusPercent: "0", businessUsePercent: "100", shortYearMethod: "allocation",
          priorDepreciation: "7696.0000", carryoverBasis: "2304.0000", excessBasis: "0",
        }],
      };
      const invalid: TaxAssetBasisInput = {
        ...proposal, idempotencyKey: randomUUID(),
        regimes: proposal.regimes.map((row) => ({ ...row, carryoverBasis: "10000.0000" })),
      };
      await assert.rejects(proposeTaxAssetBasis(org.orgId, assetId, actors.submitterId, invalid),
        /must equal original unadjusted basis/, "unbalanced declared history must refuse before persistence");
      assert.equal((await db.execute(sql`
        select id from financial_changes where org_id=${org.orgId}
          and idempotency_key=${invalid.idempotencyKey}`)).rows.length, 0,
      "refused declared history must not leave an approval candidate behind");
      const taxId = await proposeTaxAssetBasis(org.orgId, assetId, actors.submitterId, proposal);
      await approve(org, actors, taxId);
      const applied = await applyTaxAssetBasis(org.orgId, taxId, actors.submitterId);
      const stored = (await db.execute<{ facts: Record<string, unknown>; computed: Record<string, unknown> }>(sql`
        select facts,computed from tax_asset_basis_workpapers where org_id=${org.orgId}
          and change_id=${taxId} and regime='us_macrs'`)).rows;
      assert.equal(stored.length, 1);
      for (const key of ["checkpointKind", "takenBonus", "buyerVintages"])
        assert.equal(Object.hasOwn(stored[0]!.facts, key), false, `derived ${key} cannot become an operator declaration`);
      assert.equal(stored[0]!.facts.priorDepreciation, "7696.0000");

      const disposalId = await proposeAssetChange(org.orgId, receivingAssetId, actors.submitterId, {
        operation: "partial_disposal", effectiveOn: "2026-07-20", idempotencyKey: randomUUID(),
        reason: "Sell one quarter of the homogeneous received asset",
        assessment: "The book quarter and independently declared statutory allocation each retain their own basis",
        portion: { percent: "25" }, proceeds: "600", proceedsAccountId: org.accounts.clearing,
      });
      await approve(org, actors, disposalId);
      await applyAssetChange(org.orgId, disposalId, actors.submitterId);
      const loadLaterSource = async () => (await listTaxAssetBasisSources(org.orgId, receivingAssetId, actors.submitterId))
        .sources.find((row) => row.sourceChangeId === disposalId);
      const later = await loadLaterSource();
      assert.ok(later, "the buyer disposal must load its persisted transfer workpaper");
      const history = later.openMacrsVintages;
      assert.equal(history?.status, "ready", history?.status === "history_refused" ? history.refusal : "missing buyer history");
      if (history?.status !== "ready") return;
      assert.equal(history.vintages.length, 1);
      const vintage = history.vintages[0]!;
      assert.equal(vintage.checkpointKind, "taken_components");
      assert.equal(vintage.unadjustedBasis, "10000.0000");
      assert.equal(vintage.takenBonus, "0.0000");
      assert.equal(vintage.priorDepreciation, "7696.0000");
      assert.equal(vintage.adjustedCarryover, "2304.0000");
      assert.equal(vintage.shortYearMethod, "allocation");
      assert.deepEqual((await loadLaterSource())?.openMacrsVintages, history, "source reload must reconstruct the same dated history");

      const laterTaxId = await proposeTaxAssetBasis(org.orgId, receivingAssetId, actors.submitterId, {
        sourceChangeId: disposalId, reason: "Record the statutory portion from the persisted carryover",
        assessment: "A 2500 statutory slice leaves 7500; no book cost is substituted for the 10000 vintage",
        idempotencyKey: randomUUID(), regimes: [{
          regime: "us_macrs", relationship: "arms_length", recognition: "taxable", relatedPerson: false,
          dispositionTrigger: "sale", amountRealizedRule: "amount_realized", statutoryProceeds: "600",
          disposedUnadjustedBasis: "2500", remainingUnadjustedBasis: "7500",
          vintageAllocations: [{ source: vintage.source, placedInServiceOn: vintage.placedInServiceOn,
            ...(vintage.transferOn ? { transferOn: vintage.transferOn } : {}),
            ...(vintage.parentKey ? { parentKey: vintage.parentKey } : {}),
            disposedUnadjustedBasis: "2500", remainingUnadjustedBasis: "7500" }],
        }],
      });
      await approve(org, actors, laterTaxId);
      await applyTaxAssetBasis(org.orgId, laterTaxId, actors.submitterId);
      const citations = (await db.execute<{ count: string }>(sql`
        select count(*)::text as count from tax_basis_window_citations
         where org_id=${org.orgId} and workpaper_id in
           (select id from tax_asset_basis_workpapers where org_id=${org.orgId} and change_id=${laterTaxId})`)).rows[0];
      assert.ok(citations && Number(citations.count) > 0, "the loaded statutory history must create explicit immutable window citations");
      assert.deepEqual(await applyTaxAssetBasis(org.orgId, taxId, actors.submitterId), applied,
        "retrying the original application after the later disposal must use its original frozen result");
      assert.deepEqual((await db.execute<{ facts: Record<string, unknown>; computed: Record<string, unknown> }>(sql`
        select facts,computed from tax_asset_basis_workpapers where org_id=${org.orgId}
          and change_id=${taxId} and regime='us_macrs'`)).rows, stored,
      "dating a later source must not rewrite the first applied workpaper");
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
