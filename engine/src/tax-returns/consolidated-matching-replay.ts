/**
 * Approved append-only 1.1502-13 matching replay onto a replacement
 * workpaper. Historical rows stay write-once. Earlier years that cannot be
 * pool-restated after a later result are replayed from cited deductions and
 * the replacement opening — never by upserting an old tax_pool_periods row
 * or borrowing an uncited reversed-paper closing.
 */
import { sql } from "drizzle-orm";
import { lockAssetTaxLifecycle } from "../organization/asset-tax-fence.ts";
import { assertFinancialChangeAccess } from "../organization/financial-change-access.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { db, withOrg, withTransactionSavepoint, type SqlExecutor } from "../platform/db.ts";
import {
  assertFinancialChangeApproved,
  completeFinancialChange,
  existingFinancialChange,
  loadFinancialChange,
  proposeFinancialChange,
  type FinancialChange,
} from "../platform/financial-changes.ts";
import {
  TAX_MATCHING_GENERATION_REPAIR_OPERATION,
  TAX_MATCHING_REPLAY_OPERATION,
  TaxBasisPolicyError,
  macrsVintageKey,
  parseFrozenMacrsBuyerVintages,
  parseMacrsVintageAllocations,
  type TaxMatchingReplayInput,
} from "./asset-basis-policy.ts";
import {
  historicalMatchingYearsToReplay,
  matchingReplayPeriodEvidence,
  receivingMatchingVintageWeights,
  replayMatchingPaperFromCitedHistory,
  resolveFrozenUsConsolidatedMatching,
  type HistoricalMatchingPeriodEvidence,
  type MatchingPeriodReplay,
  type MatchingReplayPeriodEvidence,
  type MatchingSellerVintageAllocation,
  type MatchingReceiverVintageIdentity,
  type MatchingVintageWeight,
} from "./consolidated-macrs-matching.ts";
import { ConsolidatedTaxMatchingError } from "./consolidated-tax-matching.ts";

export class TaxMatchingReplayError extends Error {
  readonly name = "TaxMatchingReplayError";
}

export type TaxMatchingReplayPreview = {
  assetId: string;
  replacementWorkpaperId: string;
  replacementWorkpaperChangeId: string;
  latestPoolYearStart: string | null;
  citedHistoricalPeriodIds: string[];
  historical: HistoricalMatchingPeriodEvidence[];
  replacementOpening: string;
  replayedPeriods: MatchingReplayPeriodEvidence[];
};

export type TaxMatchingReplayApplyResult = {
  changeId: string;
  assetId: string;
  replacementWorkpaperId: string;
  replacementWorkpaperChangeId: string;
  citedHistoricalPeriodIds: string[];
  replayedPeriodIds: string[];
  replayedPeriods: MatchingReplayPeriodEvidence[];
};

function asReplayError(error: unknown): never {
  if (error instanceof TaxMatchingReplayError) throw error;
  if (error instanceof TaxBasisPolicyError || error instanceof ConsolidatedTaxMatchingError) {
    throw new TaxMatchingReplayError(error.message);
  }
  throw error instanceof Error ? new TaxMatchingReplayError(error.message) : error;
}

function headerReceivingWeight(
  source: "carryover" | "excess" | "taxable_cost",
  placedInServiceOn: unknown,
  transferOn: string,
  amount: unknown,
): MatchingVintageWeight | null {
  if (typeof placedInServiceOn !== "string" || !placedInServiceOn) return null;
  if (amount == null || amount === "") return null;
  return {
    vintageKey: macrsVintageKey({
      source,
      placedInServiceOn,
      transferOn,
      parentKey: null,
    }),
    amount: String(amount),
  };
}

/** Frozen receiving-vintage weights shared with the initial pool year.
 *  Includes header-created excess / taxable cost. Does not join by date
 *  or substitute book basis. */
