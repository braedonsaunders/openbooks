/**
 * What a posted-document correction may touch, and what each touch costs.
 *
 * A posted document is immutable history: changing it means either a
 * metadata-only touch-up that alters no ledger amount or dimension, a
 * balanced reclassification that moves posted amounts between dimensions,
 * or a full void-and-reissue. This list is the single authority all three
 * paths (and the UI consequence preview) read — a second copy anywhere
 * would let the preview promise what the command refuses.
 *
 * Header fields fall in three classes:
 *
 * - `metadata`: purely descriptive text the posting kernel never reads
 *   (memo, reference and PO numbers, internal notes, the informational work
 *   date, tenant custom keys carrying a field definition). Safe to correct
 *   in place, even in a locked period, with before/after audit.
 * - `dimension`: first-class ledger dimensions (department, project,
 *   location, class). Whether the change is metadata or a reclass depends
 *   on the posted lines: when no posted leg carries the dimension the link
 *   is header-only and corrects in place; when legs carry it the amounts
 *   move through a balanced reclass entry (open period) or refuse (locked).
 * - `financial`: everything else (party, currency, dates that place the
 *   document, subsidiary, lines in any form, tax, and custom keys without
 *   a field definition, which may feed posting). Always void-and-reissue,
 *   refused outright when the original's period is locked.
 *
 * Anything unlisted here is `financial` by default: an unknown field must
 * take the heaviest path, never slip through as metadata.
 */

export type PostedCorrectionFieldClass = "metadata" | "dimension" | "financial";

export type PostedCorrectionOutcome =
  | "metadata-correction"
  | "reclass"
  | "void-and-reissue"
  | "refused-closed-period";

/** Header fields that never reach the posting kernel (see module comment). */
export const POSTED_METADATA_FIELDS: ReadonlySet<string> = new Set([
  "memo",
  "referenceNumber",
  "internalNotes",
  "workCompletedOn",
]);

/** Header fields naming first-class ledger dimensions. */
export const POSTED_DIMENSION_FIELDS: ReadonlySet<string> = new Set([
  "departmentId",
  "projectId",
  "locationId",
  "classId",
]);

/** Custom keys reserved by posting, flows, and conversion evidence. Tenant
 * field definitions never mint these; a change touching one is financial. */
export const POSTING_SYSTEM_CUSTOM_KEYS: ReadonlySet<string> = new Set([
  "taxProviderAddresses",
  "taxItemCode",
  "canadianGoodsTax",
  "storeCreditProgramId",
  "withholdingAmount",
  "withholdings",
  "withholdingDeposit",
  "withholdingRemittance",
  "conversionShortfall",
  "correctionOf",
  "correctionReason",
  "controlAccountId",
]);

export function postedCorrectionFieldClass(
  field: string,
  customDefKeys?: ReadonlySet<string>,
): PostedCorrectionFieldClass {
  if (POSTED_METADATA_FIELDS.has(field)) return "metadata";
  if (POSTED_DIMENSION_FIELDS.has(field)) return "dimension";
  if (field === "custom") return "financial";
  if (field.startsWith("custom.")) {
    const key = field.slice("custom.".length);
    if (POSTING_SYSTEM_CUSTOM_KEYS.has(key)) return "financial";
    if (customDefKeys !== undefined) return customDefKeys.has(key) ? "metadata" : "financial";
    return "financial";
  }
  return "financial";
}
