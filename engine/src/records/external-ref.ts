import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "@openbooks/engine/platform/database";

export type ExternalRefPair =
  | { action: "leave" }
  | { action: "set"; ref: string; source: string }
  | { action: "clear" }
  | { action: "refuse"; message: string };

/**
 * One rule for the external (source, ref) pair, shared by the document and
 * order writers so the two surfaces can never disagree. Absent leaves the
 * stored pair untouched; an explicit null with no valued half clears both;
 * a value on one side requires a value on the other, and neither half may
 * be blank. A valued half is never silently dropped: pairing a value with a
 * null is refused, not coerced into a clear.
 */
export function resolveExternalRefPair(input: {
  externalRef?: unknown;
  externalSource?: unknown;
}): ExternalRefPair {
  const { externalRef, externalSource } = input;
  if (externalRef === undefined && externalSource === undefined) return { action: "leave" };
  // A defined non-string is mistyped, not missing: refuse it before the
  // missing-partner branch can misreport it as absent.
  if (externalRef !== undefined && externalRef !== null && typeof externalRef !== "string") {
    return {
      action: "refuse",
      message:
        "externalRef must be a string — send the external system's id for this document as text or omit both externalRef and externalSource",
    };
  }
  if (externalSource !== undefined && externalSource !== null && typeof externalSource !== "string") {
    return {
      action: "refuse",
      message:
        "externalSource must be a string — send the name of the external system as text or omit both externalRef and externalSource",
    };
  }
  const refText = typeof externalRef === "string" ? externalRef.trim() : null;
  const srcText = typeof externalSource === "string" ? externalSource.trim() : null;
  if (refText !== null && refText === "") {
    return {
      action: "refuse",
      message:
        "externalRef must not be blank — send the external system's id for this document or omit both externalRef and externalSource",
    };
  }
  if (srcText !== null && srcText === "") {
    return {
      action: "refuse",
      message:
        "externalSource must not be blank — send the name of the external system or omit both externalRef and externalSource",
    };
  }
  if (refText !== null && srcText !== null) return { action: "set", ref: refText, source: srcText };
  if (refText !== null || srcText !== null) {
    const missing = refText !== null ? "externalSource" : "externalRef";
    return {
      action: "refuse",
      message: `externalRef and externalSource travel together — send the missing ${missing} (the ${missing === "externalSource" ? "name of the external system" : "external system's id for this document"}) or omit both`,
    };
  }
  // No valued half, but at least one side was sent: an explicit null clears
  // both columns, because storage refuses a half-filled pair and clearing
  // one side must clear the other.
  return { action: "clear" };
}

/** The stored document already carrying this external identity, if any. */
export async function findDocumentByExternalRef(
  runner: SqlExecutor,
  orgId: string,
  ref: string,
  source: string,
  excludeId?: string,
): Promise<{ id: string; documentNumber: string } | null> {
  const rows = (await runner.execute<{ id: string; document_number: string }>(sql`
    select id, document_number from documents
     where org_id = ${orgId} and external_source = ${source} and external_ref = ${ref}
       ${excludeId ? sql`and id <> ${excludeId}` : sql<SQL>``}
     limit 1`)).rows;
  const row = rows[0];
  return row ? { id: row.id, documentNumber: row.document_number } : null;
}

/** Walk the driver error chain (drizzle nests it under .cause). */
function errorChain(error: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let cursor: unknown = error;
  for (let depth = 0; depth < 4 && cursor !== null && typeof cursor === "object"; depth++) {
    out.push(cursor as Record<string, unknown>);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return out;
}

/**
 * True when the write lost a race on the external dedupe index: the
 * pre-write lookup passed, then a concurrent write claimed the pair. The
 * caller re-reads the winner and answers 409 naming it.
 */
export function isExternalRefConflict(error: unknown): boolean {
  return errorChain(error).some(
    (node) => node.code === "23505" && node.constraint === "documents_org_external_ref",
  );
}

/** True when storage refused a half-filled or blank external pair (23514). */
export function isExternalRefCheckViolation(error: unknown): boolean {
  return errorChain(error).some(
    (node) =>
      node.code === "23514" &&
      (node.constraint === "documents_external_ref_source_pair" ||
        node.constraint === "documents_external_ref_nonblank" ||
        node.constraint === "documents_external_source_nonblank"),
  );
}