export function receivingMatchingVintageWeightsFromComputed(
  computed: Record<string, unknown>,
  transferOn: string,
): MatchingVintageWeight[] {
  try {
    const hasAllocations = computed.vintageAllocations != null && computed.vintageAllocations !== "";
    const hasBuyers = computed.buyerVintages != null && computed.buyerVintages !== "";
    const allocations: MatchingSellerVintageAllocation[] = hasAllocations
      ? parseMacrsVintageAllocations(computed.vintageAllocations).map((row) => ({
        sellerVintageKey: macrsVintageKey(row),
        disposedUnadjustedBasis: row.disposedUnadjustedBasis,
      }))
      : [];
    const receivers: MatchingReceiverVintageIdentity[] = [];
    const newlyPlaced: MatchingVintageWeight[] = [];
    if (hasBuyers) {
      for (const row of parseFrozenMacrsBuyerVintages(computed.buyerVintages)) {
        const vintageKey = macrsVintageKey({
          source: row.source,
          placedInServiceOn: row.placedInServiceOn,
          transferOn: row.transferOn,
          parentKey: row.parentKey,
        });
        if (row.key !== vintageKey) {
          throw new TaxMatchingReplayError(
            `1.1502-13 matching replay buyerVintages key ${row.key} must be the receiving vintage ${vintageKey}; reverse and re-propose the workpaper — do not match a vintage by placed-in-service date`,
          );
        }
        if (row.source === "carryover") {
          if (!row.parentKey) {
            newlyPlaced.push({ vintageKey, amount: row.unadjustedBasis });
            continue;
          }
          receivers.push({
            vintageKey,
            parentKey: row.parentKey,
            unadjustedBasis: row.unadjustedBasis,
          });
          continue;
        }
        newlyPlaced.push({ vintageKey, amount: row.unadjustedBasis });
      }
    }
    const split168i7 = computed.section168i7Kind != null && computed.section168i7Kind !== "";
    const excess = headerReceivingWeight(
      "excess",
      computed.buyerPlacedInServiceOn,
      transferOn,
      computed.excessBasis,
    );
    if (excess) newlyPlaced.push(excess);
    if (computed.recognition === "taxable" && !split168i7) {
      const taxable = headerReceivingWeight(
        "taxable_cost",
        computed.buyerPlacedInServiceOn,
        transferOn,
        computed.buyerCost,
      );
      if (taxable) newlyPlaced.push(taxable);
    }
    if (!hasBuyers && computed.carryoverBasis != null && computed.carryoverBasis !== "") {
      const carryover = headerReceivingWeight(
        "carryover",
        computed.placedInServiceOn,
        transferOn,
        computed.disposedUnadjustedBasis ?? computed.originalUnadjustedBasis,
      );
      if (carryover) newlyPlaced.push(carryover);
    }
    return receivingMatchingVintageWeights({
      allocations,
      receivers,
      newlyPlaced,
    });
  } catch (error) {
    asReplayError(error);
  }
}

type MatchingEvidenceRow = {
  id: string;
  workpaper_id: string;
  vintage_key: string;
  parent_key: string | null;
  tax_year_window_id: string;
  year_start: string;
  year_end: string;
  actual_deduction: string;
  recomputed_deduction: string;
  transfer_on: string | null;
};

function asHistoricalEvidence(rows: readonly MatchingEvidenceRow[]): HistoricalMatchingPeriodEvidence[] {
  return rows.map((row) => ({
    id: row.id,
    workpaperId: row.workpaper_id,
    vintageKey: row.vintage_key,
    parentKey: row.parent_key,
    taxYearWindowId: row.tax_year_window_id,
    yearStart: row.year_start,
    yearEnd: row.year_end,
    actualDeduction: row.actual_deduction,
    recomputedDeduction: row.recomputed_deduction,
    transferOn: row.transfer_on,
  }));
}

async function loadMatchingEvidenceForPaper(
  tx: SqlExecutor,
  orgId: string,
  workpaperId: string,
): Promise<HistoricalMatchingPeriodEvidence[]> {
  const rows = (
    await tx.execute<MatchingEvidenceRow>(sql`
      select m.id, m.workpaper_id, m.vintage_key, m.parent_key, m.tax_year_window_id,
             m.year_start::text, m.year_end::text,
             m.actual_deduction::text, m.recomputed_deduction::text,
             w.effective_on::text as transfer_on
        from tax_consolidated_matching_periods m
        join tax_asset_basis_workpapers w
          on w.org_id=m.org_id and w.id=m.workpaper_id
       where m.org_id=${orgId} and m.workpaper_id=${workpaperId}
       order by m.vintage_key, m.year_start, m.year_end, m.id`)
  ).rows;
  return asHistoricalEvidence(rows);
}

async function sameSourceReversedPapers(
  tx: SqlExecutor,
  orgId: string,
  source: { sourceChangeId: string | null; sourceEventId: string | null },
): Promise<{ id: string }[]> {
  return (
    await tx.execute<{ id: string }>(sql`
      select w.id
        from tax_asset_basis_workpapers w
       where w.org_id=${orgId}
         and w.regime='us_macrs'
         and w.reversed_by_change_id is not null
         and (
           (${source.sourceChangeId}::uuid is not null and w.source_change_id=${source.sourceChangeId})
           or (${source.sourceEventId}::uuid is not null and w.source_change_id is null
               and w.source_event_id=${source.sourceEventId})
         )
       order by w.created_at desc, w.id desc`)
  ).rows;
}

async function loadPredecessorMatchingEvidence(
  tx: SqlExecutor,
  orgId: string,
  source: { sourceChangeId: string | null; sourceEventId: string | null },
): Promise<{
  predecessorId: string;
  historical: HistoricalMatchingPeriodEvidence[];
  ancestorWithMatchingId: string | null;
}> {
  const papers = await sameSourceReversedPapers(tx, orgId, source);
  const predecessor = papers[0];
  if (!predecessor) {
    throw new TaxMatchingReplayError(
      "1.1502-13 matching replay cites the reversed workpaper's posted years; reverse the prior paper and apply its replacement first — do not invent earlier years or borrow an older paper's opening",
    );
  }
  const historical = await loadMatchingEvidenceForPaper(tx, orgId, predecessor.id);
  let ancestorWithMatchingId: string | null = historical.length > 0 ? predecessor.id : null;
  if (!ancestorWithMatchingId) {
    for (const paper of papers.slice(1)) {
      const rows = await loadMatchingEvidenceForPaper(tx, orgId, paper.id);
      if (rows.length > 0) {
        ancestorWithMatchingId = paper.id;
        break;
      }
    }
  }
  return { predecessorId: predecessor.id, historical, ancestorWithMatchingId };
}

