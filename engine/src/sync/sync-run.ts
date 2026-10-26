import { resolveSyncSelection, SYNC_CONTENT_KEYS } from "./connection-settings.ts";
import { desc, sql } from "drizzle-orm";
import { db, schema } from "../platform/db.ts";
import { lockLedgerSetupFence } from "../organization/ledger-setup-fence.ts";
import { isUuid } from "../platform/uuid.ts";
import { guardRefusalMessage } from "../platform/database-refusal.ts";
import { type PostingDeps } from "../journal/posting-contracts.ts";
import type { OutOfPeriodDatePolicy } from "./source-posting-date.ts";
import { buildNativeContext, type NativeContext } from "./native.ts";
import {
  loadEntities,
  syncSourceAccountingPeriods,
  syncSourceTransactionReferenceEntities,
  type EntityLoadStats,
  type PartyMirrorOutcome,
} from "./migrate.ts";
import type { MigrationSource } from "./source.ts";
import type { NativeChanges } from "./source.ts";
import { assertSettlementObservation } from "./settlement-observation.ts";
import type { SyncOptions, SyncResult } from "./sync-result.ts";
import {
  SyncVerificationError,
  assertNoSiblingConnection,
  needsStandalonePeriodRefresh,
} from "./sync-verification-state.ts";
import { claimSyncRun, setProgress } from "./sync-run-claiming.ts";
import { applySyncDocuments, type ExistingSourceDocument } from "./sync-run-apply.ts";
import { resolveSyncSourceDeletions } from "./sync-run-deletions.ts";
import { reconcileAndCompleteSyncRun, type LateSourceCatchUp } from "./sync-run-reconciliation.ts";

type SyncSupplemental = Pick<
  SyncResult,
  | "attachments"
  | "projectFinancials"
  | "operationalRecords"
  | "excludedPopulations"
  | "settlementObservation"
>;

interface SyncRunIdentity {
  kind: NonNullable<SyncOptions["kind"]>;
  targetedRefs: string[] | null;
  refKey: string;
  connectionId: string;
  org: { id: string };
  postedChangeAuthorization: SyncOptions["postedChangeAuthorization"];
}

function validateSyncRunOptions(
  source: MigrationSource,
  triggeredBy: string,
  opts: SyncOptions,
): SyncRunIdentity {
  const kind = opts.kind ?? "incremental";
  const targetedRefs = opts.sourceRefs ? [...new Set(opts.sourceRefs.map(String))] : null;
  if (kind === "targeted_repair" && !targetedRefs?.length) {
    throw new Error("targeted repair requires explicit source references");
  }
  if (kind === "targeted_repair" && !isUuid(triggeredBy)) {
    throw new Error(
      "targeted repair requires the active organization user UUID that authorized the correction",
    );
  }
  if (targetedRefs && kind !== "targeted_repair") {
    throw new Error("sourceRefs are only valid for a targeted repair");
  }
  if (targetedRefs && !source.nativeChangesByRefs) {
    throw new Error(`${source.name} does not support targeted source rematerialization`);
  }
  const postedChangeAuthorization = opts.postedChangeAuthorization;
  if (
    postedChangeAuthorization &&
    (!isUuid(postedChangeAuthorization.actorId) ||
      Number.isNaN(postedChangeAuthorization.authorizedAt.getTime()))
  ) {
    throw new Error("posted-change authorization is invalid");
  }
  return {
    kind,
    targetedRefs,
    refKey: source.refKey,
    connectionId: opts.connectionId,
    org: { id: opts.orgId },
    postedChangeAuthorization,
  };
}

