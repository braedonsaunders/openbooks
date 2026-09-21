import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { lockAssetTaxLifecycle } from "../organization/asset-tax-fence.ts";
import { lockAssetRow } from "../assets/asset-lifecycle.ts";
import { assertFinancialChangeAccess } from "../organization/financial-change-access.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import {
  db,
  withOrg,
  withTransactionSavepoint,
  type SqlExecutor,
} from "../platform/db.ts";
import {
  assertFinancialChangeApproved,
  completeFinancialChange,
  existingFinancialChange,
  loadFinancialChange,
  proposeFinancialChange,
} from "../platform/financial-changes.ts";
import {
  TAX_BASIS_SOURCE_KINDS,
  TAX_BASIS_SOURCE_OPERATIONS,
  allocatedCaCapitalCost,
  auPoolReduction,
  auTerminationValue,
  caBuyerAddition,
  caDispositionAmount,
  caStatutoryProceeds,
  declaredTaxRegimeFacts,
  freezeCaRegimeBasis,
  nzAssociatedPersonEquivalentRate,
  nzBuyerDepreciationCost,
  nzPoolReduction,
  taxBasisApplicableSide,
  taxBasisSideApplies,
  taxBasisSourceOperation,
  taxBasisSourceRegimes,
  ukDisposalValue,
  usRegimeWorkpaperOutcome,
  validateTaxAssetBasisInput,
  isTaxBasisCalendarDate,
  type TaxAssetBasisApplyResult,
  type TaxAssetBasisInput,
  type TaxAssetBasisSourceChoice,
  type TaxAssetBasisSourcesResponse,
  type TaxBasisApplicableSide,
  type TaxBasisRegime,
  type TaxBasisSourceKind,
  type TaxBasisSourceOperation,
  type TaxRegimeBasis,
  type UsBuyerMacrsSchedule,
  type UsMacrsRegimeBasis,
  type UsSellerMacrsVintageContext,
} from "./asset-basis-policy.ts";
import {
  classifyAssetFromContext,
  classifyAssetRegimes,
  effectiveClasses,
  loadRegimeClassificationContext,
  regimeClassAttribute,
  type ClassifiedRegime,
} from "./tax-classification.ts";
import {
  sellerMacrsHistoryBeforeSource,
  type MacrsVintageDefaults,
  type MacrsWorkpaperEvent,
} from "./macrs-vintages.ts";
import { refreshOpenMacrsVintageThrough } from "./depreciation-pool.ts";
import { loadOrgMacrsWindows } from "./macrs-calendar.ts";

export class TaxAssetBasisError extends Error {
  readonly name = "TaxAssetBasisError";
}

type ResolvedSource = {
  sourceChangeId: string | null;
  sourceEventId: string | null;
  sourceOperation: TaxBasisSourceOperation;
  sourceKind: TaxBasisSourceKind;
  effectiveOn: string;
  sellerAssetId: string;
  receivingAssetId: string | null;
  requiredSubsidiaryIds: string[];
  sellerOpen: boolean;
};

export function computeTaxRegimeOutcome(
  row: TaxRegimeBasis,
  sourceOperation: TaxBasisSourceOperation,
  applicable: TaxBasisApplicableSide,
  buyerSchedule?: UsBuyerMacrsSchedule | null,
): Record<string, unknown> {
  const seller = taxBasisSideApplies(applicable, "seller");
  const buyer = sourceOperation === "intercompany_transfer" && taxBasisSideApplies(applicable, "buyer");
  if (row.regime === "ca_cca") {
    return {
      allocatedCapitalCost: seller ? allocatedCaCapitalCost(row) : null,
      statutoryProceeds: seller ? caStatutoryProceeds(row) : null,
      dispositionAmount: seller ? caDispositionAmount(row) : null,
      buyerAddition: buyer ? caBuyerAddition(row) : null,
      capitalGainsInclusionRate: row.capitalGainsInclusionRate ?? null,
      capitalGainsInclusionRateCitation: row.capitalGainsInclusionRateCitation ?? null,
    };
  }
  if (row.regime === "uk_wda") {
    return {
      disposalValue: seller ? ukDisposalValue(row) : null,
      buyerQualifyingExpenditure: buyer ? row.buyerQualifyingExpenditure ?? null : null,
    };
  }
  if (row.regime === "au_pool") {
    return {
      terminationValue: seller ? auTerminationValue(row) : null,
      poolReduction: seller ? auPoolReduction(row) : null,
      buyerCost: buyer ? row.buyerCost ?? null : null,
    };
  }
  if (row.regime === "nz_pool") {
    return {
      poolReduction: seller ? nzPoolReduction(row) : null,
      buyerDepreciationCost: buyer ? nzBuyerDepreciationCost(row) : null,
      associatedPersonEquivalentRate: buyer ? nzAssociatedPersonEquivalentRate(row) : null,
    };
  }
  return usRegimeWorkpaperOutcome(row as UsMacrsRegimeBasis, sourceOperation, applicable, buyerSchedule);
}

function workpaperPayload(
  validated: TaxAssetBasisInput,
  derived: {
    sourceOperation: TaxBasisSourceOperation;
    effectiveOn: string;
    sellerAssetId: string;
    receivingAssetId: string | null;
    requiredSubsidiaryIds: string[];
    applicable: Record<string, TaxBasisApplicableSide>;
  },
  frozen: { facts: TaxRegimeBasis; computed: Record<string, unknown>; applicable: TaxBasisApplicableSide }[],
) {
  return {
    sourceChangeId: validated.sourceChangeId ?? null,
    sourceEventId: validated.sourceEventId ?? null,
    sourceOperation: derived.sourceOperation,
    effectiveOn: derived.effectiveOn,
    sellerAssetId: derived.sellerAssetId,
    receivingAssetId: derived.receivingAssetId,
    requiredSubsidiaryIds: derived.requiredSubsidiaryIds,
    applicable: derived.applicable,
    assessment: validated.assessment,
    regimes: frozen.map((row) => declaredTaxRegimeFacts(row.facts)),
    computed: Object.fromEntries(frozen.map((row) => [row.facts.regime, row.computed])),
  };
}

function assertClassifiedRegimes(
  regimes: TaxRegimeBasis[],
  seller: { code: TaxBasisRegime; name: string }[],
  receiver: { code: TaxBasisRegime; name: string }[],
  transfer: boolean,
): void {
  for (const row of regimes) {
    const applicable = taxBasisApplicableSide(
      seller.some((item) => item.code === row.regime),
      transfer && receiver.some((item) => item.code === row.regime),
    );
    if (!applicable) {
      throw new TaxAssetBasisError(
        `neither the seller nor the receiving asset is classified for ${row.regime}; assign the tax class on the applicable Tax tab — do not invent a classification to collect inapplicable facts`,
      );
    }
  }
}