async function latestUsMacrsPoolYearStart(
  tx: SqlExecutor,
  orgId: string,
  subsidiaryId: string,
): Promise<string | null> {
  const row = (
    await tx.execute<{ year_start: string }>(sql`
      select tw.year_start::text
        from tax_pool_periods pp
        join tax_depreciation_pools tp on tp.id=pp.pool_id and tp.org_id=pp.org_id
        join tax_year_windows tw on tw.id=pp.tax_year_window_id and tw.org_id=pp.org_id
       where tp.org_id=${orgId} and tp.subsidiary_id=${subsidiaryId} and tp.regime='us_macrs'
       order by tw.year_start desc, tw.year_end desc
       limit 1`)
  ).rows[0];
  return row?.year_start ?? null;
}

type ReplacementPaper = {
  workpaperId: string;
  changeId: string;
  subjectId: string;
  subsidiaryId: string;
  effectiveOn: string;
  requiredSubsidiaryIds: string[];
  sourceChangeId: string | null;
  sourceEventId: string | null;
  computed: Record<string, unknown>;
};

async function peekFinancialChange(
  tx: SqlExecutor,
  orgId: string,
  id: string,
): Promise<FinancialChange> {
  const row = (
    await tx.execute<FinancialChange>(sql`
      select *, effective_on::text as effective_on from financial_changes
       where id=${id} and org_id=${orgId}`)
  ).rows[0];
  if (!row) throw new TaxMatchingReplayError("financial change not found");
  return row;
}

function replacementFenceSubsidiaryIds(
  paper: Pick<ReplacementPaper, "subsidiaryId" | "requiredSubsidiaryIds" | "computed">,
): string[] {
  const ids = [...paper.requiredSubsidiaryIds, paper.subsidiaryId];
  try {
    const frozen = resolveFrozenUsConsolidatedMatching(paper.computed);
    ids.push(
      frozen.consolidatedMembership.sellerSubsidiaryId,
      frozen.consolidatedMembership.buyerSubsidiaryId,
    );
  } catch {
    // Membership is revalidated after the fence; peek may precede a locked reread.
  }
  return [...new Set(ids)].sort();
}

function assertReplayFenceCovers(locked: readonly string[], needed: readonly string[]): void {
  const held = new Set(locked);
  const missing = needed.filter((id) => !held.has(id));
  if (missing.length > 0) {
    throw new TaxMatchingReplayError(
      "1.1502-13 matching replay must lock every seller, buyer and replacement legal entity before reading the replacement workpaper; reload the replacement — do not take a second lifecycle fence after a financial-change row lock",
    );
  }
}

async function readReplacementPaper(
  tx: SqlExecutor,
  orgId: string,
  replacementWorkpaperChangeId: string,
  mode: "peek" | "lock",
): Promise<ReplacementPaper> {
  const change = mode === "lock"
    ? await loadFinancialChange(tx, orgId, replacementWorkpaperChangeId)
    : await peekFinancialChange(tx, orgId, replacementWorkpaperChangeId);
  if (change.domain !== "asset" || change.operation !== "tax_basis" || change.status !== "applied") {
    throw new TaxMatchingReplayError(
      "1.1502-13 matching replay cites the applied replacement tax basis workpaper; apply that paper first — do not replay onto a draft or the reversed paper",
    );
  }
  const paper = (
    await tx.execute<{
      id: string;
      source_change_id: string | null;
      source_event_id: string | null;
      computed: Record<string, unknown>;
    }>(sql`
      select id, source_change_id, source_event_id, computed
        from tax_asset_basis_workpapers
       where org_id=${orgId} and change_id=${replacementWorkpaperChangeId}
         and regime='us_macrs' and reversed_by_change_id is null`)
  ).rows[0];
  if (!paper) {
    throw new TaxMatchingReplayError(
      "1.1502-13 matching replay requires the live US MACRS replacement workpaper; reverse and re-propose it — do not replay a reversed paper",
    );
  }
  const required = (change.payload.requiredSubsidiaryIds as string[] | undefined) ?? [change.subsidiary_id];
  return {
    workpaperId: paper.id,
    changeId: change.id,
    subjectId: change.subject_id,
    subsidiaryId: change.subsidiary_id,
    effectiveOn: change.effective_on,
    requiredSubsidiaryIds: required,
    sourceChangeId: paper.source_change_id,
    sourceEventId: paper.source_event_id,
    computed: paper.computed,
  };
}

function requiredCiteIds(historical: readonly HistoricalMatchingPeriodEvidence[]): string[] {
  return historical.map((row) => row.id);
}