async function prepareSyncConnection(
  source: MigrationSource,
  identity: SyncRunIdentity,
  opts: SyncOptions,
  supplemental: SyncSupplemental,
): Promise<{
  selection: ReturnType<typeof resolveSyncSelection>;
  since: Date | null;
  outOfPeriodDatePolicy: OutOfPeriodDatePolicy;
}> {
  const { org, connectionId, targetedRefs } = identity;
  // Source references are organization-wide, so reject sibling connections before writes.
  await assertNoSiblingConnection(org.id, connectionId, source.name);
  const connection = (
    await db.execute<{
      source: string;
      config: Record<string, unknown>;
      out_of_period_date_policy: OutOfPeriodDatePolicy;
    }>(
      sql`
      select source, config, out_of_period_date_policy
        from connections where org_id=${org.id} and id=${connectionId}`,
      "objects",
    )
  )[0];
  if (!connection || connection.source !== source.name)
    throw new Error("Sync connection identity does not match the source");
  const capabilities = {
    attachments: Boolean(source.syncAttachments),
    projectFinancials: Boolean(source.projectFinancialInputs),
    crm: Boolean(source.syncOperationalRecords),
    fixedAssets: Boolean(source.syncOperationalRecords),
  };
  const selection = resolveSyncSelection(connection.config?.syncOptions, capabilities);
  if (!targetedRefs)
    supplemental.excludedPopulations = SYNC_CONTENT_KEYS.filter(
      (key) => capabilities[key] && !selection[key],
    );

  const [lastOk] = await db
    .select()
    .from(schema.syncRuns)
    .where(
      sql`${schema.syncRuns.status} = 'ok' and ${schema.syncRuns.syncedThrough} is not null and ${sql`${schema.syncRuns.connectionId} = ${connectionId}`} and ${schema.syncRuns.orgId} = ${org.id}`,
    )
    .orderBy(desc(schema.syncRuns.syncedThrough))
    .limit(1);
  const since =
    opts.since === undefined || opts.since === "auto"
      ? (lastOk?.syncedThrough ?? new Date(Date.now() - 3 * 24 * 3600 * 1000))
      : opts.since;
  return { selection, since, outOfPeriodDatePolicy: connection.out_of_period_date_policy };
}

async function loadSyncEntities(args: {
  source: MigrationSource;
  triggeredBy: string;
  connectionId: string;
  org: { id: string };
  run: { id: string };
  since: Date | null;
  targetedRefs: string[] | null;
  opts: SyncOptions;
}): Promise<{ entityStats: EntityLoadStats | undefined; partyOutcome: PartyMirrorOutcome }> {
  const { source, triggeredBy, connectionId, org, run, since, targetedRefs, opts } = args;
  await setProgress(org.id, run.id, { phase: "starting", message: "Connecting…" }, true);
  let entityStats: EntityLoadStats | undefined;
  const partyOutcome: PartyMirrorOutcome = { merges: [], holds: [] };
  const loadEntitiesFirst = opts.loadEntitiesFirst ?? true;
  if (needsStandalonePeriodRefresh(targetedRefs, loadEntitiesFirst)) {
    await setProgress(
      org.id,
      run.id,
      { phase: "entities", message: "Refreshing source accounting periods…" },
      true,
    );
    const audit = {
      connectionId,
      runId: run.id,
      actorId: isUuid(triggeredBy) ? triggeredBy : null,
      sourceName: source.name,
    };
    const referenceStats = await syncSourceTransactionReferenceEntities(source, org.id, audit);
    const skippedReferences = Object.values(referenceStats).reduce(
      (total, stats) => total + stats.skipped,
      0,
    );
    if (skippedReferences > 0) {
      throw new Error(
        `${skippedReferences} source transaction reference records could not be loaded`,
      );
    }
    entityStats = {
      accounting_periods: await syncSourceAccountingPeriods(source, org.id),
      ...referenceStats,
    };
  }
  if (loadEntitiesFirst && source.entities) {
    await setProgress(
      org.id,
      run.id,
      { phase: "entities", message: "Loading accounts, parties, items…" },
      true,
    );
    entityStats = await loadEntities(
      source,
      org.id,
      since,
      (message, current, total) => {
        void setProgress(org.id, run.id, { phase: "entities", message, current, total });
      },
      {
        connectionId,
        runId: run.id,
        actorId: isUuid(triggeredBy) ? triggeredBy : null,
        sourceName: source.name,
      },
      undefined,
      partyOutcome,
    );
  }
  return { entityStats, partyOutcome };
}