async function sourceKindForChange(
  tx: SqlExecutor,
  orgId: string,
  sourceChangeId: string,
  sellerAssetId: string,
  fallback: TaxBasisSourceKind,
): Promise<TaxBasisSourceKind> {
  const rows = (
    await tx.execute<{ kind: string }>(sql`
      select distinct kind from asset_events
       where org_id=${orgId} and financial_change_id=${sourceChangeId}
         and asset_id=${sellerAssetId}
         and kind in ('partially_disposed','transferred','disposed','written_off')`)
  ).rows;
  const kinds = [...new Set(rows.map((row) => row.kind))];
  if (kinds.length > 1) {
    throw new TaxAssetBasisError(
      "the source change's posted events disagree on disposal versus transfer kind; correct the book events before recording tax basis",
    );
  }
  if (kinds[0] && (TAX_BASIS_SOURCE_KINDS as readonly string[]).includes(kinds[0])) {
    return kinds[0] as TaxBasisSourceKind;
  }
  return fallback;
}

function classifiedApplicable(
  seller: { code: TaxBasisRegime; name: string }[],
  receiver: { code: TaxBasisRegime; name: string }[],
  transfer: boolean,
): Record<string, TaxBasisApplicableSide> {
  return Object.fromEntries(
    taxBasisSourceRegimes(seller, receiver, transfer).map((row) => [row.code, row.applicable]),
  );
}

async function loadUsBuyerMacrsSchedule(
  tx: SqlExecutor,
  orgId: string,
  receivingAssetId: string,
): Promise<UsBuyerMacrsSchedule> {
  const attr = await regimeClassAttribute(tx, orgId, "us_macrs");
  const row = (
    await tx.execute<{ placed_on: string | null; class_code: string }>(sql`
      select coalesce(a.in_service_on, a.acquired_on)::text as placed_on,
             coalesce(a.custom->'taxDepreciation'->'us_macrs'->>'classCode', c.tax_attributes->>${attr}, '') as class_code
        from fixed_assets a
        join asset_categories c on c.org_id=a.org_id and c.id=a.category_id
       where a.org_id=${orgId} and a.id=${receivingAssetId}`)
  ).rows[0];
  if (!row) throw new TaxAssetBasisError("receiving asset not found");
  if (!row.placed_on || !isTaxBasisCalendarDate(row.placed_on)) {
    throw new TaxAssetBasisError(
      "the receiving asset has no placed-in-service date; set in_service_on or acquired_on on the receiving asset — do not inherit the transferor's placedInServiceOn",
    );
  }
  const classes = await effectiveClasses(tx, orgId, "us_macrs");
  const def = classes.get(row.class_code);
  if (!def?.recoveryPeriodYears || !def.macrsMethod || !def.convention) {
    throw new TaxAssetBasisError(
      `the receiving asset is missing a complete ${row.class_code || "MACRS"} class; assign the US tax class on the receiving asset's Tax tab — do not inherit the transferor's recovery period, method or convention`,
    );
  }
  return {
    placedInServiceOn: row.placed_on,
    recoveryPeriodYears: String(def.recoveryPeriodYears),
    method: def.macrsMethod,
    convention: def.convention,
  };
}

async function freezeRegimes(
  tx: SqlExecutor,
  orgId: string,
  regimes: TaxRegimeBasis[],
  sourceOperation: TaxBasisSourceOperation,
  effectiveOn: string,
  applicableByRegime: Readonly<Partial<Record<TaxBasisRegime, TaxBasisApplicableSide>>>,
  receivingAssetId: string | null,
  replay?: { computed: Record<string, unknown> },
): Promise<{ facts: TaxRegimeBasis; computed: Record<string, unknown>; applicable: TaxBasisApplicableSide }[]> {
  const needsBuyerSchedule = regimes.some(
    (row) =>
      row.regime === "us_macrs" &&
      sourceOperation === "intercompany_transfer" &&
      taxBasisSideApplies(applicableByRegime[row.regime], "buyer"),
  );
  let buyerSchedule: UsBuyerMacrsSchedule | null = null;
  if (needsBuyerSchedule) {
    if (!receivingAssetId) {
      throw new TaxAssetBasisError(
        "a US receiving tax asset is required to freeze the buyer MACRS schedule; this intercompany transfer has no receiving asset",
      );
    }
    if (replay) {
      // Replay checks the NEW operator facts against the ORIGINAL derived
      // schedule. Reloading today's class/date would reject an unchanged
      // request after the asset has legitimately advanced. The outcome policy
      // below validates these stored fields before they are compared.
      const computed = replay.computed.us_macrs;
      if (!computed || typeof computed !== "object" || Array.isArray(computed)) {
        throw new TaxAssetBasisError(
          "the original US workpaper is missing its frozen buyer schedule; inspect the original approval and correct it through a new workpaper",
        );
      }
      const stored = computed as Record<string, unknown>;
      buyerSchedule = {
        placedInServiceOn: stored.buyerPlacedInServiceOn as string,
        recoveryPeriodYears: stored.buyerRecoveryPeriodYears as string,
        method: stored.buyerMethod as UsBuyerMacrsSchedule["method"],
        convention: stored.buyerConvention as UsBuyerMacrsSchedule["convention"],
      };
    } else {
      buyerSchedule = await loadUsBuyerMacrsSchedule(tx, orgId, receivingAssetId);
    }
  }
  return regimes.map((row) => {
    const applicable = applicableByRegime[row.regime];
    if (!applicable) {
      throw new TaxAssetBasisError(
        `neither the seller nor the receiving asset is classified for ${row.regime}; assign the tax class on the applicable Tax tab — do not invent a classification to collect inapplicable facts`,
      );
    }
    const facts = row.regime === "ca_cca" ? freezeCaRegimeBasis(row, effectiveOn) : row;
    return {
      facts,
      computed: computeTaxRegimeOutcome(facts, sourceOperation, applicable, buyerSchedule),
      applicable,
    };
  });
}

async function assetRegimes(
  tx: SqlExecutor,
  orgId: string,
  assetId: string,
): Promise<ClassifiedRegime[]> {
  const row = (
    await tx.execute<{ custom: unknown; tax_attributes: unknown }>(sql`
      select a.custom, c.tax_attributes
        from fixed_assets a
        join asset_categories c on c.org_id=a.org_id and c.id=a.category_id
       where a.org_id=${orgId} and a.id=${assetId}`)
  ).rows[0];
  if (!row) throw new TaxAssetBasisError("asset not found");
  return classifyAssetRegimes(tx, orgId, row.custom, row.tax_attributes);
}

async function sourceReversed(
  tx: SqlExecutor,
  orgId: string,
  source: { sourceChangeId: string | null; sourceEventId: string | null },
): Promise<boolean> {
  if (source.sourceChangeId) {
    const reversal = (
      await tx.execute(sql`
        select 1 from financial_changes
         where org_id=${orgId} and domain='asset' and operation='reversal'
           and status='applied' and payload->>'sourceChangeId'=${source.sourceChangeId}
         limit 1`)
    ).rows[0];
    if (reversal) return true;
  }
  if (source.sourceEventId) {
    const event = (
      await tx.execute(sql`
        select 1 from asset_events r
         where r.org_id=${orgId} and r.reverses_event_id=${source.sourceEventId}
         limit 1`)
    ).rows[0];
    if (event) return true;
  }
  return false;
}