function assertCitedSet(
  cited: readonly string[],
  required: readonly string[],
): void {
  const left = [...cited].sort();
  const right = [...required].sort();
  if (left.length !== right.length || left.some((id, index) => id !== right[index])) {
    throw new TaxMatchingReplayError(
      "cited historical matching years must be exactly the earlier posted years; reload the replacement workpaper — do not omit a year or type a UUID",
    );
  }
}

function replayedFromCitedHistory(args: {
  paper: ReplacementPaper;
  frozen: ReturnType<typeof resolveFrozenUsConsolidatedMatching>;
  historical: readonly HistoricalMatchingPeriodEvidence[];
}): MatchingPeriodReplay[] {
  try {
    return replayMatchingPaperFromCitedHistory({
      replacementWorkpaperId: args.paper.workpaperId,
      replacementWorkpaperChangeId: args.paper.changeId,
      replacementOpening: args.frozen.consolidatedMatching.deferredOpening,
      replacementMembership: args.frozen.consolidatedMembership,
      historical: args.historical,
      vintageWeights: receivingMatchingVintageWeightsFromComputed(
        args.paper.computed,
        args.paper.effectiveOn,
      ),
      transferOn: args.paper.effectiveOn,
    });
  } catch (error) {
    asReplayError(error);
  }
}

type ReplaySnapshot = TaxMatchingReplayPreview & {
  paper: ReplacementPaper;
  frozen: ReturnType<typeof resolveFrozenUsConsolidatedMatching>;
  replayed: MatchingPeriodReplay[];
};

function publicReplayPreview(snapshot: ReplaySnapshot): TaxMatchingReplayPreview {
  return {
    assetId: snapshot.paper.subjectId,
    replacementWorkpaperId: snapshot.replacementWorkpaperId,
    replacementWorkpaperChangeId: snapshot.replacementWorkpaperChangeId,
    latestPoolYearStart: snapshot.latestPoolYearStart,
    citedHistoricalPeriodIds: snapshot.citedHistoricalPeriodIds,
    historical: snapshot.historical,
    replacementOpening: snapshot.replacementOpening,
    replayedPeriods: snapshot.replayedPeriods,
  };
}

function replayBeforeState(snapshot: ReplaySnapshot): Record<string, unknown> {
  return {
    assetId: snapshot.paper.subjectId,
    replacementWorkpaperChangeId: snapshot.replacementWorkpaperChangeId,
    replacementWorkpaperId: snapshot.replacementWorkpaperId,
    citedHistoricalPeriodIds: snapshot.citedHistoricalPeriodIds,
    historical: snapshot.historical,
    latestPoolYearStart: snapshot.latestPoolYearStart,
    replacementOpening: snapshot.replacementOpening,
    membership: snapshot.frozen.consolidatedMembership,
    replayedPeriods: snapshot.replayedPeriods,
  };
}

async function buildReplayPreview(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  replacementWorkpaperChangeId: string,
  mode: "peek" | "lock",
): Promise<ReplaySnapshot> {
  const paper = await readReplacementPaper(tx, orgId, replacementWorkpaperChangeId, mode);
  await assertFinancialChangeAccess(tx, {
    orgId,
    actorId,
    subsidiaryIds: paper.requiredSubsidiaryIds,
    permission: "assets.manage",
    feature: "fixedAssets",
  });
  let frozen;
  try {
    frozen = resolveFrozenUsConsolidatedMatching(paper.computed);
  } catch (error) {
    asReplayError(error);
  }
  const predecessor = await loadPredecessorMatchingEvidence(tx, orgId, {
    sourceChangeId: paper.sourceChangeId,
    sourceEventId: paper.sourceEventId,
  });
  const latestPoolYearStart = await latestUsMacrsPoolYearStart(
    tx,
    orgId,
    frozen.consolidatedMembership.buyerSubsidiaryId,
  );
  if (latestPoolYearStart && predecessor.historical.length === 0) {
    throw new TaxMatchingReplayError(
      predecessor.ancestorWithMatchingId
        ? `the immediately reversed workpaper ${predecessor.predecessorId} has no posted 1.1502-13 matching, so ordinary tax_matching_replay cannot cite it; approve tax_matching_generation_repair on this live replacement citing the last paper that still has posted matching — a reversed paper cannot receive replay and skipping a generation is not authorized by ordinary replay`
        : `the reversed workpaper ${predecessor.predecessorId} has no posted 1.1502-13 matching earlier than the latest computed tax year starting ${latestPoolYearStart}; this generation cannot be repaired from an uncited older opening — do not invent earlier years or re-run the earlier year`,
    );
  }
  const toReplay = historicalMatchingYearsToReplay(predecessor.historical, latestPoolYearStart);
  if (toReplay.length === 0) {
    throw new TaxMatchingReplayError(
      "no earlier matching year requires replay; re-run the latest computed year from Fixed Assets tax pools — an earlier year cannot be restated after a later result exists and uncited historical openings cannot be borrowed",
    );
  }
  const replayed = replayedFromCitedHistory({ paper, frozen, historical: toReplay });
  return {
    assetId: paper.subjectId,
    replacementWorkpaperId: paper.workpaperId,
    replacementWorkpaperChangeId: paper.changeId,
    latestPoolYearStart,
    citedHistoricalPeriodIds: requiredCiteIds(toReplay),
    historical: toReplay,
    replacementOpening: frozen.consolidatedMatching.deferredOpening,
    replayedPeriods: replayed.map(matchingReplayPeriodEvidence),
    paper,
    frozen,
    replayed,
  };
}

