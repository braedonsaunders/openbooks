import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";

/**
 * Vendor invoice numbers as a duplicate key.
 *
 * Vendors print the same invoice number inconsistently ("INV-0042",
 * "inv 0042", "#INV0042"), so two references are the same invoice when they
 * agree after lower-casing and dropping everything but letters and digits.
 * A reference with nothing left after that normalisation identifies nothing
 * and never matches another document.
 *
 * Stored rows are compared in SQL with `normalizedDocumentReferenceSql`, on
 * both sides of the comparison, so manual entry, imports and AP capture all
 * share one definition. `normalizeDocumentReference` is its in-process twin,
 * used to decide whether a probe has anything to compare at all.
 */
export { normalizeDocumentReference } from "./document-reference-normalize.ts";
import { normalizeDocumentReference } from "./document-reference-normalize.ts";

/** SQL twin of `normalizeDocumentReference`; null when nothing identifying remains. */
export function normalizedDocumentReferenceSql(expression: SQL): SQL {
  return sql`nullif(regexp_replace(lower(${expression}), '[^[:alnum:]]', '', 'g'), '')`;
}

/** Kinds whose duplicate key is the party's own reference (the vendor invoice number). */
export const REFERENCE_DUPLICATE_KINDS = ["vendor_bill", "vendor_credit"] as const;
/** Kinds whose duplicate key is the party, document date and total. */
export const PARTY_DATE_TOTAL_DUPLICATE_KINDS = ["customer_invoice"] as const;

export type DuplicateProbeKind =
  (typeof REFERENCE_DUPLICATE_KINDS)[number] | (typeof PARTY_DATE_TOTAL_DUPLICATE_KINDS)[number];

export type DuplicateReason = "reference" | "party_date_total";

export interface PossibleDuplicate {
  id: string;
  documentNumber: string;
  documentDate: string;
  total: string;
  status: string;
  referenceNumber: string | null;
  reason: DuplicateReason;
}

export function isReferenceDuplicateKind(
  kind: string,
): kind is (typeof REFERENCE_DUPLICATE_KINDS)[number] {
  return (REFERENCE_DUPLICATE_KINDS as readonly string[]).includes(kind);
}

/**
 * Possible duplicates of a document being entered, for a warning before save
 * (never a refusal: the operator may confirm and save another).
 *
 * - Vendor bills and credits match the same party and the same normalised
 *   reference, whatever their date or amount: a re-keyed invoice with a typo
 *   in the amount is still the same invoice, and paying it twice is the risk
 *   the warning exists for. A blank reference matches nothing.
 * - Customer invoices match the same party, document date and exact total.
 *
 * Voided documents never match, `excludeId` drops the document being edited,
 * and matches stay inside the caller's subsidiary scope (null is the explicit
 * unrestricted sentinel). At most five matches, most recent first.
 */
export async function findPossibleDuplicateDocuments(
  exec: SqlExecutor,
  orgId: string,
  input: {
    kind: DuplicateProbeKind;
    partyId: string;
    referenceNumber?: string | null;
    documentDate?: string | null;
    total?: string | null;
    excludeId?: string | null;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
  },
): Promise<PossibleDuplicate[]> {
  let reason: DuplicateReason;
  let match: SQL;
  if (isReferenceDuplicateKind(input.kind)) {
    if (normalizeDocumentReference(input.referenceNumber) === null) return [];
    reason = "reference";
    match = sql`and ${normalizedDocumentReferenceSql(sql`d.reference_number`)}
                  = ${normalizedDocumentReferenceSql(sql`${input.referenceNumber}::text`)}`;
  } else {
    if (!input.documentDate || !input.total) return [];
    reason = "party_date_total";
    match = sql`and d.document_date = ${input.documentDate}::date and d.total = ${input.total}::numeric`;
  }
  const rows = await exec.execute<Omit<PossibleDuplicate, "reason">>(
    sql`
    select d.id, d.document_number as "documentNumber", d.document_date::text as "documentDate",
           d.total::text as total, d.status, d.reference_number as "referenceNumber"
      from documents d
     where d.org_id = ${orgId} and d.kind = ${input.kind}
       and d.party_id = ${input.partyId}
       and d.status <> 'voided'
       ${match}
       ${input.excludeId ? sql`and d.id <> ${input.excludeId}::uuid` : sql``}
       ${subsidiaryVisibleFilter(sql`d.subsidiary_id`, input.allowedSubsidiaryIds)}
     order by d.document_date desc, d.created_at desc, d.id
     limit 5`,
    "objects",
  );
  return rows.map((row) => ({ ...row, reason }));
}