async function resolveSource(
  tx: SqlExecutor,
  orgId: string,
  assetId: string,
  actorId: string,
  input: { sourceChangeId?: string | null; sourceEventId?: string | null },
): Promise<ResolvedSource> {
  const sourceChangeId = input.sourceChangeId || null;
  const sourceEventId = input.sourceEventId || null;
  if (sourceChangeId) {
    const change = await loadFinancialChange(tx, orgId, sourceChangeId);
    if (
      change.domain !== "asset" ||
      !["partial_disposal", "intercompany_transfer"].includes(change.operation) ||
      change.status !== "applied"
    ) {
      throw new TaxAssetBasisError("select an applied disposal or transfer as the tax source");
    }
    const receiver = (
      await tx.execute<{ receiving_asset_id: string }>(sql`
        select distinct receiving_asset_id from asset_transfer_bases
         where org_id=${orgId} and change_id=${sourceChangeId} and reversed_by_change_id is null`)
    ).rows;
    if (receiver.length > 1) {
      throw new TaxAssetBasisError(
        "the source transfer names more than one receiving asset; correct the book transfer before recording tax basis",
      );
    }
    const receivingAssetId = receiver[0]?.receiving_asset_id ?? null;
    if (change.operation === "intercompany_transfer" && !receivingAssetId) {
      throw new TaxAssetBasisError(
        "the source transfer has no unreversed receiving asset; tax basis cannot be inferred from book buyerAmount",
      );
    }
    if (assetId !== change.subject_id && assetId !== receivingAssetId) {
      throw new TaxAssetBasisError("this tax workpaper is not for the selected source asset");
    }
    if (sourceEventId) {
      const event = (
        await tx.execute<{ financial_change_id: string | null }>(sql`
          select financial_change_id from asset_events
           where org_id=${orgId} and id=${sourceEventId} and asset_id=${change.subject_id}`)
      ).rows[0];
      if (!event || event.financial_change_id !== sourceChangeId) {
        throw new TaxAssetBasisError("sourceEventId does not belong to the selected source change");
      }
    }
    const required = [...new Set([
      ...((change.payload.requiredSubsidiaryIds as string[] | undefined) ?? [change.subsidiary_id]),
    ])];
    await assertFinancialChangeAccess(tx, {
      orgId,
      actorId,
      subsidiaryIds: required,
      permission: "assets.manage",
      feature: "fixedAssets",
    });
    const sourceKind = await sourceKindForChange(
      tx,
      orgId,
      sourceChangeId,
      change.subject_id,
      change.operation === "intercompany_transfer" ? "transferred" : "disposed",
    );
    return {
      sourceChangeId,
      sourceEventId,
      sourceOperation: change.operation as TaxBasisSourceOperation,
      sourceKind,
      effectiveOn: change.effective_on,
      sellerAssetId: change.subject_id,
      receivingAssetId: change.operation === "intercompany_transfer" ? receivingAssetId : null,
      requiredSubsidiaryIds: required,
      sellerOpen: !(await sourceReversed(tx, orgId, { sourceChangeId, sourceEventId })),
    };
  }
  if (!sourceEventId) {
    throw new TaxAssetBasisError(
      "select a posted source: sourceChangeId or, for a legacy event with no financial change, sourceEventId",
    );
  }
  const event = (
    await tx.execute<{
      asset_id: string;
      kind: string;
      occurred_on: string;
      financial_change_id: string | null;
      subsidiary_id: string;
    }>(sql`
      select e.asset_id, e.kind, e.occurred_on::text, e.financial_change_id, a.subsidiary_id
        from asset_events e
        join fixed_assets a on a.org_id=e.org_id and a.id=e.asset_id
       where e.org_id=${orgId} and e.id=${sourceEventId}`)
  ).rows[0];
  if (!event || !(TAX_BASIS_SOURCE_KINDS as readonly string[]).includes(event.kind)) {
    throw new TaxAssetBasisError("select an unreversed posted disposal or transfer event");
  }
  if (event.financial_change_id) {
    return resolveSource(tx, orgId, assetId, actorId, {
      sourceChangeId: event.financial_change_id,
      sourceEventId,
    });
  }
  if (event.asset_id !== assetId) {
    throw new TaxAssetBasisError("this tax workpaper is not for the selected source asset");
  }
  if (event.kind === "transferred") {
    throw new TaxAssetBasisError(
      "a transferred event without a financial change has no governed receiving asset; record the book transfer first",
    );
  }
  await assertFinancialChangeAccess(tx, {
    orgId,
    actorId,
    subsidiaryIds: [event.subsidiary_id],
    permission: "assets.manage",
    feature: "fixedAssets",
  });
  return {
    sourceChangeId: null,
    sourceEventId,
    sourceOperation: taxBasisSourceOperation(event.kind as TaxBasisSourceKind),
    sourceKind: event.kind as TaxBasisSourceKind,
    effectiveOn: event.occurred_on,
    sellerAssetId: event.asset_id,
    receivingAssetId: null,
    requiredSubsidiaryIds: [event.subsidiary_id],
    sellerOpen: !(await sourceReversed(tx, orgId, { sourceChangeId: null, sourceEventId })),
  };
}

const INERT_MACRS_DEFAULTS: MacrsVintageDefaults = {
  recoveryPeriodYears: "5",
  method: "200_db",
  convention: "half_year",
  section179: "0",
  bonusPercent: "0",
  businessUsePercent: "100",
  shortYearMethod: "simplified",
};

function taxBasisSourceKey(
  sourceChangeId: string | null | undefined,
  sourceEventId: string | null | undefined,
): string {
  return sourceChangeId ? `change:${sourceChangeId}` : `event:${sourceEventId}`;
}

function asStoredText(value: unknown): string | null {
  if (value == null || value === "") return null;
  return String(value);
}