/** Peek replacement identity, take the complete sorted fence once, then
 *  re-read the replacement financial change under FOR UPDATE. A second
 *  fence after that row lock is a deadlock against workpaper reversal. */
async function fencedReplayPreview(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  replacementWorkpaperChangeId: string,
  lockSubsidiaryIds: readonly string[],
): Promise<ReplaySnapshot> {
  const seed = await readReplacementPaper(tx, orgId, replacementWorkpaperChangeId, "peek");
  const fence = [...new Set([...lockSubsidiaryIds, ...replacementFenceSubsidiaryIds(seed)])].sort();
  await lockAssetTaxLifecycle(tx, orgId, fence);
  const preview = await buildReplayPreview(
    tx,
    orgId,
    actorId,
    replacementWorkpaperChangeId,
    "lock",
  );
  assertReplayFenceCovers(
    fence,
    replacementFenceSubsidiaryIds(preview.paper),
  );
  return preview;
}

export async function previewTaxMatchingReplay(
  orgId: string,
  actorId: string,
  replacementWorkpaperChangeId: string,
): Promise<TaxMatchingReplayPreview> {
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      return publicReplayPreview(
        await buildReplayPreview(db, orgId, actorId, replacementWorkpaperChangeId, "peek"),
      );
    }),
  );
}

export async function proposeTaxMatchingReplay(
  orgId: string,
  actorId: string,
  input: TaxMatchingReplayInput,
): Promise<string> {
  if (input.reason.trim().length < 8 || input.reason.trim().length > 1000) {
    throw new TaxMatchingReplayError("record a replay reason between 8 and 1,000 characters");
  }
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const seed = await readReplacementPaper(db, orgId, input.replacementWorkpaperChangeId, "peek");
      await assertFinancialChangeAccess(db, {
        orgId,
        actorId,
        subsidiaryIds: seed.requiredSubsidiaryIds,
        permission: "assets.manage",
        feature: "fixedAssets",
      });
      const preview = await fencedReplayPreview(
        db,
        orgId,
        actorId,
        input.replacementWorkpaperChangeId,
        seed.requiredSubsidiaryIds,
      );
      assertCitedSet(input.citedHistoricalPeriodIds, preview.citedHistoricalPeriodIds);
      const args = {
        orgId,
        subsidiaryId: preview.paper.subsidiaryId,
        domain: "asset" as const,
        subjectId: preview.paper.subjectId,
        operation: TAX_MATCHING_REPLAY_OPERATION,
        effectiveOn: preview.paper.effectiveOn,
        reason: input.reason.trim(),
        actorId,
        idempotencyKey: input.idempotencyKey,
        payload: {
          replacementWorkpaperChangeId: preview.replacementWorkpaperChangeId,
          replacementWorkpaperId: preview.replacementWorkpaperId,
          citedHistoricalPeriodIds: preview.citedHistoricalPeriodIds,
          requiredSubsidiaryIds: preview.paper.requiredSubsidiaryIds,
        },
      };
      const prior = await existingFinancialChange(db, args);
      if (prior) return prior;
      return proposeFinancialChange(db, {
        ...args,
        beforeState: replayBeforeState(preview),
      });
    }),
  );
}

