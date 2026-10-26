import { sql } from "drizzle-orm";
import { db, schema, withOrg } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { regenerateGlImpactTx } from "../ledger/posting-replay.ts";
import { runPostDocumentEffects } from "../ledger/posting-dispatch.ts";
import type { PostingDeps } from "../journal/posting-contracts.ts";
import type { NativeChanges } from "./source.ts";
import type { NativeContext, NativeDocument } from "./native.ts";
import type { MigrationSource } from "./source.ts";
import {
  captureTransactionAuditSnapshot,
  recordTransactionAudit,
} from "../records/transaction-audit.ts";
import { documentNumberScopeKey } from "../records/numbering.ts";
import type { SyncOptions } from "./sync-result.ts";
import { syncErrorMessage } from "./sync-verification-state.ts";
import {
  canonicalNativeDocumentKey,
  requiresControlledPostingReversal,
  resolveSourceDocumentNumber,
  storedKey,
  loadStoredKeys,
} from "./sync-document-identity.ts";
import { setProgress } from "./sync-run-claiming.ts";
import {
  importedTaxEvidence,
  insertImportedLines,
  persistSyncFxRate,
  persistSyncLineMoney,
  preservedImportedLineCustom,
  refreshDocumentHeaderTotals,
} from "./sync-document-lines.ts";
import type { SyncTx } from "./sync-document-lines.ts";

export interface ExistingSourceDocument {
  id: string;
  kind: string;
  partyId: string | null;
  status: string;
  posted: boolean;
  documentNumber: string;
}

interface SourceDocumentRow {
  id: string;
  kind: string;
  party_id: string | null;
  status: string;
  document_number: string;
  posted: boolean;
  ref: string | null;
}