function asMacrsEventFromStored(row: {
  asset_id: string;
  receiving_asset_id: string | null;
  effective_on: string;
  seller_subsidiary_id: string;
  buyer_subsidiary_id: string | null;
  facts: Record<string, unknown>;
  computed: Record<string, unknown>;
}): MacrsWorkpaperEvent {
  const facts = row.facts;
  const computed = row.computed;
  return {
    asset_id: row.asset_id,
    receiving_asset_id: row.receiving_asset_id,
    effective_on: row.effective_on,
    seller_subsidiary_id: row.seller_subsidiary_id,
    buyer_subsidiary_id: row.buyer_subsidiary_id,
    remaining_basis: asStoredText(computed.remainingUnadjustedBasis),
    disposed_unadjusted_basis: asStoredText(computed.disposedUnadjustedBasis),
    carryover_basis: asStoredText(computed.carryoverBasis),
    excess_basis: asStoredText(computed.excessBasis),
    buyer_cost: asStoredText(computed.buyerCost),
    recognition: asStoredText(computed.recognition ?? facts.recognition),
    section_168i7_kind: asStoredText(computed.section168i7Kind ?? facts.section168i7Kind),
    related_person: facts.relatedPerson == null ? null : String(facts.relatedPerson),
    recovery_period_years: asStoredText(computed.recoveryPeriodYears ?? facts.recoveryPeriodYears),
    placed_in_service_on: asStoredText(computed.placedInServiceOn ?? facts.placedInServiceOn),
    macrs_method: asStoredText(computed.method ?? facts.method),
    macrs_convention: asStoredText(computed.convention ?? facts.convention),
    short_year_method: asStoredText(computed.shortYearMethod ?? facts.shortYearMethod),
    buyer_placed_in_service_on: asStoredText(computed.buyerPlacedInServiceOn),
    buyer_recovery_period_years: asStoredText(computed.buyerRecoveryPeriodYears),
    buyer_method: asStoredText(computed.buyerMethod),
    buyer_convention: asStoredText(computed.buyerConvention),
    original_unadjusted_basis: asStoredText(
      computed.originalUnadjustedBasis ?? facts.originalUnadjustedBasis,
    ),
    section_179: asStoredText(computed.section179 ?? facts.section179),
    bonus_percent: asStoredText(computed.bonusPercent ?? facts.bonusPercent),
    business_use_percent: asStoredText(computed.businessUsePercent ?? facts.businessUsePercent),
    prior_depreciation: asStoredText(computed.priorDepreciation ?? facts.priorDepreciation),
    vintage_allocations: Array.isArray(computed.vintageAllocations)
      ? computed.vintageAllocations
      : Array.isArray(facts.vintageAllocations)
        ? facts.vintageAllocations
        : null,
    buyer_vintages: Array.isArray(computed.buyerVintages)
      ? computed.buyerVintages
      : Array.isArray(facts.buyerVintages)
        ? facts.buyerVintages
        : null,
  };
}

type StoredUsMacrsPaper = {
  sourceKey: string;
  event: MacrsWorkpaperEvent;
};

async function loadUsMacrsPapersForAssets(
  tx: SqlExecutor,
  orgId: string,
  assetIds: string[],
): Promise<StoredUsMacrsPaper[]> {
  if (assetIds.length === 0) return [];
  const idList = sql.join(assetIds.map((id) => sql`${id}`), sql`, `);
  const rows = (
    await tx.execute<{
      source_change_id: string | null;
      source_event_id: string | null;
      asset_id: string;
      receiving_asset_id: string | null;
      effective_on: string;
      seller_subsidiary_id: string;
      buyer_subsidiary_id: string | null;
      facts: Record<string, unknown>;
      computed: Record<string, unknown>;
    }>(sql`
      select w.source_change_id, w.source_event_id, w.asset_id, w.receiving_asset_id,
             w.effective_on::text, seller.subsidiary_id as seller_subsidiary_id,
             buyer.subsidiary_id as buyer_subsidiary_id, w.facts, w.computed
        from tax_asset_basis_workpapers w
        join fixed_assets seller on seller.org_id=w.org_id and seller.id=w.asset_id
        left join fixed_assets buyer on buyer.org_id=w.org_id and buyer.id=w.receiving_asset_id
       where w.org_id=${orgId} and w.regime='us_macrs' and w.reversed_by_change_id is null
         and (w.asset_id in (${idList}) or w.receiving_asset_id in (${idList}))
       order by w.effective_on, w.created_at, w.id`)
  ).rows;
  return rows.map((row) => ({
    sourceKey: taxBasisSourceKey(row.source_change_id, row.source_event_id),
    event: asMacrsEventFromStored(row),
  }));
}

async function listSellerSourceOrder(
  tx: SqlExecutor,
  orgId: string,
  sellerAssetId: string,
): Promise<{ key: string; occurredOn: string }[]> {
  const rows = (
    await tx.execute<{
      event_id: string;
      financial_change_id: string | null;
      occurred_on: string;
    }>(sql`
      select e.id as event_id, e.financial_change_id, e.occurred_on::text
        from asset_events e
        left join asset_transfer_bases t on t.org_id=e.org_id and t.change_id=e.financial_change_id
          and t.reversed_by_change_id is null
        left join fixed_assets rec on rec.org_id=t.org_id and rec.id=t.receiving_asset_id
       where e.org_id=${orgId}
         and e.kind in ('partially_disposed','transferred','disposed','written_off')
         and (e.asset_id=${sellerAssetId} or rec.id=${sellerAssetId})
         and not exists(select 1 from asset_events r where r.org_id=e.org_id and r.reverses_event_id=e.id)
       order by e.occurred_on, e.created_at, e.id`)
  ).rows;
  const seen = new Set<string>();
  const sources: { key: string; occurredOn: string }[] = [];
  for (const row of rows) {
    const key = taxBasisSourceKey(row.financial_change_id, row.event_id);
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push({ key, occurredOn: row.occurred_on });
  }
  return sources;
}

function storedPapersBeforeSource(
  papers: StoredUsMacrsPaper[],
  sellerAssetId: string,
  sourceKey: string,
  order: Map<string, number>,
  sourceIndex: number,
  occurredOn: string,
): StoredUsMacrsPaper[] {
  return papers.filter((paper) => {
    if (paper.sourceKey === sourceKey) return false;
    if (paper.event.asset_id !== sellerAssetId && paper.event.receiving_asset_id !== sellerAssetId) {
      return false;
    }
    const index = order.get(paper.sourceKey);
    if (index != null) return index < sourceIndex;
    return paper.event.effective_on < occurredOn;
  });
}

async function loadUsSellerMacrsVintageContext(
  tx: SqlExecutor,
  orgId: string,
  args: {
    sellerAssetId: string;
    sourceChangeId: string | null;
    sourceEventId: string | null;
    occurredOn: string;
  },
): Promise<UsSellerMacrsVintageContext> {
  const seller = (
    await tx.execute<{ subsidiary_id: string }>(sql`
      select subsidiary_id from fixed_assets
       where org_id=${orgId} and id=${args.sellerAssetId}`)
  ).rows[0];
  if (!seller) {
    return {
      status: "history_refused",
      refusal:
        "the seller asset for this source could not be loaded; correct the posted source before recording tax basis",
    };
  }
  const sourceKey = taxBasisSourceKey(args.sourceChangeId, args.sourceEventId);
  const orderSources = await listSellerSourceOrder(tx, orgId, args.sellerAssetId);
  const order = new Map(orderSources.map((source, index) => [source.key, index]));
  const sourceIndex = order.get(sourceKey) ?? orderSources.length;
  const papers = await loadUsMacrsPapersForAssets(tx, orgId, [args.sellerAssetId]);
  const priorPapers = storedPapersBeforeSource(
    papers,
    args.sellerAssetId,
    sourceKey,
    order,
    sourceIndex,
    args.occurredOn,
  );
  const history = sellerMacrsHistoryBeforeSource({
    assetId: args.sellerAssetId,
    subsidiaryId: seller.subsidiary_id,
    papers: priorPapers.map((paper) => paper.event),
    defaults: INERT_MACRS_DEFAULTS,
    priorSources: orderSources.slice(0, sourceIndex),
    paperSourceKeys: priorPapers.map((paper) => paper.sourceKey),
  });
  if (history.status !== "ready") return history;
  try {
    const fromOn = history.vintages.reduce(
      (earliest, vintage) =>
        vintage.placedInServiceOn < earliest ? vintage.placedInServiceOn : earliest,
      args.occurredOn,
    );
    const windows = await loadOrgMacrsWindows(tx, orgId, fromOn, args.occurredOn);
    return {
      status: "ready",
      vintages: history.vintages.map((vintage) => {
        const dated = refreshOpenMacrsVintageThrough(vintage, windows, args.occurredOn);
        return {
          ...vintage,
          priorDepreciation: dated.priorDepreciation,
          adjustedCarryover: dated.adjustedCarryover,
        };
      }),
    };
  } catch (error) {
    return {
      status: "history_refused",
      refusal: error instanceof Error
        ? error.message
        : "MACRS checkpoints could not be dated to the source effective date",
    };
  }
}

