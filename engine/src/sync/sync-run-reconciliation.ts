import { sql } from "drizzle-orm";
import { db, schema, withOrg } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { SYSTEM_ACTOR_ID } from "../banking/banking.ts";
import { reconcileApplications, recomputeOpenBalances } from "./applications.ts";
import { trueUpResidualGl } from "./trueup.ts";
import {
  applySourceReconciliationEvidence,
  type SourceEvidenceOutcome,
} from "./source-evidence.ts";
import { syncProjectFinancialInputs } from "./project-financial-inputs.ts";
import { AttachmentImportError } from "./netsuite-attachments.ts";
import type { NativeChanges, MigrationSource } from "./source.ts";
import type { NativeContext, NativeDocument } from "./native.ts";
import { resolveSyncSelection } from "./connection-settings.ts";
import type { EntityLoadStats, PartyMirrorOutcome } from "./migrate.ts";
import type { SourceLedgerVerification, SyncResult } from "./sync-result.ts";
import {
  SyncVerificationError,
  onlyLedgerComparisonsDiffer,
  syncVerificationFailures,
  verifyCurrentLedgerState,
  verifyTargetedDocumentKeys,
} from "./sync-verification-state.ts";
import { attachmentChangesScope, lastFullAttachmentSweepAt } from "./sync-attachment-scope.ts";
import { canonicalNativeDocumentKey, storedKey } from "./sync-document-identity.ts";
import { setProgress } from "./sync-run-claiming.ts";

interface SyncRunContinuation {
  source: MigrationSource;
  triggeredBy: string;
  org: { id: string };
  connectionId: string;
  kind: SyncResult["kind"];
  targetedRefs: string[] | null;
  refKey: string;
  since: Date | null;
  run: { id: string };
  started: number;
  selection: ReturnType<typeof resolveSyncSelection>;
  changes: NativeChanges;
  existing: ReadonlyMap<string, { id: string }>;
  ctx: NativeContext;
  entityStats: EntityLoadStats | undefined;
  partyOutcome: PartyMirrorOutcome;
  supplemental: Pick<
    SyncResult,
    | "attachments"
    | "projectFinancials"
    | "operationalRecords"
    | "excludedPopulations"
    | "settlementObservation"
  >;
  docsNew: number;
  docsAmended: number;
  docsUnchanged: number;
  docsFailed: number;
  ordersNew: number;
  skipped: string[];
  writeFailures: string[];
  deletedAtSource: Set<string>;
  autoResolvedDeletions: string[];
  convergedCancelledRefs: Set<string>;
}

async function reconcileSyncRun(args: SyncRunContinuation): Promise<{
  applications: Awaited<ReturnType<typeof reconcileApplications>> | null;
  trueUp: Awaited<ReturnType<typeof trueUpResidualGl>> | null;
  sourceEvidence: SourceEvidenceOutcome | null;
}> {
  const {
    source,
    triggeredBy,
    org,
    connectionId,
    targetedRefs,
    run,
    refKey,
    changes,
    docsNew,
    docsAmended,
    docsUnchanged,
    docsFailed,
    ordersNew,
  } = args;
  // -- 6. applications ----------------------------------------------------------
  await setProgress(
    org.id,
    run!.id,
    {
      phase: "applications",
      message: "Reconciling payments & credits…",
      docsNew,
      docsAmended,
      docsUnchanged,
      docsFailed,
      ordersNew,
    },
    true,
  );
  const observation = changes.settlementObservation;
  if (observation && (!connectionId || !source.revalidateSettlementObservation)) {
    throw new Error(
      "observed settlement reconciliation requires its source connection and revalidation",
    );
  }
  if (observation) await source.revalidateSettlementObservation!(observation);
  const applications =
    changes.applications.length > 0 || observation
      ? await reconcileApplications(
          org.id,
          refKey,
          changes.applications,
          observation
            ? {
                complete: observation.scope.kind === "all",
                connectionId: connectionId!,
                source: source.name,
                syncRunId: run!.id,
                observation,
                confirmReleases: source.confirmSettlementReleases
                  ? (refs) => source.confirmSettlementReleases!(observation, refs)
                  : undefined,
              }
            : undefined,
        )
      : null;

  // Optional true-up imports opaque subledger balances through dated adjusting journals.
  // It runs only when explicitly enabled and never during bounded repairs.
  const trueUpEnabled =
    (
      await db.execute<{ on: boolean | null }>(
        sql`select (settings->>'glTrueup')::boolean as on from orgs where id = ${org.id}`,
        "objects",
      )
    )[0]?.on === true;
  const trueUp =
    trueUpEnabled && !targetedRefs
      ? await trueUpResidualGl(org.id, source, {
          actorId: isUuid(triggeredBy) ? triggeredBy : null,
          syncRunId: run!.id,
        })
      : null;

  // Recompute open balances after bulk application changes so aging and verification use current values.
  if (!targetedRefs) await recomputeOpenBalances(org.id);

  // Source-cleared markers update posted lines and covered accounts without changing documents.
  // Bounded repairs skip this supplemental evidence.
  let sourceEvidence: SourceEvidenceOutcome | null = null;
  if (!targetedRefs) {
    await setProgress(
      org.id,
      run!.id,
      {
        phase: "source-evidence",
        message: "Carrying source reconciliation evidence…",
        docsNew,
        docsAmended,
        docsUnchanged,
        docsFailed,
        ordersNew,
      },
      true,
    );
    sourceEvidence = await applySourceReconciliationEvidence({
      orgId: org.id,
      connector: source.name,
      actorId: isUuid(triggeredBy) ? triggeredBy : SYSTEM_ACTOR_ID,
      refKey,
      source,
      documents: changes.documents,
    });
    await setProgress(
      org.id,
      run!.id,
      {
        phase: "source-evidence",
        message: `Stamped ${sourceEvidence.linesStamped} lines, signed off ${sourceEvidence.signedOff.length} accounts…`,
        docsNew,
        docsAmended,
        docsUnchanged,
        docsFailed,
        ordersNew,
      },
      true,
    );
  }

  return { applications, trueUp, sourceEvidence };
}

