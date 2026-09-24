import { sql, type SQL } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";

export type ApplicationLockQuery = (statement: SQL) => Promise<{ rows: Record<string, unknown>[] }>;

/**
 * Lock the source documents and open-item endpoints that an application
 * mutation or reversal shares. The global order is source documents by id,
 * journal entries by id, then journal lines by id. Application writers and
 * reversal paths must use this in their transaction before inspecting
 * application state; holding the transaction through the write makes the
 * open-item decision stable.
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
  additionalEntryIds: readonly string[] = [],
  options: { nowait?: boolean } = {},
): Promise<{ documentIds: readonly string[]; entryIds: readonly string[]; lineIds: readonly string[] }> {
  return lockApplicationEvidenceWithQuery(
    async (statement: SQL) => {
      const result = await tx.execute<Record<string, unknown>>(statement);
      return { rows: result.rows as Record<string, unknown>[] };
    },
    orgId,
    lineIds,
    additionalDocumentIds,
    additionalEntryIds,
    options,
  );
}

export async function lockApplicationEvidenceWithQuery(
  execute: ApplicationLockQuery,
  orgId: string,
  lineIds: readonly string[],
  additionalDocumentIds: readonly string[] = [],
  additionalEntryIds: readonly string[] = [],
  options: { nowait?: boolean } = {},
): Promise<{ documentIds: readonly string[]; entryIds: readonly string[]; lineIds: readonly string[] }> {
  const lockClause = options.nowait ? sql`for update nowait` : sql`for update`;
  const requestedLines = [...new Set(lineIds)].sort();
  const requestedDocuments = new Set(additionalDocumentIds);
  const requestedEntries = new Set(additionalEntryIds);
  const endpointEntryIds = new Map<string, string>();
  if (requestedLines.length > 0) {
    const owners = (await execute(sql`
      select line.id as "lineId", line.entry_id as "entryId", entry.source_document_id as "documentId"
        from journal_lines line
        join journal_entries entry on entry.id = line.entry_id and entry.org_id = line.org_id
       where line.org_id = ${orgId} and line.id in ${requestedLines}
    `)).rows as { lineId: string; entryId: string; documentId: string | null }[];
    if (owners.length !== requestedLines.length) {
      throw new Error("application endpoints changed or disappeared; retry the operation");
    }
    for (const owner of owners) {
      endpointEntryIds.set(owner.lineId, owner.entryId);
      requestedEntries.add(owner.entryId);
      if (owner.documentId) requestedDocuments.add(owner.documentId);
    }
  }

  const documentIds = [...requestedDocuments].sort();
  if (documentIds.length > 0) {
    const lockedDocuments = (await execute(sql`
      select id
        from documents
       where org_id = ${orgId} and id in ${documentIds}
       order by id
       ${lockClause}
    `)).rows;
    if (lockedDocuments.length !== documentIds.length) {
      throw new Error("an application source document changed or disappeared; retry the operation");
    }
  }

  const entryIds = [...requestedEntries].sort();
  if (entryIds.length > 0) {
    const lockedEntries = (await execute(sql`
      select id
        from journal_entries
       where org_id = ${orgId} and id in ${entryIds}
       order by id
       ${lockClause}
    `)).rows;
    if (lockedEntries.length !== entryIds.length) {
      throw new Error("an application journal entry changed or disappeared; retry the operation");
    }
  }

  if (requestedLines.length > 0) {
    const lockedLines = (await execute(sql`
      select id, entry_id as "entryId"
        from journal_lines
       where org_id = ${orgId} and id in ${requestedLines}
       order by id
       ${lockClause}
    `)).rows as { id: string; entryId: string }[];
    if (lockedLines.length !== requestedLines.length || lockedLines.some((line) => endpointEntryIds.get(line.id) !== line.entryId)) {
      throw new Error("application endpoints changed or disappeared; retry the operation");
    }
  }

  return { documentIds, entryIds, lineIds: requestedLines };
}