function usSellerMacrsForChoice(
  regimes: { code: string; applicable: TaxBasisApplicableSide }[],
  context: UsSellerMacrsVintageContext | null,
): UsSellerMacrsVintageContext | null {
  const us = regimes.find((row) => row.code === "us_macrs");
  if (!us || !taxBasisSideApplies(us.applicable, "seller")) return null;
  return context;
}

async function snapshot(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  assetId: string,
  input: TaxAssetBasisInput,
) {
  const source = await resolveSource(tx, orgId, assetId, actorId, input);
  if (!source.sellerOpen) {
    throw new TaxAssetBasisError(
      "the source disposal or transfer has been reversed; its tax workpaper is excluded by that dated correction",
    );
  }
  const existing = (
    await tx.execute<{ change_id: string }>(sql`
      select change_id from tax_asset_basis_workpapers
       where org_id=${orgId} and reversed_by_change_id is null
         and (
           (${source.sourceChangeId}::uuid is not null and source_change_id=${source.sourceChangeId})
           or (${source.sourceEventId}::uuid is not null and source_change_id is null and source_event_id=${source.sourceEventId})
         )
       limit 1`)
  ).rows[0];
  const sellerClassified = await assetRegimes(tx, orgId, source.sellerAssetId);
  const receiverClassified = source.receivingAssetId
    ? await assetRegimes(tx, orgId, source.receivingAssetId)
    : [];
  const transfer = source.sourceOperation === "intercompany_transfer";
  assertClassifiedRegimes(input.regimes, sellerClassified, receiverClassified, transfer);
  const applicable = classifiedApplicable(sellerClassified, receiverClassified, transfer);
  const usSellerMacrs = taxBasisSideApplies(applicable.us_macrs, "seller")
    ? await loadUsSellerMacrsVintageContext(tx, orgId, {
        sellerAssetId: source.sellerAssetId,
        sourceChangeId: source.sourceChangeId,
        sourceEventId: source.sourceEventId,
        occurredOn: source.effectiveOn,
      })
    : null;
  if (usSellerMacrs?.status === "history_refused") {
    throw new TaxAssetBasisError(usSellerMacrs.refusal);
  }
  let validated: TaxAssetBasisInput;
  try {
    validated = validateTaxAssetBasisInput(input, {
      sourceOperation: source.sourceOperation,
      applicableByRegime: applicable,
      usSellerMacrs,
      effectiveOn: source.effectiveOn,
    });
  } catch (error) {
    throw error instanceof Error ? new TaxAssetBasisError(error.message) : error;
  }
  const frozen = await freezeRegimes(
    tx,
    orgId,
    validated.regimes,
    source.sourceOperation,
    source.effectiveOn,
    applicable,
    source.receivingAssetId,
  );
  return {
    required: source.requiredSubsidiaryIds,
    sourceOpen: true,
    sellerAssetId: source.sellerAssetId,
    receivingAssetId: source.receivingAssetId,
    sourceChangeId: source.sourceChangeId,
    sourceEventId: source.sourceEventId,
    sourceOperation: source.sourceOperation,
    effectiveOn: source.effectiveOn,
    applicable,
    validatedRegimes: validated.regimes,
    existingWorkpaperChangeId: existing?.change_id ?? null,
    preview: {
      effectiveOn: source.effectiveOn,
      sourceOperation: source.sourceOperation,
      sourceChangeId: source.sourceChangeId,
      sourceEventId: source.sourceEventId,
      receivingAssetId: source.receivingAssetId,
      applicable,
      assessment: input.assessment,
      regimes: Object.fromEntries(frozen.map((row) => [row.facts.regime, row.computed])),
    },
  };
}