async function syncSupplementalPopulations(args: SyncRunContinuation): Promise<void> {
  const {
    source,
    triggeredBy,
    org,
    connectionId,
    kind,
    targetedRefs,
    run,
    since,
    selection,
    changes,
    supplemental,
    docsNew,
    docsAmended,
    docsUnchanged,
    docsFailed,
    ordersNew,
  } = args;
  // Supplemental populations share the run claim and completion gate. A
  // failed attachment or commercial-state import cannot advance the cursor.
  if (!targetedRefs && (selection.crm || selection.fixedAssets) && source.syncOperationalRecords) {
    await setProgress(
      org.id,
      run!.id,
      {
        phase: "operational-records",
        message: "Synchronizing enabled operational registers…",
        docsNew,
        docsAmended,
        docsUnchanged,
        docsFailed,
        ordersNew,
      },
      true,
    );
    supplemental.operationalRecords = await source.syncOperationalRecords({
      orgId: org.id,
      connectionId,
      actorId: isUuid(triggeredBy) ? triggeredBy : null,
      populations: { crm: selection.crm, fixedAssets: selection.fixedAssets },
    });
  }

  if (!targetedRefs && selection.attachments && source.syncAttachments) {
    await setProgress(
      org.id,
      run!.id,
      {
        phase: "attachments",
        message: "Checking attachments and importing missing or changed files…",
        docsNew,
        docsAmended,
        docsUnchanged,
        docsFailed,
        ordersNew,
      },
      true,
    );
    try {
      const lastFullSweepAt =
        kind === "incremental" && since
          ? await lastFullAttachmentSweepAt(org.id, connectionId)
          : null;
      const changesScope = attachmentChangesScope({
        kind,
        since,
        lastFullSweepAt,
        now: new Date(),
        pulledRefs: changes.documents.map((document) => document.sourceRef),
      });
      supplemental.attachments = await source.syncAttachments({
        orgId: org.id,
        connectionId,
        actorId: isUuid(triggeredBy) ? triggeredBy : null,
        ...(changesScope ? { changes: changesScope } : {}),
      });
    } catch (error) {
      if (error instanceof AttachmentImportError) supplemental.attachments = error.summary;
      throw error;
    }
  }
  if (!targetedRefs && selection.projectFinancials && source.projectFinancialInputs) {
    await setProgress(
      org.id,
      run!.id,
      {
        phase: "project-financials",
        message: "Reconciling project financial inputs…",
        docsNew,
        docsAmended,
        docsUnchanged,
        docsFailed,
        ordersNew,
      },
      true,
    );
    supplemental.projectFinancials = await syncProjectFinancialInputs(source, {
      orgId: org.id,
      connectionId,
      runId: run!.id,
      actorId: isUuid(triggeredBy) ? triggeredBy : null,
      apply: true,
    });
  }
}

