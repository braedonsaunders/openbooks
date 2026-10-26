import "server-only";
import { db } from "@openbooks/engine/platform/db";
import {
  findPossibleDuplicateDocuments,
  type DuplicateProbeKind,
  type PossibleDuplicate,
} from "@openbooks/engine/records/document-reference";

export type { DuplicateProbeKind, PossibleDuplicate };

/**
 * Possible duplicates of a document about to be saved, inside the caller's
 * subsidiary scope: vendor bills and credits by the same vendor and
 * normalised invoice number whatever their date or amount; customer invoices
 * by the same customer, document date and total. Voided documents never
 * match. See engine/src/records/document-reference.ts for the matching rule.
 */
export async function findPossibleDuplicates(input: {
  orgId: string;
  kind: DuplicateProbeKind;
  partyId: string;
  documentDate?: string | null;
  total?: string | null;
  reference?: string | null;
  excludeId?: string | null;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}): Promise<PossibleDuplicate[]> {
  return findPossibleDuplicateDocuments(db, input.orgId, {
    kind: input.kind,
    partyId: input.partyId,
    referenceNumber: input.reference,
    documentDate: input.documentDate,
    total: input.total,
    excludeId: input.excludeId,
    allowedSubsidiaryIds: input.allowedSubsidiaryIds,
  });
}