export async function listTaxAssetBasisSources(
  orgId: string,
  assetId: string,
  actorId: string,
): Promise<TaxAssetBasisSourcesResponse> {
  return withOrg(orgId, async () => {
    const identity = (
      await db.execute<{
        asset_number: string;
        name: string;
        subsidiary_id: string;
        custom: unknown;
        tax_attributes: unknown;
      }>(sql`
        select a.asset_number, a.name, a.subsidiary_id, a.custom, c.tax_attributes
          from fixed_assets a
          join asset_categories c on c.org_id=a.org_id and c.id=a.category_id
         where a.org_id=${orgId} and a.id=${assetId}`)
    ).rows[0];
    if (!identity) throw new TaxAssetBasisError("asset not found");
    await assertFinancialChangeAccess(db, {
      orgId,
      actorId,
      subsidiaryIds: [identity.subsidiary_id],
      permission: "assets.manage",
      feature: "fixedAssets",
    });
    const allowed = await actorAllowedSubsidiaryIds(db, orgId, actorId);
    const rows = (
      await db.execute<{
        event_id: string;
        financial_change_id: string | null;
        kind: TaxBasisSourceKind;
        occurred_on: string;
        seller_asset_id: string;
        book_name: string | null;
        asset_label: string;
        subsidiary_id: string;
        subsidiary_label: string;
        receiving_asset_label: string | null;
        receiving_subsidiary_id: string | null;
        seller_custom: unknown;
        seller_tax: unknown;
        receiving_custom: unknown;
        receiving_tax: unknown;
      }>(sql`
        select e.id as event_id, e.financial_change_id, e.kind, e.occurred_on::text,
               e.asset_id as seller_asset_id,
               coalesce(b.name, jb.name) as book_name,
               a.asset_number||' — '||a.name as asset_label,
               a.subsidiary_id, s.name as subsidiary_label,
               rec.asset_number||' — '||rec.name as receiving_asset_label,
               rec.subsidiary_id as receiving_subsidiary_id,
               a.custom as seller_custom, c.tax_attributes as seller_tax,
               rec.custom as receiving_custom, rec_c.tax_attributes as receiving_tax
          from asset_events e
          join fixed_assets a on a.org_id=e.org_id and a.id=e.asset_id
          join asset_categories c on c.org_id=a.org_id and c.id=a.category_id
          join subsidiaries s on s.org_id=a.org_id and s.id=a.subsidiary_id
          left join accounting_books b on b.org_id=e.org_id and b.id=e.book_id
          left join journal_entries j on j.org_id=e.org_id and j.id=e.journal_entry_id
          left join accounting_books jb on jb.org_id=j.org_id and jb.id=j.book_id
          left join asset_transfer_bases t on t.org_id=e.org_id and t.change_id=e.financial_change_id
            and t.reversed_by_change_id is null
          left join fixed_assets rec on rec.org_id=t.org_id and rec.id=t.receiving_asset_id
          left join asset_categories rec_c on rec_c.org_id=rec.org_id and rec_c.id=rec.category_id
         where e.org_id=${orgId}
           and e.kind in ('partially_disposed','transferred','disposed','written_off')
           and (e.asset_id=${assetId} or rec.id=${assetId})
           and not exists(select 1 from asset_events r where r.org_id=e.org_id and r.reverses_event_id=e.id)
         order by e.occurred_on, e.created_at, e.id`)
    ).rows;
    const workpapers = (
      await db.execute<{
        source_change_id: string | null;
        source_event_id: string | null;
        change_id: string;
        status: "draft" | "pending" | "approved" | "rejected" | "applied";
      }>(sql`
        select w.source_change_id, w.source_event_id, w.change_id, f.status
          from tax_asset_basis_workpapers w
          join financial_changes f on f.org_id=w.org_id and f.id=w.change_id
         where w.org_id=${orgId} and w.reversed_by_change_id is null
           and (w.asset_id=${assetId} or w.receiving_asset_id=${assetId})`)
    ).rows;
    const pending = (
      await db.execute<{
        source_change_id: string | null;
        source_event_id: string | null;
        id: string;
        status: "draft" | "pending" | "approved" | "rejected" | "applied";
      }>(sql`
        select payload->>'sourceChangeId' as source_change_id,
               payload->>'sourceEventId' as source_event_id,
               id, status
          from financial_changes
         where org_id=${orgId} and domain='asset' and operation='tax_basis'
           and status in ('draft','pending','approved')
           and (
             subject_id=${assetId}
             or payload->>'sellerAssetId'=${assetId}
             or payload->>'receivingAssetId'=${assetId}
           )`)
    ).rows;
    const classification = await loadRegimeClassificationContext(db, orgId);
      const seen = new Set<string>();
    const sources: TaxAssetBasisSourceChoice[] = [];
    const sellerHistory = new Map<string, UsSellerMacrsVintageContext>();
    for (const row of rows) {
      if (await sourceReversed(db, orgId, {
        sourceChangeId: row.financial_change_id,
        sourceEventId: row.event_id,
      })) continue;
      const key = row.financial_change_id ? `change:${row.financial_change_id}` : `event:${row.event_id}`;
      if (seen.has(key)) continue;
      const scoped = [row.subsidiary_id, row.receiving_subsidiary_id].filter(Boolean) as string[];
      if (allowed && scoped.some((id) => !allowed.has(id))) continue;
      seen.add(key);
      const applied =
        workpapers.find((item) =>
          row.financial_change_id
            ? item.source_change_id === row.financial_change_id
            : item.source_event_id === row.event_id && !item.source_change_id,
        ) ??
        pending.find((item) =>
          row.financial_change_id
            ? item.source_change_id === row.financial_change_id
            : item.source_event_id === row.event_id,
        );
      const regimes = taxBasisSourceRegimes(
        classifyAssetFromContext(row.seller_custom, row.seller_tax, classification),
        classifyAssetFromContext(row.receiving_custom, row.receiving_tax, classification),
        row.kind === "transferred",
      );
      const usSeller = regimes.find((item) => item.code === "us_macrs");
      let openMacrsVintages: UsSellerMacrsVintageContext | null = null;
      if (usSeller && taxBasisSideApplies(usSeller.applicable, "seller")) {
        const cacheKey = `${row.seller_asset_id}:${key}`;
        let history = sellerHistory.get(cacheKey);
        if (!history) {
          history = await loadUsSellerMacrsVintageContext(db, orgId, {
            sellerAssetId: row.seller_asset_id,
            sourceChangeId: row.financial_change_id,
            sourceEventId: row.financial_change_id ? null : row.event_id,
            occurredOn: row.occurred_on,
          });
          sellerHistory.set(cacheKey, history);
        }
        openMacrsVintages = usSellerMacrsForChoice(regimes, history);
      }
      sources.push({
        key,
        sourceChangeId: row.financial_change_id,
        sourceEventId: row.financial_change_id ? null : row.event_id,
        occurredOn: row.occurred_on,
        sourceKind: row.kind,
        sourceOperation: taxBasisSourceOperation(row.kind),
        regimes,
        openMacrsVintages,
        bookLabel: row.book_name,
        assetLabel: row.asset_label,
        subsidiaryLabel: row.subsidiary_label,
        receivingAssetLabel: row.receiving_asset_label,
        appliedWorkpaper: applied
          ? { changeId: "change_id" in applied ? applied.change_id : applied.id, status: applied.status }
          : null,
      });
    }
    return {
      assetId,
      assetNumber: identity.asset_number,
      sources,
    };
  });
}

