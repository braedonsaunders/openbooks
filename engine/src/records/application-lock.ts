import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * Lock the source documents and open-item endpoints that an application
 * mutation or reversal shares. The global order is source documents by id,
 * then journal lines by id. Application writers and reversal paths must use
 * this in their transaction before inspecting application state; holding the
 * transaction through the write makes the open-item decision stable.
 *
 * `lineIds` are resolved before locking only to discover their owning source
 * documents. The locked result is checked against that discovery, so a caller
 * cannot accidentally carry stale endpoint identity into its mutation.
 */
export async function lockApplicationEvidence(
  tx: SqlExecutor,
  orgId: string,
  lineIds: readonly string[],
  additionalDocumentIds: readonly string[] = [],
): Promise<{ documentIds: readonly string[]; lineIds: readonly string[] }> {
  const requestedLines = [...new Set(lineIds)].sort();
  const requestedDocuments = new Set(additionalDocumentIds);
  const endpointEntryIds = new Map<string, string>();
  if (requestedLines.length > 0) {
    const owners = await tx.execute<{ lineId: string; entryId: string; documentId: string | null }>(sql`
      select line.id as "lineId", line.entry_id as "entryId", entry.source_document_id as "documentId"
        from journal_lines line
        join journal_entries entry on entry.id = line.entry_id and entry.org_id = line.org_id
       where line.org_id = ${orgId} and line.id in ${requestedLines}
    `);
    if (owners.rows.length !== requestedLines.length) {
      throw new Error("application endpoints changed or disappeared; retry the operation");
    }
    for (const owner of owners.rows) {
      endpointEntryIds.set(owner.lineId, owner.entryId);
      if (owner.documentId) requestedDocuments.add(owner.documentId);
    }
  }

  const documentIds = [...requestedDocuments].sort();
  if (documentIds.length > 0) {
    const lockedDocuments = await tx.execute<{ id: string }>(sql`
      select id
        from documents
       where org_id = ${orgId} and id in ${documentIds}
       order by id
       for update
    `);
    if (lockedDocuments.rows.length !== documentIds.length) {
      throw new Error("an application source document changed or disappeared; retry the operation");
    }
  }

  if (requestedLines.length > 0) {
    const lockedLines = await tx.execute<{ id: string; entryId: string }>(sql`
      select id, entry_id as "entryId"
        from journal_lines
       where org_id = ${orgId} and id in ${requestedLines}
       order by id
       for update
    `);
    if (lockedLines.rows.length !== requestedLines.length || lockedLines.rows.some((line) => endpointEntryIds.get(line.id) !== line.entryId)) {
      throw new Error("application endpoints changed or disappeared; retry the operation");
    }
  }

  return { documentIds, lineIds: requestedLines };
}