export async function applySyncDocuments(args: {
  source: MigrationSource;
  triggeredBy: string;
  org: { id: string };
  connectionId: string;
  refKey: string;
  kind: NonNullable<SyncOptions["kind"]>;
  since: Date | null;
  postedChangeAuthorization: SyncOptions["postedChangeAuthorization"];
  run: { id: string };
  changes: NativeChanges;
  ctx: NativeContext;
  deps: PostingDeps;
  existing: Map<string, ExistingSourceDocument>;
  allDocumentRows: SourceDocumentRow[];
}): Promise<{
  docsNew: number;
  docsAmended: number;
  docsUnchanged: number;
  ordersNew: number;
  docsFailed: number;
  skipped: string[];
  writeFailures: string[];
}> {
  const {
    source,
    triggeredBy,
    org,
    connectionId,
    refKey,
    kind,
    since,
    postedChangeAuthorization,
    run,
    changes,
    ctx,
    deps,
    existing,
    allDocumentRows,
  } = args;
  const numberOwners = new Map(
    allDocumentRows.map((r) => [
      documentNumberScopeKey(r.kind, r.party_id, r.document_number),
      r.id,
    ]),
  );
  // Move a document's number claim to the slot its row now occupies.
  const reassignNumber = (
    have: { id: string; kind: string; partyId: string | null; documentNumber: string },
    kind: string,
    partyId: string | null,
    documentNumber: string,
  ) => {
    const held = documentNumberScopeKey(have.kind, have.partyId, have.documentNumber);
    if (numberOwners.get(held) === have.id) numberOwners.delete(held);
    have.kind = kind;
    have.partyId = partyId;
    have.documentNumber = documentNumber;
    numberOwners.set(documentNumberScopeKey(kind, partyId, documentNumber), have.id);
  };
  const fullStoredKeys = since === null ? await loadStoredKeys(org.id, refKey) : null;

  let docsNew = 0,
    docsAmended = 0,
    docsUnchanged = 0,
    ordersNew = 0,
    docsFailed = 0;
  const skipped: string[] = [];
  const writeFailures: string[] = [];
  for (const u of changes.unbuildable) skipped.push(`${u.ref}: ${u.reason}`);

  const totalDocs = changes.documents.length;
  let docIndex = 0;
  // Repeated source refs have no deterministic winner; apply the first only.
  const appliedSourceRefs = new Set<string>();
  for (const sourceDoc of changes.documents) {
    docIndex++;
    if (appliedSourceRefs.has(sourceDoc.sourceRef)) {
      skipped.push(
        `${sourceDoc.sourceRef}: duplicate source transaction in this pull; only the first occurrence was applied`,
      );
      continue;
    }
    appliedSourceRefs.add(sourceDoc.sourceRef);
    await setProgress(org.id, run!.id, {
      phase: "post",
      message: "Posting transactions…",
      current: docIndex,
      total: totalDocs,
      docsNew,
      docsAmended,
      docsUnchanged,
      docsFailed,
      ordersNew,
      failureSamples: writeFailures,
    });
    const doc: NativeDocument = {
      ...sourceDoc,
      subsidiaryId: sourceDoc.subsidiaryId ?? ctx.rootSubsidiaryId,
      currency: sourceDoc.currency ?? source.baseCurrency,
    };
    try {
      const taxEvidence = await importedTaxEvidence(
        org.id,
        doc.documentDate,
        doc.lines,
        doc.sourceRef,
      );
      const have = existing.get(doc.sourceRef);
      const sourceDocumentNumber = resolveSourceDocumentNumber(
        doc,
        source.name,
        have?.id,
        numberOwners,
      );
      if (!have) {
        // ---- NEW: insert + post through the kernel -------------------------
        if (doc.posting && !doc.postingPeriodId) {
          docsFailed++;
          skipped.push(
            `${doc.sourceRef}: posting transaction has no exact source period reference`,
          );
          continue;
        }
        // The source document, lines, tax evidence, journal, and posted flip
        // are one accounting unit. `postDocument` reuses withOrg's pinned
        // transaction, so any posting failure rolls the source insert back.
        const docId = await withOrg(org.id, async () => {
          const [row] = await db
            .insert(schema.documents)
            .values({
              orgId: org.id,
              kind: doc.kind,
              documentNumber: sourceDocumentNumber,
              partyId: doc.partyId,
              subsidiaryId: doc.subsidiaryId,
              extraDims: doc.extraDims ?? {},
              documentDate: doc.documentDate,
              postingDate: doc.postingDate ?? doc.documentDate,
              postingPeriodId: doc.postingPeriodId ?? null,
              dueDate: doc.dueDate,
              currency: doc.currency ?? source.baseCurrency,
              fxRate: persistSyncFxRate(doc.fxRate ?? "1"),
              status: "draft",
              subtotal: persistSyncLineMoney(doc.subtotal ?? "0", "subtotal"),
              taxTotal: "0",
              total: persistSyncLineMoney(doc.total ?? "0", "total"),
              memo: doc.memo,
              referenceNumber: doc.referenceNumber,
              custom: {
                ...doc.mappedCustom,
                ...(Object.keys(doc.mappedCustom ?? {}).length
                  ? { connectorMappedValues: doc.mappedCustom }
                  : {}),
                ...(doc.controlAccountId
                  ? {
                      [refKey]: doc.sourceRef,
                      controlAccountId: doc.controlAccountId,
                      connectionId,
                    }
                  : { [refKey]: doc.sourceRef, connectionId }),
              },
            })
            .returning({ id: schema.documents.id });
          if (!row) throw new Error("The mapped source document was not saved");
          await insertImportedLines(
            db as unknown as SyncTx,
            org.id,
            row!.id,
            doc.lines,
            taxEvidence,
          );
          const lifecycleStatus = doc.posting ? "approved" : (doc.lifecycleStatus ?? "approved");
          await db.execute(sql`
              update documents
                 set status = ${lifecycleStatus}, updated_at = now()
               where id = ${row!.id} and org_id = ${org.id}
            `);
          if (doc.posting) {
            await postDocument(row!.id, deps, {
              deferEffects: true,
              suppressAutomation: true,
              // No user posts a mirror run: actor null, source system
              // explicit — the same envelope every other post leaves.
              audit: { actorId: null, source: source.name },
            });
            await refreshDocumentHeaderTotals(row!.id, org.id);
          }
          if (doc.mappingApplied) {
            const after = await captureTransactionAuditSnapshot(db, row.id, org.id);
            if (!after) throw new Error("The mapped source document is not readable after import");
            const audit = (
              await db.execute<{ id: string }>(
                sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
                values(${org.id},'documents',${row.id},'insert',${JSON.stringify({ event: "connector_entity_mapping_applied", connectionId, sourceRef: doc.sourceRef, before: null, after })}::jsonb,${isUuid(triggeredBy) ? triggeredBy : null}) returning id`,
                "objects",
              )
            )[0];
            if (!audit) throw new Error("The mapped source document audit was not saved");
          }
          return row.id;
        });
        if (doc.posting) {
          // Automation effects observe only a fully committed document.
          try {
            await runPostDocumentEffects(docId, "approved", {
              suppressAutomation: true,
            });
          } catch (effectError) {
            console.error(
              `[sync:${source.name}] post-commit effects failed for ${doc.sourceRef}:`,
              effectError,
            );
          }
          docsNew++;
        } else {
          ordersNew++;
        }
        existing.set(doc.sourceRef, {
          id: docId,
          kind: doc.kind,
          partyId: doc.partyId,
          status: doc.posting ? "posted" : (doc.lifecycleStatus ?? "approved"),
          posted: doc.posting,
          documentNumber: sourceDocumentNumber,
        });
        numberOwners.set(
          documentNumberScopeKey(doc.kind, doc.partyId, sourceDocumentNumber),
          docId,
        );
        continue;
      }

      // ---- EXISTS: heal orphan, then amend-if-changed ------------------------
      if (requiresControlledPostingReversal(doc.posting, have.posted)) {
        throw new Error(
          "source transitioned from posting to non-posting; a controlled reversal is required",
        );
      }
      if (doc.posting && !have.posted && have.status !== "voided") {
        // The rebuild keeps the stored kind and party, so the number
        // competes in the slot those place it in.
        const healedNumber = resolveSourceDocumentNumber(
          { ...doc, kind: have.kind },
          source.name,
          have.id,
          numberOwners,
          have.partyId,
        );
        await withOrg(org.id, async () => {
          // Line rebuilds require both governed flags inside one transaction.
          await db.transaction(async (tx) => {
            await tx.execute(sql`set local openbooks.amend = on`);
            await tx.execute(sql`set local openbooks.migration = on`);
            await tx.execute(sql`
                update documents
                   set document_number = ${healedNumber},
                       posting_date = ${doc.postingDate ?? doc.documentDate},
                       posting_period_id = ${doc.postingPeriodId ?? null},
                       status = 'approved',
                       memo = ${doc.memo}, reference_number = ${doc.referenceNumber}, due_date = ${doc.dueDate},
                       custom = (custom - 'connectorMappedValues') || ${JSON.stringify(Object.keys(doc.mappedCustom ?? {}).length ? { ...doc.mappedCustom, connectorMappedValues: doc.mappedCustom } : {})}::jsonb,
                       updated_at = now()
                 where id = ${have.id} and org_id = ${org.id}
              `);
            const preservedCustom = await preservedImportedLineCustom(tx, org.id, have.id);
            await tx.execute(
              sql`delete from document_lines where document_id = ${have.id} and org_id = ${org.id}`,
            );
            await insertImportedLines(tx, org.id, have.id, doc.lines, taxEvidence, preservedCustom);
          });
          await postDocument(have.id, deps, {
            deferEffects: true,
            suppressAutomation: true,
            // No user posts a mirror run: actor null, source system
            // explicit — the same envelope every other post leaves.
            audit: { actorId: null, source: source.name },
          });
          await refreshDocumentHeaderTotals(have.id, org.id);
        });
        try {
          await runPostDocumentEffects(have.id, have.status, {
            suppressAutomation: true,
          });
        } catch (effectError) {
          console.error(
            `[sync:${source.name}] post-commit effects failed for ${doc.sourceRef}:`,
            effectError,
          );
        }
        have.posted = true;
        have.status = "posted";
        reassignNumber(have, have.kind, have.partyId, healedNumber);
        docsNew++;
        continue;
      }
      const canonicalContentUnchanged =
        canonicalNativeDocumentKey(doc) ===
        (fullStoredKeys?.get(have.id) ?? (await storedKey(have.id, org.id)));
      if (canonicalContentUnchanged) {
        // A bounded repair also verifies the stored GL projection. Exact projections replay as a no-op.
        let projectionChanged = false;
        if (kind === "targeted_repair" && have.posted) {
          projectionChanged = await db.transaction(async (tx) => {
            await tx.execute(sql`set local openbooks.amend = on`);
            await tx.execute(sql`set local openbooks.migration = on`);
            const result = await regenerateGlImpactTx(tx, have.id, deps, triggeredBy, {
              actorId: triggeredBy,
              requestId: run!.id,
              reason: `Authorized ${source.name} stored-projection validation for transaction ${doc.sourceRef}`,
            });
            return result.changed;
          });
          if (projectionChanged) await refreshDocumentHeaderTotals(have.id, org.id);
        }
        if (have.documentNumber === sourceDocumentNumber) {
          if (projectionChanged) docsAmended++;
          else docsUnchanged++;
          continue;
        }
        await db.transaction(async (tx) => {
          await tx.execute(sql`set local openbooks.amend = on`);
          await tx.execute(sql`set local openbooks.migration = on`);
          const auditBefore = await captureTransactionAuditSnapshot(tx, have.id, org.id);
          if (!auditBefore) {
            throw new Error(`document ${have.id} disappeared during source-number reconciliation`);
          }
          const updated = await tx.execute(
            sql`
              update documents
                 set document_number = ${sourceDocumentNumber},
                     updated_at = now()
               where id = ${have.id}
                 and org_id = ${org.id}
                 and document_number = ${have.documentNumber}
              returning id
            `,
            "objects",
          );
          if (updated.length !== 1) {
            throw new Error(`document ${have.id} changed during source-number reconciliation`);
          }
          const auditAfter = await captureTransactionAuditSnapshot(tx, have.id, org.id);
          if (!auditAfter) {
            throw new Error(`document ${have.id} disappeared after source-number reconciliation`);
          }
          await recordTransactionAudit(tx, {
            orgId: org.id,
            documentId: have.id,
            action: "update",
            actorId: null,
            source: "mirror",
            reason: "source_transaction_number_changed",
            before: auditBefore,
            after: auditAfter,
          });
        });
        reassignNumber(have, doc.kind, doc.partyId, sourceDocumentNumber);
        docsAmended++;
        continue;
      }
      // AMEND: the document may accept non-financial source changes. Posted
      // GL is immutable: regenerateGlImpactTx proves the projection unchanged
      // or throws, rolling this entire transaction back.
      await db.transaction(async (tx) => {
        await tx.execute(sql`set local openbooks.amend = on`);
        await tx.execute(sql`set local openbooks.migration = on`);
        const auditCandidate = await captureTransactionAuditSnapshot(tx, have.id, org.id);
        const auditBefore =
          auditCandidate?.document.status === "posted" || doc.mappingApplied
            ? auditCandidate
            : null;
        await tx.execute(sql`
            update documents set
              kind = ${doc.kind}, party_id = ${doc.partyId}, subsidiary_id = ${doc.subsidiaryId},
              document_number = ${sourceDocumentNumber},
              document_date = ${doc.documentDate},
              posting_date = ${doc.postingDate ?? doc.documentDate},
              posting_period_id = ${doc.postingPeriodId ?? null}, due_date = ${doc.dueDate},
              currency = ${doc.currency ?? source.baseCurrency}, fx_rate = ${persistSyncFxRate(doc.fxRate ?? "1")},
              memo = ${doc.memo}, reference_number = ${doc.referenceNumber},
              status = case
                when posted_entry_id is not null then status
                else ${doc.lifecycleStatus ?? "approved"}
              end,
              extra_dims = ${JSON.stringify(doc.extraDims ?? {})}::jsonb,
              custom = (custom - 'connectorMappedValues' - 'controlAccountId')
                || ${JSON.stringify({ ...(Object.keys(doc.mappedCustom ?? {}).length ? { ...doc.mappedCustom, connectorMappedValues: doc.mappedCustom } : {}), ...(doc.controlAccountId ? { controlAccountId: doc.controlAccountId } : {}) })}::jsonb,
              updated_at = now()
            where id = ${have.id} and org_id = ${org.id}`);
        const preservedCustom = await preservedImportedLineCustom(tx, org.id, have.id);
        await tx.execute(
          sql`delete from document_lines where document_id = ${have.id} and org_id = ${org.id}`,
        );
        await insertImportedLines(tx, org.id, have.id, doc.lines, taxEvidence, preservedCustom);
        if (have.posted) {
          const automaticCorrection = postedChangeAuthorization
            ? {
                actorId: postedChangeAuthorization.actorId,
                requestId: run!.id,
                reason: `Controller-authorized ${source.name} append-only source correction for transaction ${doc.sourceRef}; policy authorized ${postedChangeAuthorization.authorizedAt.toISOString()}`,
                replayMode: "authenticated_connector_historical_replay" as const,
              }
            : undefined;
          await regenerateGlImpactTx(
            tx,
            have.id,
            deps,
            triggeredBy,
            kind === "targeted_repair"
              ? {
                  actorId: triggeredBy,
                  requestId: run!.id,
                  reason: `Authorized ${source.name} source-exact correction for transaction ${doc.sourceRef}`,
                }
              : automaticCorrection,
          );
        }
        // The open-balance trigger fires only on posted_entry_id/status
        // changes. Recompute after an accepted non-financial amendment;
        // financial projection changes have already failed and rolled back.
        if (have.posted) await tx.execute(sql`select recompute_document_open_balance(${have.id})`);
        if (auditBefore) {
          const auditAfter = await captureTransactionAuditSnapshot(tx, have.id, org.id);
          if (!auditAfter)
            throw new Error(`document ${have.id} disappeared during mirror amendment`);
          await recordTransactionAudit(tx, {
            orgId: org.id,
            documentId: have.id,
            action: "update",
            actorId:
              postedChangeAuthorization?.actorId ??
              (doc.mappingApplied && isUuid(triggeredBy) ? triggeredBy : null),
            source: "mirror",
            reason: "source_transaction_changed",
            before: auditBefore,
            after: auditAfter,
          });
        }
      });
      if (have.posted) await refreshDocumentHeaderTotals(have.id, org.id);
      reassignNumber(have, doc.kind, doc.partyId, sourceDocumentNumber);
      docsAmended++;
    } catch (e) {
      docsFailed++;
      const failure = `${doc.sourceRef}: ${syncErrorMessage(e)}`;
      skipped.push(failure);
      if (writeFailures.length < 20) writeFailures.push(failure);
      await setProgress(
        org.id,
        run!.id,
        {
          phase: "post",
          message: "Posting transactions…",
          current: docIndex,
          total: totalDocs,
          docsNew,
          docsAmended,
          docsUnchanged,
          docsFailed,
          ordersNew,
          failureSamples: writeFailures,
        },
        true,
      );
    }
  }

  return { docsNew, docsAmended, docsUnchanged, ordersNew, docsFailed, skipped, writeFailures };
}