export async function proposeTaxAssetBasis(
  orgId: string,
  assetId: string,
  actorId: string,
  input: TaxAssetBasisInput,
): Promise<string> {
  if (!input.idempotencyKey || input.idempotencyKey.length > 120) {
    throw new TaxAssetBasisError("provide a request key of at most 120 characters");
  }
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const replay = (
        await db.execute<{ subsidiary_id: string; payload: Record<string, unknown> }>(sql`
          select subsidiary_id, payload from financial_changes
           where org_id=${orgId} and idempotency_key=${input.idempotencyKey}`)
      ).rows[0];
      if (replay) {
        const required = (replay.payload.requiredSubsidiaryIds ?? [replay.subsidiary_id]) as string[];
        await assertFinancialChangeAccess(db, {
          orgId,
          actorId,
          subsidiaryIds: required,
          permission: "assets.manage",
          feature: "fixedAssets",
        });
        const sourceOperation = replay.payload.sourceOperation;
        if (
          typeof sourceOperation !== "string" ||
          !(TAX_BASIS_SOURCE_OPERATIONS as readonly string[]).includes(sourceOperation)
        ) {
          throw new TaxAssetBasisError("the frozen workpaper is missing its source operation");
        }
        const applicable = (replay.payload.applicable ?? {}) as Record<string, TaxBasisApplicableSide>;
        const usSellerMacrs = taxBasisSideApplies(applicable.us_macrs, "seller")
          ? await loadUsSellerMacrsVintageContext(db, orgId, {
              sellerAssetId: String(replay.payload.sellerAssetId ?? ""),
              sourceChangeId: (replay.payload.sourceChangeId as string | null) ?? null,
              sourceEventId: (replay.payload.sourceEventId as string | null) ?? null,
              occurredOn: String(replay.payload.effectiveOn ?? ""),
            })
          : null;
        if (usSellerMacrs?.status === "history_refused") {
          throw new TaxAssetBasisError(usSellerMacrs.refusal);
        }
        const validated = validateTaxAssetBasisInput(input, {
          sourceOperation: sourceOperation as TaxBasisSourceOperation,
          applicableByRegime: applicable,
          usSellerMacrs,
          effectiveOn: String(replay.payload.effectiveOn ?? ""),
        });
        const frozen = await freezeRegimes(
          db,
          orgId,
          validated.regimes,
          sourceOperation as TaxBasisSourceOperation,
          String(replay.payload.effectiveOn ?? ""),
          applicable,
          (replay.payload.receivingAssetId as string | null) ?? null,
          { computed: (replay.payload.computed ?? {}) as Record<string, unknown> },
        );
        const payload = workpaperPayload(
          validated,
          {
            sourceOperation: sourceOperation as TaxBasisSourceOperation,
            effectiveOn: String(replay.payload.effectiveOn ?? ""),
            sellerAssetId: String(replay.payload.sellerAssetId ?? ""),
            receivingAssetId: (replay.payload.receivingAssetId as string | null) ?? null,
            requiredSubsidiaryIds: required,
            applicable,
          },
          frozen,
        );
        const id = await existingFinancialChange(db, {
          orgId,
          subsidiaryId: replay.subsidiary_id,
          domain: "asset",
          subjectId: assetId,
          operation: "tax_basis",
          effectiveOn: String(replay.payload.effectiveOn ?? ""),
          reason: validated.reason,
          actorId,
          idempotencyKey: validated.idempotencyKey,
          payload,
        });
        if (id) return id;
        throw new TaxAssetBasisError(
          "this request key already froze different tax basis facts; use a new request key to propose a different workpaper",
        );
      }
      const source = await resolveSource(db, orgId, assetId, actorId, {
        sourceChangeId: input.sourceChangeId,
        sourceEventId: input.sourceEventId,
      });
      await lockAssetTaxLifecycle(db, orgId, source.requiredSubsidiaryIds);
      for (const id of [source.sellerAssetId, ...(source.receivingAssetId ? [source.receivingAssetId] : [])].sort()) {
        await lockAssetRow(db, orgId, id);
      }
      const sellerClassified = await assetRegimes(db, orgId, source.sellerAssetId);
      const receiverClassified = source.receivingAssetId
        ? await assetRegimes(db, orgId, source.receivingAssetId)
        : [];
      const applicable = classifiedApplicable(
        sellerClassified,
        receiverClassified,
        source.sourceOperation === "intercompany_transfer",
      );
      const usSellerMacrs = taxBasisSideApplies(applicable.us_macrs, "seller")
        ? await loadUsSellerMacrsVintageContext(db, orgId, {
            sellerAssetId: source.sellerAssetId,
            sourceChangeId: source.sourceChangeId,
            sourceEventId: source.sourceEventId,
            occurredOn: source.effectiveOn,
          })
        : null;
      if (usSellerMacrs?.status === "history_refused") {
        throw new TaxAssetBasisError(usSellerMacrs.refusal);
      }
      const validated = validateTaxAssetBasisInput(input, {
        sourceOperation: source.sourceOperation,
        applicableByRegime: applicable,
        usSellerMacrs,
        effectiveOn: source.effectiveOn,
      });
      const state = await snapshot(db, orgId, actorId, assetId, validated);
      if (state.existingWorkpaperChangeId) {
        throw new TaxAssetBasisError(
          "this source already has an applied tax basis workpaper; reverse that workpaper before proposing another",
        );
      }
      const frozen = await freezeRegimes(
        db,
        orgId,
        validated.regimes,
        state.sourceOperation,
        state.effectiveOn,
        state.applicable,
        state.receivingAssetId,
      );
      const payload = workpaperPayload(
        validated,
        {
          sourceOperation: state.sourceOperation,
          effectiveOn: state.effectiveOn,
          sellerAssetId: state.sellerAssetId,
          receivingAssetId: state.receivingAssetId,
          requiredSubsidiaryIds: state.required,
          applicable: state.applicable,
        },
        frozen,
      );
      const args = {
        orgId,
        subsidiaryId: state.required[0]!,
        domain: "asset" as const,
        subjectId: assetId,
        operation: "tax_basis",
        effectiveOn: state.effectiveOn,
        reason: validated.reason,
        actorId,
        idempotencyKey: validated.idempotencyKey,
        payload,
      };
      const previous = await existingFinancialChange(db, args);
      if (previous) return previous;
      return proposeFinancialChange(db, { ...args, beforeState: state });
    }),
  );
}

export async function applyTaxAssetBasis(
  orgId: string,
  changeId: string,
  actorId: string,
): Promise<TaxAssetBasisApplyResult> {
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const change = await loadFinancialChange(db, orgId, changeId);
      if (change.domain !== "asset" || change.operation !== "tax_basis") {
        throw new TaxAssetBasisError("this is not a tax basis workpaper");
      }
      const required = (change.payload.requiredSubsidiaryIds as string[] | undefined) ?? [
        change.subsidiary_id,
      ];
      await assertFinancialChangeAccess(db, {
        orgId,
        actorId,
        subsidiaryIds: required,
        permission: "assets.manage",
        feature: "fixedAssets",
      });
      if (change.status === "applied") return change.result as TaxAssetBasisApplyResult;
      await lockAssetTaxLifecycle(db, orgId, required);
      const payload = change.payload as TaxAssetBasisInput & {
        sourceOperation: TaxBasisSourceOperation;
        effectiveOn: string;
        sellerAssetId: string;
        receivingAssetId: string | null;
        requiredSubsidiaryIds: string[];
      };
      for (const id of [
        payload.sellerAssetId ?? change.subject_id,
        ...(payload.receivingAssetId ? [payload.receivingAssetId] : []),
      ].sort()) {
        await lockAssetRow(db, orgId, id);
      }
      const state = await snapshot(db, orgId, actorId, change.subject_id, {
        sourceChangeId: payload.sourceChangeId,
        sourceEventId: payload.sourceEventId,
        reason: change.reason,
        assessment: payload.assessment,
        idempotencyKey: randomUUID(),
        regimes: payload.regimes,
      });
      assertFinancialChangeApproved(change, {
        domain: "asset",
        subjectId: change.subject_id,
        beforeState: { ...state, existingWorkpaperChangeId: state.existingWorkpaperChangeId },
      });
      const allowed = await actorAllowedSubsidiaryIds(db, orgId, change.approved_by!);
      if (allowed && state.required.some((id) => !allowed.has(id))) {
        throw new TaxAssetBasisError(
          "the independent approver no longer covers every legal entity on this workpaper; obtain a new approval",
        );
      }
      const frozen = await freezeRegimes(
        db,
        orgId,
        state.validatedRegimes,
        state.sourceOperation,
        state.effectiveOn,
        state.applicable,
        state.receivingAssetId,
      );
      const workpaperIds: string[] = [];
      for (const row of frozen) {
        const inserted = await db.execute<{ id: string }>(sql`
          insert into tax_asset_basis_workpapers(
            org_id,asset_id,change_id,source_change_id,source_event_id,receiving_asset_id,
            effective_on,source_operation,applicable,regime,assessment,facts,computed,created_by
          ) values (
            ${orgId},${state.sellerAssetId},${changeId},${state.sourceChangeId},${state.sourceEventId},
            ${state.receivingAssetId},${state.effectiveOn},${state.sourceOperation},${row.applicable},${row.facts.regime},
            ${payload.assessment},${JSON.stringify(row.facts)}::jsonb,${JSON.stringify(row.computed)}::jsonb,${actorId}
          ) returning id`);
        if (inserted.rows.length !== 1) {
          throw new TaxAssetBasisError(`tax basis workpaper for ${row.facts.regime} was not recorded`);
        }
        workpaperIds.push(inserted.rows[0]!.id);
      }
      const result: TaxAssetBasisApplyResult = {
        changeId,
        workpaperId: workpaperIds[0]!,
        workpaperIds,
        sourceChangeId: state.sourceChangeId,
        sourceEventId: state.sourceEventId,
        effectiveOn: state.effectiveOn,
        requiredSubsidiaryIds: state.required,
        receivingAssetId: state.receivingAssetId,
        regimes: frozen.map((row) => row.facts.regime),
        computed: Object.fromEntries(frozen.map((row) => [row.facts.regime, row.computed])),
      };
      await completeFinancialChange(db, orgId, changeId, actorId, result);
      return result;
    }),
  );
}

