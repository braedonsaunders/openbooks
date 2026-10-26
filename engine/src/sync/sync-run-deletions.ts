import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { mirrorSourceDeletion } from "./source-deletions.ts";
import type { NativeChanges } from "./source.ts";
import {
  sourceDeletionCandidates,
  unresolvedSourceDeletionCandidates,
} from "./sync-verification-state.ts";

/** Resolve deleted source documents through their governed reversal lifecycle. */
export async function resolveSyncSourceDeletions(args: {
  orgId: string;
  connectionId: string;
  sourceName: string;
  since: Date | null;
  changes: NativeChanges;
  existing: ReadonlyMap<
    string,
    { id: string; documentNumber: string; status: string; posted: boolean }
  >;
  skipped: string[];
}): Promise<{
  deletedAtSource: Set<string>;
  autoResolvedDeletions: string[];
  convergedCancelledRefs: Set<string>;
}> {
  const { orgId, connectionId, sourceName, since, changes, existing, skipped } = args;
  const org = { id: orgId };
  const source = { name: sourceName };
  // Mirror source deletions through original-period reversals, preserving settlement evidence and audit history.
  // Full sweeps identify missing refs; voided documents already match the source's financial state.
  const nonVoidedExistingRefs = [...existing]
    .filter(([, have]) => have.status !== "voided")
    .map(([ref]) => ref);
  const deletedAtSource = new Set(
    sourceDeletionCandidates(
      since === null,
      nonVoidedExistingRefs,
      [
        ...(changes.sourcePresence ?? []).map((row) => row.ref),
        ...changes.documents.map((doc) => doc.sourceRef),
        ...changes.unbuildable.map((row) => row.ref),
        ...(changes.nonLedgerRefs ?? []),
      ],
      changes.deletedRefs,
    ),
  );
  // Mirror cancelled transactions like deletions unless they are already voided.
  for (const u of changes.unbuildable) {
    const have = existing.get(u.ref);
    if (u.reason === "cancelled" && have?.posted && have.status !== "voided")
      deletedAtSource.add(u.ref);
  }
  // Unresolved cancellations fail verification only while live local state remains.
  // Mirrored, dispositioned, absent, and voided references are converged.
  const cancelledRefs = new Set(
    changes.unbuildable.filter((row) => row.reason === "cancelled").map((row) => row.ref),
  );
  const mirroredCancelledRefs = new Set<string>();
  const dispositionedRefs = new Set<string>();
  const autoResolvedDeletions: string[] = [];
  if (deletedAtSource.size > 0) {
    // Recorded controller dispositions (retain / manual void) are
    // acknowledged divergences: they stand and are never auto-mirrored.
    const resolvedRows = connectionId
      ? await db.execute<{ source_ref: string }>(
          sql`
            select source_ref from source_deletion_resolutions
             where org_id = ${org.id} and connection_id = ${connectionId}
               and source_ref in ${[...deletedAtSource]}`,
          "objects",
        )
      : [];
    for (const row of resolvedRows) dispositionedRefs.add(row.source_ref);
    for (const ref of unresolvedSourceDeletionCandidates(
      deletedAtSource,
      resolvedRows.map((row) => row.source_ref),
    )) {
      try {
        const mirrored = await mirrorSourceDeletion({
          orgId: org.id,
          source: source.name,
          sourceRef: ref,
          connectionId,
        });
        if (mirrored.documentId !== existing.get(ref)?.id) {
          throw new Error(
            `source deletion ${ref} did not correct local document ${existing.get(ref)?.documentNumber}: connector ownership could not be verified; check the document's source and connector configuration before retrying`,
          );
        }
        autoResolvedDeletions.push(ref);
        if (cancelledRefs.has(ref)) mirroredCancelledRefs.add(ref);
        deletedAtSource.delete(ref);
      } catch (deletionError) {
        skipped.push(
          `${ref}: source deletion could not be mirrored: ${(deletionError as Error).message.slice(0, 200)}`,
        );
      }
    }
    for (const row of resolvedRows) deletedAtSource.delete(row.source_ref);
  }
  const convergedCancelledRefs = new Set<string>();
  for (const ref of cancelledRefs) {
    if (deletedAtSource.has(ref)) continue;
    const have = existing.get(ref);
    if (
      mirroredCancelledRefs.has(ref) ||
      dispositionedRefs.has(ref) ||
      !have ||
      have.status === "voided"
    ) {
      convergedCancelledRefs.add(ref);
    }
  }

  return { deletedAtSource, autoResolvedDeletions, convergedCancelledRefs };
}