export async function applyTaxMatchingReplay(
  orgId: string,
  changeId: string,
  actorId: string,
): Promise<TaxMatchingReplayApplyResult> {
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const change = await loadFinancialChange(db, orgId, changeId);
      if (change.domain !== "asset" || change.operation !== TAX_MATCHING_REPLAY_OPERATION) {
        throw new TaxMatchingReplayError("this is not a 1.1502-13 matching replay");
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
      if (change.status === "applied") return change.result as TaxMatchingReplayApplyResult;
      const preview = await fencedReplayPreview(
        db,
        orgId,
        actorId,
        String(change.payload.replacementWorkpaperChangeId ?? ""),
        required,
      );
      assertCitedSet(
        (change.payload.citedHistoricalPeriodIds as string[] | undefined) ?? [],
        preview.citedHistoricalPeriodIds,
      );
      assertFinancialChangeApproved(change, {
        domain: "asset",
        subjectId: preview.paper.subjectId,
        beforeState: replayBeforeState(preview),
      });
      const allowed = await actorAllowedSubsidiaryIds(db, orgId, change.approved_by!);
      if (allowed && preview.paper.requiredSubsidiaryIds.some((id) => !allowed.has(id))) {
        throw new TaxMatchingReplayError(
          "the independent approver no longer covers every legal entity on this matching replay; obtain a new approval",
        );
      }
      const replayedIds: string[] = [];
      for (const row of preview.replayed) {
        const written = await db.execute<{ id: string }>(sql`
          insert into tax_consolidated_matching_periods
            (org_id, workpaper_id, workpaper_change_id, vintage_key, parent_key, tax_year_window_id,
             year_start, year_end, group_key, seller_subsidiary_id, buyer_subsidiary_id,
             membership_effective_on, membership_through_on, deferred_opening, actual_deduction,
             recomputed_deduction, actual_corresponding_amount, recomputed_corresponding_amount,
             seller_matching_amount, deferred_closing, prior_matching_period_id, replay_change_id,
             created_by, updated_by)
          values (${orgId}, ${row.workpaperId}, ${row.workpaperChangeId}, ${row.vintageKey}, ${row.parentKey},
                  ${row.taxYearWindowId}, ${row.yearStart}, ${row.yearEnd}, ${row.groupKey},
                  ${row.sellerSubsidiaryId}, ${row.buyerSubsidiaryId},
                  ${row.membershipEffectiveOn}, ${row.membershipThroughOn},
                  ${row.deferredOpening}, ${row.actualDeduction}, ${row.recomputedDeduction},
                  ${row.actualCorrespondingAmount}, ${row.recomputedCorrespondingAmount},
                  ${row.sellerMatchingAmount}, ${row.deferredClosing}, ${row.priorMatchingPeriodId},
                  ${changeId}, ${actorId}, ${actorId})
          returning id`);
        if (written.rows.length !== 1) {
          throw new TaxMatchingReplayError(
            `posted 1.1502-13 matching replay for receiving workpaper ${preview.replacementWorkpaperId} vintage ${row.vintageKey} ${row.yearStart}–${row.yearEnd} was not written; a write that matches zero rows is a failure — do not overwrite historical matching`,
          );
        }
        replayedIds.push(written.rows[0]!.id);
      }
      const result: TaxMatchingReplayApplyResult = {
        changeId,
        assetId: preview.paper.subjectId,
        replacementWorkpaperId: preview.replacementWorkpaperId,
        replacementWorkpaperChangeId: preview.replacementWorkpaperChangeId,
        citedHistoricalPeriodIds: preview.citedHistoricalPeriodIds,
        replayedPeriodIds: replayedIds,
        replayedPeriods: preview.replayedPeriods,
      };
      await completeFinancialChange(db, orgId, changeId, actorId, result);
      return result;
    }),
  );
}

/** Posted replay rows are write-once. Reverse the replacement tax_basis
 *  workpaper and approve a new tax_matching_replay that cites those rows. */
export async function proposeTaxMatchingReplayReversal(): Promise<never> {
  throw new TaxMatchingReplayError(
    "posted 1.1502-13 matching replay cannot be unwritten; reverse the replacement tax basis workpaper and approve a new tax_matching_replay that cites these rows — there is no reversal of a computed tax year",
  );
}

/** Refuse reversing a live replacement that still owes predecessor replay.
 *  The paper is still unreversed, so ordinary tax_matching_replay remains
 *  the remedy. Call after the fenced source reread and after an idempotent
 *  proposal return. */
export async function assertRequiredMatchingReplayBeforeReversal(
  tx: SqlExecutor,
  orgId: string,
  workpaperIds: readonly string[],
): Promise<void> {
  for (const workpaperId of workpaperIds) {
    const paper = (
      await tx.execute<{
        source_change_id: string | null;
        source_event_id: string | null;
      }>(sql`
        select source_change_id, source_event_id
          from tax_asset_basis_workpapers
         where org_id=${orgId} and id=${workpaperId}`)
    ).rows[0];
    if (!paper?.source_change_id && !paper?.source_event_id) continue;
    const predecessors = await sameSourceReversedPapers(tx, orgId, {
      sourceChangeId: paper.source_change_id,
      sourceEventId: paper.source_event_id,
    });
    const predecessor = predecessors[0];
    if (!predecessor) continue;
    const historical = await loadMatchingEvidenceForPaper(tx, orgId, predecessor.id);
    if (historical.length === 0) continue;
    const buyer = (
      await tx.execute<{ buyer_subsidiary_id: string }>(sql`
        select buyer_subsidiary_id
          from tax_consolidated_matching_periods
         where org_id=${orgId} and workpaper_id=${predecessor.id}
         order by year_start desc, id desc
         limit 1`)
    ).rows[0];
    const latestPoolYearStart = buyer
      ? await latestUsMacrsPoolYearStart(tx, orgId, buyer.buyer_subsidiary_id)
      : null;
    const toReplay = historicalMatchingYearsToReplay(historical, latestPoolYearStart);
    if (toReplay.length === 0) continue;
    const cited = new Set(
      (
        await tx.execute<{ id: string }>(sql`
          select prior_matching_period_id::text as id
            from tax_consolidated_matching_periods
           where org_id=${orgId} and workpaper_id=${workpaperId}
             and prior_matching_period_id is not null`)
      ).rows.map((row) => row.id),
    );
    if (toReplay.some((row) => !cited.has(row.id))) {
      throw new TaxMatchingReplayError(
        "apply tax_matching_replay on this replacement workpaper citing the reversed paper's posted 1.1502-13 matching years before reversing it — do not skip a generation. A reversed paper cannot receive replay",
      );
    }
  }
}