export async function proposeTaxAssetBasisReversal(
  orgId: string,
  sourceChangeId: string,
  actorId: string,
  input: { reason: string; idempotencyKey: string },
): Promise<string> {
  if (input.reason.trim().length < 8 || input.reason.trim().length > 1000) {
    throw new TaxAssetBasisError("record a reversal reason between 8 and 1,000 characters");
  }
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const source = await loadFinancialChange(db, orgId, sourceChangeId);
      if (source.domain !== "asset" || source.operation !== "tax_basis" || source.status !== "applied") {
        throw new TaxAssetBasisError("select an applied tax basis workpaper to reverse");
      }
      const required = (source.payload.requiredSubsidiaryIds as string[] | undefined) ?? [
        source.subsidiary_id,
      ];
      await assertFinancialChangeAccess(db, {
        orgId,
        actorId,
        subsidiaryIds: required,
        permission: "assets.manage",
        feature: "fixedAssets",
      });
      await lockAssetTaxLifecycle(db, orgId, required);
      const papers = (
        await db.execute<{ id: string }>(sql`
          select id from tax_asset_basis_workpapers
           where org_id=${orgId} and change_id=${source.id} and reversed_by_change_id is null
           order by regime, id
           for share`)
      ).rows;
      const args = {
        orgId,
        subsidiaryId: source.subsidiary_id,
        domain: "asset" as const,
        subjectId: source.subject_id,
        operation: "tax_basis_reversal",
        effectiveOn: source.effective_on,
        reason: input.reason.trim(),
        actorId,
        idempotencyKey: input.idempotencyKey,
        payload: {
          sourceChangeId: source.id,
          requiredSubsidiaryIds: required,
        },
      };
      const prior = await existingFinancialChange(db, args);
      if (prior) return prior;
      const already = (
        await db.execute(sql`
          select 1 from financial_changes
           where org_id=${orgId} and domain='asset' and operation='tax_basis_reversal'
             and payload->>'sourceChangeId'=${source.id} and status='applied'`)
      ).rows[0];
      if (already) throw new TaxAssetBasisError("this tax basis workpaper has already been reversed");
      if (!papers.length) {
        throw new TaxAssetBasisError("the original tax basis workpaper evidence is missing");
      }
      return proposeFinancialChange(db, {
        ...args,
        beforeState: {
          sourceChangeId: source.id,
          workpaperIds: papers.map((row) => row.id),
          effectiveOn: source.effective_on,
          preview: source.result,
        },
      });
    }),
  );
}

export async function applyTaxAssetBasisReversal(
  orgId: string,
  changeId: string,
  actorId: string,
): Promise<TaxAssetBasisApplyResult> {
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const change = await loadFinancialChange(db, orgId, changeId);
      if (change.domain !== "asset" || change.operation !== "tax_basis_reversal") {
        throw new TaxAssetBasisError("this is not a tax basis workpaper reversal");
      }
      const required = (change.payload.requiredSubsidiaryIds as string[] | undefined) ?? [
        change.subsidiary_id,
      ];
      await assertFinancialChangeAccess(db, {
        orgId,
        actorId,
        subsidiaryIds: required,
        permission: "assets.manage",
        feature: "fixedAssets",
      });
      if (change.status === "applied") return change.result as TaxAssetBasisApplyResult;
      await lockAssetTaxLifecycle(db, orgId, required);
      const sourceChangeId = String(change.payload.sourceChangeId ?? "");
      const source = await loadFinancialChange(db, orgId, sourceChangeId);
      const papers = (
        await db.execute<{ id: string; regime: TaxBasisRegime }>(sql`
          select id, regime from tax_asset_basis_workpapers
           where org_id=${orgId} and change_id=${sourceChangeId} and reversed_by_change_id is null
           order by regime, id for update`)
      ).rows;
      assertFinancialChangeApproved(change, {
        domain: "asset",
        subjectId: change.subject_id,
        beforeState: {
          sourceChangeId,
          workpaperIds: papers.map((row) => row.id),
          effectiveOn: source.effective_on,
          preview: source.result,
        },
      });
      const allowed = await actorAllowedSubsidiaryIds(db, orgId, change.approved_by!);
      if (allowed && required.some((id) => !allowed.has(id))) {
        throw new TaxAssetBasisError(
          "the independent approver no longer covers every legal entity on this workpaper; obtain a new approval",
        );
      }
      if (!papers.length) {
        throw new TaxAssetBasisError("the original tax basis workpaper evidence is missing");
      }
      const closed = await db.execute(sql`
        update tax_asset_basis_workpapers
           set reversed_by_change_id=${changeId}, reversed_on=${source.effective_on}
         where org_id=${orgId} and change_id=${sourceChangeId} and reversed_by_change_id is null
         returning id`);
      if (closed.rows.length !== papers.length) {
        throw new TaxAssetBasisError("tax basis workpaper reversal did not close every live row");
      }
      const result: TaxAssetBasisApplyResult = {
        changeId,
        workpaperId: papers[0]!.id,
        workpaperIds: papers.map((row) => row.id),
        sourceChangeId,
        sourceEventId: (source.payload.sourceEventId as string | null) ?? null,
        effectiveOn: source.effective_on,
        requiredSubsidiaryIds: required,
        receivingAssetId: (source.payload.receivingAssetId as string | null) ?? null,
        regimes: papers.map((row) => row.regime),
        computed: { reversedWorkpaperChangeId: sourceChangeId },
      };
      await completeFinancialChange(db, orgId, changeId, actorId, result);
      return result;
    }),
  );
}