async function reconcileSourceControlAccounts(args: {
  source: MigrationSource;
  org: { id: string };
  refKey: string;
  triggeredBy: string;
  run: { id: string };
}): Promise<void> {
  const { source, org, refKey, triggeredBy, run } = args;
  if (!source.controlAccounts) return;
  const existingCtrl = (
    await db.execute<{ ctrl: Record<string, string> | null }>(
      sql`select settings->'controlAccounts' as ctrl from orgs where id = ${org.id}`,
      "objects",
    )
  )[0]?.ctrl;
  const refs = await source.controlAccounts();
  const resolved: Record<string, string> = { ...(existingCtrl ?? {}) };
  const sourceControlledKeys = ["ar", "ap", "bank", "taxCollected", "taxPaid"] as const;
  const owned = await db.execute(
    sql`
        select id::text as id
          from accounts
         where org_id = ${org.id}
           and id = any(${`{${Object.values(existingCtrl ?? {})
             .filter((value) => isUuid(value))
             .join(",")}}`}::uuid[])
      `,
    "objects",
  );
  const ownedIds = new Set((owned as Array<{ id: string }>).map((row) => row.id));
  for (const key of sourceControlledKeys) {
    const current = resolved[key];
    if (current && !ownedIds.has(current)) delete resolved[key];
  }
  for (const [key, ref] of Object.entries(refs)) {
    if (!ref) continue;
    const matches = await db.execute<{ id: string }>(
      sql`
          select id
            from accounts
           where org_id = ${org.id}
             and custom->>${refKey} = ${ref}
           order by id
           limit 2
        `,
      "objects",
    );
    if (matches.length !== 1) {
      throw new Error(
        `${source.name} control account ${key} reference ${ref} resolved to ${matches.length} organization accounts`,
      );
    }
    resolved[key] = matches[0]!.id;
  }
  const before = existingCtrl ?? {};
  if (JSON.stringify(before) === JSON.stringify(resolved)) return;
  await db.transaction(async (tx) => {
    await lockLedgerSetupFence(tx, org.id, "exclusive");
    await tx.execute(sql`
            update orgs
               set settings = jsonb_set(
                     coalesce(settings, '{}'::jsonb),
                     '{controlAccounts}',
                     ${JSON.stringify(resolved)}::jsonb,
                     true
                   ),
                   updated_at = now(),
                   updated_by = ${isUuid(triggeredBy) ? triggeredBy : null}
             where id = ${org.id}
          `);
    await tx.execute(sql`
            insert into audit_log
              (org_id, table_name, row_id, action, changes, actor_id, request_id)
            values (
              ${org.id}, 'orgs', ${org.id}, 'update',
              ${JSON.stringify({
                mode: "connector_control_account_reconciliation",
                source: source.name,
                before,
                after: resolved,
              })}::jsonb,
              ${isUuid(triggeredBy) ? triggeredBy : null},
              ${run.id}
            )
          `);
  });
}

async function pullNativeChanges(args: {
  source: MigrationSource;
  org: { id: string };
  run: { id: string };
  refKey: string;
  since: Date | null;
  targetedRefs: string[] | null;
  supplemental: SyncSupplemental;
}): Promise<{ ctx: NativeContext; deps: PostingDeps; changes: NativeChanges }> {
  const { source, org, run, refKey, since, targetedRefs, supplemental } = args;
  const ctx = await buildNativeContext(org.id, refKey, source.baseCurrency);
  ctx.onProgress = (progress) => {
    void setProgress(org.id, run.id, progress);
  };
  const deps: PostingDeps = {
    control: ctx.control,
    cardLiabilityAccountId: ctx.control.ap,
    migration: true,
  };
  await setProgress(org.id, run.id, { phase: "pull", message: "Pulling transactions…" }, true);
  const changes = targetedRefs
    ? await source.nativeChangesByRefs!(targetedRefs, ctx)
    : await source.nativeChanges(since, ctx);
  if (changes.settlementObservation) {
    supplemental.settlementObservation = changes.settlementObservation;
    assertSettlementObservation(
      changes.settlementObservation,
      source.name,
      changes.applications,
      changes.settlementObservation.scope.kind === "all",
    );
  }
  if (targetedRefs) {
    const accountedFor = new Set([
      ...changes.documents.map((document) => document.sourceRef),
      ...changes.unbuildable.map((row) => row.ref),
      ...(changes.nonLedgerRefs ?? []),
    ]);
    const absent = targetedRefs.filter((ref) => !accountedFor.has(ref));
    if (absent.length > 0) {
      throw new Error(`targeted source references were not returned: ${absent.join(", ")}`);
    }
  }
  return { ctx, deps, changes };
}

