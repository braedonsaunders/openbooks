import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { buildNativeContext, type NativeDocument } from "./native.ts";
import type { MigrationSource } from "./source.ts";
import { documentNumberScopeKey } from "../records/numbering.ts";
import type { SourceLedgerVerification } from "./sync-result.ts";
import {
  assertNoSiblingConnection,
  sourceDeletionCandidates,
  verifyCurrentLedgerState,
} from "./sync-verification-state.ts";
import {
  canonicalNativeDocumentKey,
  loadStoredKeys,
  resolveSourceDocumentNumber,
} from "./sync-document-identity.ts";

export interface FullSyncPreflight {
  source: string;
  orgId: string;
  connectionId: string | null;
  generatedAt: string;
  sourceDocuments: number;
  targetDocuments: number;
  newDocuments: number;
  amendedDocuments: number;
  unchangedDocuments: number;
  sourceUnbuildable: number;
  nonLedgerSourceRefs: number;
  duplicateSourceRefs: string[];
  acknowledgedSourceDeletions: string[];
  actionableSourceDeletions: string[];
  ledgerContext: {
    bookRef: string;
    bookKind: string;
  } | null;
  /** Current target state versus source, before any writes are authorized. */
  financialVerification: SourceLedgerVerification;
  samples: {
    newDocuments: string[];
    amendedDocuments: string[];
    unbuildable: Array<{ ref: string; reason: string }>;
  };
}

/** Builds a read-only full-sweep comparison before an operator authorizes writes. */
export async function preflightFullSync(
  source: MigrationSource,
  opts: { orgId: string; connectionId?: string },
): Promise<FullSyncPreflight> {
  const orgRows = await db.execute<{ id: string }>(
    sql`
    select id from orgs where id = ${opts.orgId}
  `,
    "objects",
  );
  if (!orgRows[0]) throw new Error(`organization ${opts.orgId} not found`);
  // A preflight that planned across two same-source connections would certify
  // a write the run then refuses: fail here with the same named refusal.
  if (opts.connectionId) {
    await assertNoSiblingConnection(opts.orgId, opts.connectionId, source.name);
  }

  const ctx = await buildNativeContext(opts.orgId, source.refKey, source.baseCurrency);
  const changes = await source.nativeChanges(null, ctx);
  const existingRows = await db.execute<{
    id: string;
    kind: string;
    status: string;
    document_number: string;
    party_id: string | null;
    ref: string | null;
  }>(
    sql`
    select id, kind, status, document_number, party_id, custom->>${source.refKey} as ref
      from documents
     where org_id = ${opts.orgId}
  `,
    "objects",
  );
  const existingByRef = new Map(
    existingRows
      .filter((row): row is typeof row & { ref: string } => row.ref !== null)
      .map((row) => [row.ref, row]),
  );
  const numberOwners = new Map(
    existingRows.map((row) => [
      documentNumberScopeKey(row.kind, row.party_id, row.document_number),
      row.id,
    ]),
  );
  const storedKeys = await loadStoredKeys(opts.orgId, source.refKey);

  const sourceRefCounts = new Map<string, number>();
  for (const document of changes.documents) {
    sourceRefCounts.set(document.sourceRef, (sourceRefCounts.get(document.sourceRef) ?? 0) + 1);
  }
  const duplicateSourceRefs = [...sourceRefCounts]
    .filter(([, count]) => count > 1)
    .map(([ref]) => ref)
    .sort();

  const newRefs: string[] = [];
  const amendedRefs: string[] = [];
  let unchangedDocuments = 0;
  for (const sourceDocument of changes.documents) {
    const document: NativeDocument = {
      ...sourceDocument,
      subsidiaryId: sourceDocument.subsidiaryId ?? ctx.rootSubsidiaryId,
      currency: sourceDocument.currency ?? source.baseCurrency,
    };
    const existing = existingByRef.get(document.sourceRef);
    const sourceDocumentNumber = resolveSourceDocumentNumber(
      document,
      source.name,
      existing?.id,
      numberOwners,
    );
    if (!existing) {
      newRefs.push(document.sourceRef);
      continue;
    }
    if (
      existing.document_number === sourceDocumentNumber &&
      canonicalNativeDocumentKey(document) === storedKeys.get(existing.id)
    ) {
      unchangedDocuments++;
    } else {
      amendedRefs.push(document.sourceRef);
    }
  }

  const currentSourceRefs = [
    ...(changes.sourcePresence ?? []).map((row) => row.ref),
    ...changes.documents.map((document) => document.sourceRef),
    ...changes.unbuildable.map((row) => row.ref),
    ...(changes.nonLedgerRefs ?? []),
  ];
  const deletionCandidates = sourceDeletionCandidates(
    true,
    existingRows
      .filter((row): row is typeof row & { ref: string } => row.ref !== null)
      .filter((row) => row.status !== "voided")
      .map((row) => row.ref),
    currentSourceRefs,
    changes.deletedRefs,
  );
  const acknowledgedRows =
    opts.connectionId && deletionCandidates.length > 0
      ? await db.execute<{ source_ref: string }>(
          sql`
          select source_ref
            from source_deletion_resolutions
           where org_id = ${opts.orgId}
             and connection_id = ${opts.connectionId}
             and source_ref in ${deletionCandidates}
        `,
          "objects",
        )
      : [];
  const acknowledged = new Set(acknowledgedRows.map((row) => row.source_ref));
  const [ledgerContext, financialVerification] = await Promise.all([
    source.ledgerContext ? source.ledgerContext() : Promise.resolve(null),
    verifyCurrentLedgerState(source, opts.orgId),
  ]);

  return {
    source: source.name,
    orgId: opts.orgId,
    connectionId: opts.connectionId ?? null,
    generatedAt: new Date().toISOString(),
    sourceDocuments: changes.documents.length,
    targetDocuments: existingByRef.size,
    newDocuments: newRefs.length,
    amendedDocuments: amendedRefs.length,
    unchangedDocuments,
    sourceUnbuildable: changes.unbuildable.length,
    nonLedgerSourceRefs: (changes.nonLedgerRefs ?? []).length,
    duplicateSourceRefs,
    acknowledgedSourceDeletions: deletionCandidates.filter((ref) => acknowledged.has(ref)).sort(),
    actionableSourceDeletions: deletionCandidates.filter((ref) => !acknowledged.has(ref)).sort(),
    ledgerContext,
    financialVerification,
    samples: {
      newDocuments: newRefs.slice(0, 50),
      amendedDocuments: amendedRefs.slice(0, 50),
      unbuildable: changes.unbuildable.slice(0, 50),
    },
  };
}