async function buildSyncRunResult(
  args: SyncRunContinuation,
  operations: Awaited<ReturnType<typeof reconcileSyncRun>>,
): Promise<SyncResult> {
  const {
    source,
    org,
    kind,
    targetedRefs,
    run,
    started,
    changes,
    existing,
    ctx,
    entityStats,
    partyOutcome,
    supplemental,
    docsNew,
    docsAmended,
    docsUnchanged,
    docsFailed,
    ordersNew,
    skipped,
    writeFailures,
    deletedAtSource,
    autoResolvedDeletions,
    convergedCancelledRefs,
  } = args;
  const { applications, trueUp, sourceEvidence } = operations;
  // -- 7. verify: authoritative source ledger ----------------------------------
  await setProgress(
    org.id,
    run!.id,
    {
      phase: "verify",
      message: targetedRefs
        ? "Verifying targeted source documents…"
        : "Verifying trial balance, open items, periods & project ledger…",
      docsNew,
      docsAmended,
      docsUnchanged,
      docsFailed,
      ordersNew,
      failureSamples: writeFailures,
    },
    true,
  );
  let targetedDocuments: SyncResult["targetedDocuments"] = null;
  if (targetedRefs) {
    const expectedKeys = changes.documents.map((sourceDocument) => {
      const document: NativeDocument = {
        ...sourceDocument,
        subsidiaryId: sourceDocument.subsidiaryId ?? ctx.rootSubsidiaryId,
        currency: sourceDocument.currency ?? source.baseCurrency,
      };
      return {
        sourceRef: document.sourceRef,
        canonicalKey: canonicalNativeDocumentKey(document),
      };
    });
    const actualKeys = new Map<string, string>();
    for (const expected of expectedKeys) {
      const have = existing.get(expected.sourceRef);
      if (have) actualKeys.set(expected.sourceRef, await storedKey(have.id, org.id));
    }
    targetedDocuments = verifyTargetedDocumentKeys(expectedKeys, actualKeys);
  }
  const financialVerification: SourceLedgerVerification = targetedRefs
    ? {
        tb: { accounts: 0, matches: 0, mismatches: [] },
        openItems: null,
        periods: { checked: 0, matches: 0, mismatches: [] },
        projectPeriods: null,
      }
    : await verifyCurrentLedgerState(source, org.id);

  const result: SyncResult = {
    runId: run!.id,
    kind,
    entities: entityStats,
    docsNew,
    docsAmended,
    docsUnchanged,
    ordersNew,
    docsFailed,
    sourceUnbuildable: changes.unbuildable.filter((row) => !convergedCancelledRefs.has(row.ref))
      .length,
    skipped: skipped.slice(0, 200),
    deletedAtSource: [...deletedAtSource].sort(),
    autoResolvedDeletions: autoResolvedDeletions.sort(),
    partyMerges: partyOutcome.merges,
    partyHolds: partyOutcome.holds,
    applications,
    trueUp,
    sourceEvidence,
    ...supplemental,
    ...financialVerification,
    targetedDocuments,
    syncedThrough: changes.syncedThrough.toISOString(),
    durationMs: Date.now() - started,
  };

  if (syncVerificationFailures(result).length > 0) {
    throw new SyncVerificationError(result);
  }

  return result;
}

async function completeSyncRun(args: SyncRunContinuation, result: SyncResult): Promise<void> {
  const { source, org, connectionId, targetedRefs, run, changes, entityStats } = args;
  const entityFailures = Object.values(entityStats ?? {}).reduce(
    (total, stats) => total + (stats?.failed ?? 0),
    0,
  );
  const entitySummary =
    entityFailures > 0
      ? `${entityFailures} master-data record${entityFailures === 1 ? "" : "s"} failed to load; see stats.entities for the named rows`
      : null;
  // Run completion and the connection watermark are one recoverable checkpoint.
  // Earlier document units are replay-safe if any later financial gate refuses.
  await withOrg(org.id, async () => {
    const completed = await db
      .update(schema.syncRuns)
      .set({
        status: entityFailures > 0 ? "ok_with_errors" : "ok",
        finishedAt: new Date(),
        syncedThrough: targetedRefs ? null : changes.syncedThrough,
        stats: result as unknown as Record<string, unknown>,
        errorMessage: entitySummary,
      })
      .where(
        sql`${schema.syncRuns.id} = ${run!.id} and ${schema.syncRuns.orgId} = ${org.id}
        and ${schema.syncRuns.status} = 'running'`,
      )
      .returning({ id: schema.syncRuns.id });
    if (completed.length !== 1)
      throw new Error("running sync could not be completed; its watermark was preserved");
    if (connectionId && !targetedRefs) {
      const advanced = await db.execute(
        sql`
          update connections set cursor = ${changes.syncedThrough}, last_run_at = now(),
                 status = 'active', last_error = null
           where id = ${connectionId} and org_id = ${org.id} and source = ${source.name}
           returning id`,
        "objects",
      );
      if (advanced.length !== 1) throw new Error("sync connection could not be checkpointed");
    }
  });
}