async function loadExistingSourceDocuments(args: {
  org: { id: string };
  refKey: string;
  changes: NativeChanges;
}): Promise<{
  existing: Map<string, ExistingSourceDocument>;
  allDocumentRows: Array<{
    id: string;
    kind: string;
    party_id: string | null;
    status: string;
    document_number: string;
    posted: boolean;
    ref: string | null;
  }>;
}> {
  const { org, refKey, changes } = args;
  const existing = new Map<string, ExistingSourceDocument>();
  const allDocumentRows = await db.execute<{
    id: string;
    kind: string;
    party_id: string | null;
    status: string;
    document_number: string;
    posted: boolean;
    ref: string | null;
  }>(
    sql`
        select id, kind, party_id, status, document_number,
               posted_entry_id is not null as posted, custom->>${refKey} as ref
          from documents where org_id = ${org.id}`,
    "objects",
  );
  for (const row of allDocumentRows) {
    if (row.ref !== null) {
      existing.set(row.ref, {
        id: row.id,
        kind: row.kind,
        partyId: row.party_id,
        status: row.status,
        posted: row.posted,
        documentNumber: row.document_number,
      });
    }
  }
  const nonpostingRefs = new Set([
    ...(changes.nonLedgerRefs ?? []),
    ...(changes.sourcePresence ?? []).filter((row) => !row.posting).map((row) => row.ref),
  ]);
  for (const ref of nonpostingRefs) {
    const admitted = existing.get(ref);
    if (admitted?.posted && admitted.status !== "voided") {
      throw new Error(
        `source transaction ${ref} is nonposting but has admitted posted history; restore its source posting state or resolve its governed reversal before retrying the sync; posted history was preserved`,
      );
    }
  }
  return { existing, allDocumentRows };
}

export function runFullMigration(
  source: MigrationSource,
  triggeredBy: string,
  ctxOpts: Pick<SyncOptions, "orgId" | "connectionId" | "postedChangeAuthorization">,
): Promise<SyncResult> {
  return runSync(source, triggeredBy, {
    kind: "full_migration",
    since: null,
    loadEntitiesFirst: true,
    ...ctxOpts,
  });
}

/** Governed source-exact rematerialization of a bounded transaction set. */
export function runTargetedRepair(
  source: MigrationSource,
  sourceRefs: string[],
  triggeredBy: string,
  ctxOpts: { orgId: string; connectionId: string },
): Promise<SyncResult> {
  const refs = [...new Set(sourceRefs.map(String))];
  if (refs.length === 0) {
    throw new Error("targeted repair requires at least one source reference");
  }
  if (refs.length > 500) {
    throw new Error("targeted repair is limited to 500 source references");
  }
  return runSync(source, triggeredBy, {
    kind: "targeted_repair",
    sourceRefs: refs,
    loadEntitiesFirst: false,
    ...ctxOpts,
  });
}