async function buildGenerationRepairPreview(
  tx: SqlExecutor,
  orgId: string,
  actorId: string,
  replacementWorkpaperChangeId: string,
  mode: "peek" | "lock",
): Promise<ReplaySnapshot & { skippedPredecessorId: string; repairedFromWorkpaperId: string }> {
  const paper = await readReplacementPaper(tx, orgId, replacementWorkpaperChangeId, mode);
  await assertFinancialChangeAccess(tx, {
    orgId,
    actorId,
    subsidiaryIds: paper.requiredSubsidiaryIds,
    permission: "assets.manage",
    feature: "fixedAssets",
  });
  let frozen;
  try {
    frozen = resolveFrozenUsConsolidatedMatching(paper.computed);
  } catch (error) {
    asReplayError(error);
  }
  const predecessor = await loadPredecessorMatchingEvidence(tx, orgId, {
    sourceChangeId: paper.sourceChangeId,
    sourceEventId: paper.sourceEventId,
  });
  if (predecessor.historical.length > 0) {
    throw new TaxMatchingReplayError(
      "ordinary tax_matching_replay cites the immediately reversed workpaper; do not approve tax_matching_generation_repair when that paper still has posted matching",
    );
  }
  if (!predecessor.ancestorWithMatchingId) {
    throw new TaxMatchingReplayError(
      `the reversed workpaper ${predecessor.predecessorId} has no posted 1.1502-13 matching and no earlier same-source paper has posted matching to repair from — do not invent earlier years or borrow an uncited opening`,
    );
  }
  const historical = await loadMatchingEvidenceForPaper(
    tx,
    orgId,
    predecessor.ancestorWithMatchingId,
  );
  const latestPoolYearStart = await latestUsMacrsPoolYearStart(
    tx,
    orgId,
    frozen.consolidatedMembership.buyerSubsidiaryId,
  );
  const toReplay = historicalMatchingYearsToReplay(historical, latestPoolYearStart);
  if (toReplay.length === 0) {
    throw new TaxMatchingReplayError(
      "no earlier matching year requires a generation repair; re-run the latest computed year from Fixed Assets tax pools — an uncited historical opening cannot be borrowed",
    );
  }
  const replayed = replayedFromCitedHistory({ paper, frozen, historical: toReplay });
  return {
    assetId: paper.subjectId,
    replacementWorkpaperId: paper.workpaperId,
    replacementWorkpaperChangeId: paper.changeId,
    latestPoolYearStart,
    citedHistoricalPeriodIds: requiredCiteIds(toReplay),
    historical: toReplay,
    replacementOpening: frozen.consolidatedMatching.deferredOpening,
    replayedPeriods: replayed.map(matchingReplayPeriodEvidence),
    paper,
    frozen,
    replayed,
    skippedPredecessorId: predecessor.predecessorId,
    repairedFromWorkpaperId: predecessor.ancestorWithMatchingId,
  };
}

export async function proposeTaxMatchingGenerationRepair(
  orgId: string,
  actorId: string,
  input: TaxMatchingReplayInput,
): Promise<string> {
  if (input.reason.trim().length < 8 || input.reason.trim().length > 1000) {
    throw new TaxMatchingReplayError("record a generation-repair reason between 8 and 1,000 characters");
  }
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const seed = await readReplacementPaper(db, orgId, input.replacementWorkpaperChangeId, "peek");
      await assertFinancialChangeAccess(db, {
        orgId,
        actorId,
        subsidiaryIds: seed.requiredSubsidiaryIds,
        permission: "assets.manage",
        feature: "fixedAssets",
      });
      const fence = replacementFenceSubsidiaryIds(seed);
      await lockAssetTaxLifecycle(db, orgId, fence);
      const preview = await buildGenerationRepairPreview(
        db,
        orgId,
        actorId,
        input.replacementWorkpaperChangeId,
        "lock",
      );
      assertReplayFenceCovers(fence, replacementFenceSubsidiaryIds(preview.paper));
      assertCitedSet(input.citedHistoricalPeriodIds, preview.citedHistoricalPeriodIds);
      const args = {
        orgId,
        subsidiaryId: preview.paper.subsidiaryId,
        domain: "asset" as const,
        subjectId: preview.paper.subjectId,
        operation: TAX_MATCHING_GENERATION_REPAIR_OPERATION,
        effectiveOn: preview.paper.effectiveOn,
        reason: input.reason.trim(),
        actorId,
        idempotencyKey: input.idempotencyKey,
        payload: {
          replacementWorkpaperChangeId: preview.replacementWorkpaperChangeId,
          replacementWorkpaperId: preview.replacementWorkpaperId,
          citedHistoricalPeriodIds: preview.citedHistoricalPeriodIds,
          requiredSubsidiaryIds: preview.paper.requiredSubsidiaryIds,
          skippedPredecessorId: preview.skippedPredecessorId,
          repairedFromWorkpaperId: preview.repairedFromWorkpaperId,
        },
      };
      const prior = await existingFinancialChange(db, args);
      if (prior) return prior;
      return proposeFinancialChange(db, {
        ...args,
        beforeState: {
          ...replayBeforeState(preview),
          skippedPredecessorId: preview.skippedPredecessorId,
          repairedFromWorkpaperId: preview.repairedFromWorkpaperId,
        },
      });
    }),
  );
}