/** Source transactions that changed after a run's cutoff, applied by one more mirror pass. */
export type LateSourcePass = Pick<
  SyncRunContinuation,
  | "changes"
  | "ctx"
  | "existing"
  | "docsNew"
  | "docsAmended"
  | "docsUnchanged"
  | "docsFailed"
  | "ordersNew"
  | "skipped"
  | "writeFailures"
  | "deletedAtSource"
  | "autoResolvedDeletions"
  | "convergedCancelledRefs"
>;

/** Applies source changes made after `since`; null when the source has none. */
export type LateSourceCatchUp = (since: Date) => Promise<LateSourcePass | null>;

/** Verifications a run may repeat after applying source changes that arrived while it ran. */
const MAX_LATE_SOURCE_PASSES = 2;

function withLatePass(current: SyncRunContinuation, late: LateSourcePass): SyncRunContinuation {
  return {
    ...current,
    // The watermark stays at the first pull, so the next run re-reads late
    // transactions and their supplemental records unchanged.
    changes: {
      ...current.changes,
      unbuildable: [...current.changes.unbuildable, ...late.changes.unbuildable],
    },
    existing: new Map([...current.existing, ...late.existing]),
    docsNew: current.docsNew + late.docsNew,
    docsAmended: current.docsAmended + late.docsAmended,
    docsUnchanged: current.docsUnchanged + late.docsUnchanged,
    docsFailed: current.docsFailed + late.docsFailed,
    ordersNew: current.ordersNew + late.ordersNew,
    skipped: [...current.skipped, ...late.skipped],
    writeFailures: [...current.writeFailures, ...late.writeFailures].slice(0, 20),
    deletedAtSource: new Set([...current.deletedAtSource, ...late.deletedAtSource]),
    autoResolvedDeletions: [...current.autoResolvedDeletions, ...late.autoResolvedDeletions],
    convergedCancelledRefs: new Set([
      ...current.convergedCancelledRefs,
      ...late.convergedCancelledRefs,
    ]),
  };
}

/**
 * Verification compares the mirror with the source as it stands at the end of
 * the run, so a transaction entered at the source while the run was in flight
 * appears on one side only. When verification disagrees, the run applies the
 * source changes made after its cutoff and verifies again. Only ledger
 * comparisons qualify; write failures and other refusals stand as they are. A
 * disagreement that persists with no further source changes is a real
 * difference and refuses.
 */
export async function reconcileAndCompleteSyncRun(
  args: SyncRunContinuation,
  catchUp?: LateSourceCatchUp,
): Promise<SyncResult> {
  const operations = await reconcileSyncRun(args);
  await syncSupplementalPopulations(args);
  let current = args;
  let lateSince = args.changes.syncedThrough;
  let result: SyncResult;
  for (let latePasses = 0; ; latePasses++) {
    try {
      result = await buildSyncRunResult(current, operations);
      break;
    } catch (error) {
      if (!(error instanceof SyncVerificationError) || !catchUp || current.targetedRefs)
        throw error;
      if (latePasses >= MAX_LATE_SOURCE_PASSES || !onlyLedgerComparisonsDiffer(error.result)) {
        throw error;
      }
      const late = await catchUp(lateSince);
      if (!late) throw error;
      if (late.changes.syncedThrough > lateSince) lateSince = late.changes.syncedThrough;
      await reconcileSyncRun({ ...current, ...late });
      current = withLatePass(current, late);
    }
  }
  await completeSyncRun(args, result);
  return result;
}