/** Effective posting subsidiary for a line that inherits from its document. */
export async function runSync(
  source: MigrationSource,
  triggeredBy: string,
  opts: SyncOptions,
): Promise<SyncResult> {
  const started = Date.now();
  const identity = validateSyncRunOptions(source, triggeredBy, opts);
  const { kind, targetedRefs, refKey, connectionId, org, postedChangeAuthorization } = identity;
  const supplemental: SyncSupplemental = {};
  const [run] = await claimSyncRun({
    orgId: org.id,
    connectionId,
    kind,
    sourceName: source.name,
    triggeredBy,
  });

  try {
    const { selection, since, outOfPeriodDatePolicy } = await prepareSyncConnection(
      source,
      identity,
      opts,
      supplemental,
    );
    const { entityStats, partyOutcome } = await loadSyncEntities({
      source,
      triggeredBy,
      connectionId,
      org,
      run: run!,
      since,
      targetedRefs,
      opts,
    });
    await reconcileSourceControlAccounts({ source, org, refKey, triggeredBy, run: run! });
    const { ctx, deps, changes } = await pullNativeChanges({
      source,
      org,
      run: run!,
      refKey,
      since,
      targetedRefs,
      supplemental,
    });
    const { existing, allDocumentRows } = await loadExistingSourceDocuments({
      org,
      refKey,
      changes,
    });
    const { docsNew, docsAmended, docsUnchanged, ordersNew, docsFailed, skipped, writeFailures } =
      await applySyncDocuments({
        source,
        triggeredBy,
        org,
        connectionId,
        refKey,
        kind,
        since,
        postedChangeAuthorization,
        outOfPeriodDatePolicy,
        run: run!,
        changes,
        ctx,
        deps,
        existing,
        allDocumentRows,
      });
    const { deletedAtSource, autoResolvedDeletions, convergedCancelledRefs } =
      await resolveSyncSourceDeletions({
        orgId: org.id,
        connectionId,
        sourceName: source.name,
        since,
        changes,
        existing,
        skipped,
      });
    // Transactions entered at the source while this run is in flight are
    // applied by a further pass when verification finds them missing.
    const catchUp: LateSourceCatchUp | undefined = targetedRefs
      ? undefined
      : async (lateSince) => {
          await setProgress(
            org.id,
            run!.id,
            { phase: "pull", message: "Applying source changes made during this run…" },
            true,
          );
          await loadSyncEntities({
            source,
            triggeredBy,
            connectionId,
            org,
            run: run!,
            since,
            targetedRefs,
            opts,
          });
          const late = await pullNativeChanges({
            source,
            org,
            run: run!,
            refKey,
            since: lateSince,
            targetedRefs: null,
            supplemental: {},
          });
          const lateChanges = late.changes;
          if (
            lateChanges.documents.length === 0 &&
            lateChanges.applications.length === 0 &&
            lateChanges.deletedRefs.length === 0 &&
            lateChanges.unbuildable.length === 0
          ) {
            return null;
          }
          const lateDocuments = await loadExistingSourceDocuments({
            org,
            refKey,
            changes: lateChanges,
          });
          const applied = await applySyncDocuments({
            source,
            triggeredBy,
            org,
            connectionId,
            refKey,
            kind,
            since: lateSince,
            postedChangeAuthorization,
            outOfPeriodDatePolicy,
            run: run!,
            changes: lateChanges,
            ctx: late.ctx,
            deps: late.deps,
            existing: lateDocuments.existing,
            allDocumentRows: lateDocuments.allDocumentRows,
          });
          const deletions = await resolveSyncSourceDeletions({
            orgId: org.id,
            connectionId,
            sourceName: source.name,
            since: lateSince,
            changes: lateChanges,
            existing: lateDocuments.existing,
            skipped: applied.skipped,
          });
          return {
            changes: lateChanges,
            ctx: late.ctx,
            existing: lateDocuments.existing,
            ...applied,
            ...deletions,
          };
        };
    return await reconcileAndCompleteSyncRun(
      {
        source,
        triggeredBy,
        org,
        connectionId,
        kind,
        targetedRefs,
        refKey,
        since,
        run: run!,
        started,
        selection,
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
      },
      catchUp,
    );
  } catch (e) {
    const verificationResult = e instanceof SyncVerificationError ? e.result : null;
    const failureMessage = (
      guardRefusalMessage(e, { includeRaisedCheckViolations: true }) ??
      (e instanceof Error ? e.message : String(e))
    ).slice(0, 2000);
    if (connectionId) {
      // Full-run failures mark connection health; bounded repairs only update last-run time.
      // Bound the message so verification details cannot bloat the connection record.
      if (!targetedRefs) {
        await db.execute(sql`
          update connections
             set last_run_at = now(), updated_at = now(), status = 'error', last_error = ${failureMessage}
           where id = ${connectionId} and org_id = ${org.id}`);
      } else {
        await db.execute(sql`
          update connections set last_run_at = now(), updated_at = now()
           where id = ${connectionId} and org_id = ${org.id}`);
      }
    }
    await db
      .update(schema.syncRuns)
      .set({
        status: "failed",
        finishedAt: new Date(),
        stats: { ...(verificationResult ?? {}), ...supplemental } as Record<string, unknown>,
        errorMessage: failureMessage,
      })
      .where(sql`${schema.syncRuns.id} = ${run!.id} and ${schema.syncRuns.orgId} = ${org.id}`);
    throw e;
  } finally {
    if (source.dispose) {
      try {
        await source.dispose();
      } catch (cleanupError) {
        console.error(`[sync:${source.name}] source cleanup failed:`, cleanupError);
      }
    }
  }
}