export async function applyTaxMatchingGenerationRepair(
  orgId: string,
  changeId: string,
  actorId: string,
): Promise<TaxMatchingReplayApplyResult> {
  return withOrg(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const change = await loadFinancialChange(db, orgId, changeId);
      if (change.domain !== "asset" || change.operation !== TAX_MATCHING_GENERATION_REPAIR_OPERATION) {
        throw new TaxMatchingReplayError("this is not a 1.1502-13 matching generation repair");
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
      if (change.status === "applied") return change.result as TaxMatchingReplayApplyResult;
      const seed = await readReplacementPaper(
        db,
        orgId,
        String(change.payload.replacementWorkpaperChangeId ?? ""),
        "peek",
      );
      const fence = [...new Set([...required, ...replacementFenceSubsidiaryIds(seed)])].sort();
      await lockAssetTaxLifecycle(db, orgId, fence);
      const preview = await buildGenerationRepairPreview(
        db,
        orgId,
        actorId,
        String(change.payload.replacementWorkpaperChangeId ?? ""),
        "lock",
      );
      assertReplayFenceCovers(fence, replacementFenceSubsidiaryIds(preview.paper));
      assertCitedSet(
        (change.payload.citedHistoricalPeriodIds as string[] | undefined) ?? [],
        preview.citedHistoricalPeriodIds,
      );
      assertFinancialChangeApproved(change, {
        domain: "asset",
        subjectId: preview.paper.subjectId,
        beforeState: {
          ...replayBeforeState(preview),
          skippedPredecessorId: preview.skippedPredecessorId,
          repairedFromWorkpaperId: preview.repairedFromWorkpaperId,
        },
      });
      const allowed = await actorAllowedSubsidiaryIds(db, orgId, change.approved_by!);
      if (allowed && preview.paper.requiredSubsidiaryIds.some((id) => !allowed.has(id))) {
        throw new TaxMatchingReplayError(
          "the independent approver no longer covers every legal entity on this matching generation repair; obtain a new approval",
        );
      }
      const replayedIds: string[] = [];
      for (const row of preview.replayed) {
        const written = await db.execute<{ id: string }>(sql`
          insert into tax_consolidated_matching_periods
            (org_id, workpaper_id, workpaper_change_id, vintage_key, parent_key, tax_year_window_id,
             year_start, year_end, group_key, seller_subsidiary_id, buyer_subsidiary_id,
             membership_effective_on, membership_through_on, deferred_opening, actual_deduction,
             recomputed_deduction, actual_corresponding_amount, recomputed_corresponding_amount,
             seller_matching_amount, deferred_closing, prior_matching_period_id, replay_change_id,
             created_by, updated_by)
          values (${orgId}, ${row.workpaperId}, ${row.workpaperChangeId}, ${row.vintageKey}, ${row.parentKey},
                  ${row.taxYearWindowId}, ${row.yearStart}, ${row.yearEnd}, ${row.groupKey},
                  ${row.sellerSubsidiaryId}, ${row.buyerSubsidiaryId},
                  ${row.membershipEffectiveOn}, ${row.membershipThroughOn},
                  ${row.deferredOpening}, ${row.actualDeduction}, ${row.recomputedDeduction},
                  ${row.actualCorrespondingAmount}, ${row.recomputedCorrespondingAmount},
                  ${row.sellerMatchingAmount}, ${row.deferredClosing}, ${row.priorMatchingPeriodId},
                  ${changeId}, ${actorId}, ${actorId})
          returning id`);
        if (written.rows.length !== 1) {
          throw new TaxMatchingReplayError(
            `posted 1.1502-13 matching generation repair for receiving workpaper ${preview.replacementWorkpaperId} vintage ${row.vintageKey} ${row.yearStart}–${row.yearEnd} was not written; a write that matches zero rows is a failure — do not overwrite historical matching`,
          );
        }
        replayedIds.push(written.rows[0]!.id);
      }
      const result: TaxMatchingReplayApplyResult = {
        changeId,
        assetId: preview.paper.subjectId,
        replacementWorkpaperId: preview.replacementWorkpaperId,
        replacementWorkpaperChangeId: preview.replacementWorkpaperChangeId,
        citedHistoricalPeriodIds: preview.citedHistoricalPeriodIds,
        replayedPeriodIds: replayedIds,
        replayedPeriods: preview.replayedPeriods,
      };
      await completeFinancialChange(db, orgId, changeId, actorId, result);
      return result;
    }),
  );
}
