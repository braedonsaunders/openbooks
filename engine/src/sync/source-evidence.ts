import { sql } from "drizzle-orm";
import {
  applySourceLineEvidence,
  refreshSourceReconciliationState,
  signOffFromSourceEvidence,
  type SourceClearedEntryEvidence,
} from "../banking.ts";
import { db } from "../db.ts";
import type { NativeDocument } from "./native.ts";
import type { MigrationSource, SourceClearedLineState } from "./source.ts";

/**
 * The mirror's source-reconciliation-evidence phase (0158). Pulled native
 * documents carry cleared markers; connectors whose source tracks clearing
 * outside the transaction modification clock additionally expose a refresh
 * pull. This phase merges both (refresh wins), stamps the posted lines,
 * refreshes per-account state, and signs fully covered accounts off —
 * partially covered accounts stay open and reported. It never invents
 * statement lines and never amends documents: a clear-flip is evidence, not
 * content (see NativeDocLine).
 */

export interface SourceEvidenceOutcome {
  documents: number;
  entriesStamped: number;
  linesStamped: number;
  /** Refresh states that resolved onto a mirrored line. */
  refreshedLines: number;
  /** Refresh states naming no mirrored line (source-side orphans). */
  unmatchedRefreshLines: number;
  signedOff: { accountId: string; reconciliationId: string; throughDate: string }[];
  skipped: {
    accountId: string;
    throughDate: string | null;
    clearedLines: number;
    unclearedLines: number;
    reason: string;
  }[];
}

/** Earliest open GL window for the refresh pull; null skips the refresh. */
export async function evidenceWindowStart(orgId: string): Promise<string | null> {
  const row = (await db.execute<{ start: string | null }>(sql`
    select min(p.starts_on)::text as start
      from accounting_periods p
     where p.org_id = ${orgId} and not p.is_adjustment
       and not exists (
         select 1 from period_locks l
          where l.org_id = p.org_id and l.period_id = p.id
            and l.module = 'gl' and l.state = 'closed'
       )
  `)).rows[0];
  return row?.start ?? null;
}

export async function resolveDocEntries(
  orgId: string,
  refKey: string,
  sourceRefs: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (sourceRefs.length === 0) return out;
  const rows = (await db.execute<{ source_ref: string; entry_id: string }>(sql`
    select d.custom->>${refKey} as source_ref, d.posted_entry_id as entry_id
      from documents d
     where d.org_id = ${orgId} and d.posted_entry_id is not null
       and d.custom->>${refKey} = any(${sql.param(sourceRefs)}::text[])
  `)).rows;
  for (const row of rows) out.set(row.source_ref, row.entry_id);
  return out;
}

export async function resolveRefreshLines(
  orgId: string,
  refKey: string,
  states: SourceClearedLineState[],
): Promise<Map<string, { entryId: string; accountId: string }>> {
  const out = new Map<string, { entryId: string; accountId: string }>();
  if (states.length === 0) return out;
  const docRefs = [...new Set(states.map((s) => s.docRef))];
  const lineRefs = [...new Set(states.map((s) => s.lineRef))];
  const rows = (await db.execute<{ doc_ref: string; line_ref: string; accountId: string; entry_id: string }>(sql`
    select d.custom->>${refKey} as doc_ref,
           dl.custom->>'sourceLineRef' as line_ref,
           dl.account_id as "accountId",
           d.posted_entry_id as entry_id
      from document_lines dl
      join documents d on d.id = dl.document_id and d.org_id = dl.org_id
     where dl.org_id = ${orgId} and d.posted_entry_id is not null
       and d.custom->>${refKey} = any(${sql.param(docRefs)}::text[])
       and dl.custom->>'sourceLineRef' = any(${sql.param(lineRefs)}::text[])
  `)).rows;
  for (const row of rows) out.set(`${row.doc_ref}|${row.line_ref}`, { entryId: row.entry_id, accountId: row.accountId });
  return out;
}

export async function applySourceReconciliationEvidence(opts: {
  orgId: string;
  connector: string;
  actorId: string;
  refKey: string;
  source: MigrationSource;
  documents: NativeDocument[];
  /** Pinned refresh window (tests); otherwise derived from open periods. */
  refreshSinceForTest?: string;
}): Promise<SourceEvidenceOutcome> {
  const { orgId, connector, actorId, refKey, source, documents } = opts;
  const outcome: SourceEvidenceOutcome = {
    documents: documents.length,
    entriesStamped: 0,
    linesStamped: 0,
    refreshedLines: 0,
    unmatchedRefreshLines: 0,
    signedOff: [],
    skipped: [],
  };
  const entries = await resolveDocEntries(
    orgId,
    refKey,
    documents.map((d) => d.sourceRef),
  );
  // In-pull evidence, keyed per line; the refresh below overrides per line.
  const byEntry = new Map<string, Map<string, { accountId: string; cleared: boolean; clearedDate: string | null }>>();
  const put = (entryId: string, key: string, line: { accountId: string; cleared: boolean; clearedDate: string | null }) => {
    const group = byEntry.get(entryId) ?? new Map();
    group.set(key, line);
    byEntry.set(entryId, group);
  };
  documents.forEach((doc, docIndex) => {
    const entryId = entries.get(doc.sourceRef);
    if (!entryId) return;
    doc.lines.forEach((line, lineIndex) => {
      // Unresolved-account lines carry no attributable evidence; the write
      // loop reports them through its own unbuildable path.
      if (!line.accountId) return;
      put(entryId, `${doc.sourceRef}|${line.sourceLineRef ?? `#${docIndex}:${lineIndex}`}`, {
        accountId: line.accountId,
        cleared: line.sourceCleared === true,
        clearedDate: line.sourceClearedDate ?? null,
      });
    });
  });

  const refreshSince = opts.refreshSinceForTest ?? (await evidenceWindowStart(orgId));
  if (source.clearedLineStates && refreshSince) {
    const states = await source.clearedLineStates({ sincePostingDate: refreshSince });
    const resolved = await resolveRefreshLines(orgId, refKey, states);
    for (const state of states) {
      const hit = resolved.get(`${state.docRef}|${state.lineRef}`);
      if (!hit) {
        outcome.unmatchedRefreshLines += 1;
        continue;
      }
      put(hit.entryId, `${state.docRef}|${state.lineRef}`, {
        accountId: hit.accountId,
        cleared: state.cleared,
        clearedDate: state.clearedDate,
      });
      outcome.refreshedLines += 1;
    }
  }

  const stamped: SourceClearedEntryEvidence[] = [...byEntry].map(([entryId, group]) => ({
    entryId,
    lines: [...group.values()].map((line) => ({
      accountId: line.accountId,
      cleared: line.cleared,
      clearedDate: line.clearedDate,
    })),
  }));
  if (stamped.length > 0) {
    const result = await applySourceLineEvidence(orgId, connector, stamped);
    outcome.entriesStamped = result.entries;
    outcome.linesStamped = result.linesStamped;
  }

  const states = await refreshSourceReconciliationState(orgId, connector);
  for (const state of states) {
    if (!state.reconciledThrough) continue;
    const signed = await signOffFromSourceEvidence(
      { accountId: state.accountId },
      { orgId, userId: actorId },
    );
    if (signed.signed) {
      outcome.signedOff.push({
        accountId: state.accountId,
        reconciliationId: signed.reconciliationId,
        throughDate: signed.throughDate,
      });
    } else {
      outcome.skipped.push({
        accountId: state.accountId,
        throughDate: signed.throughDate,
        clearedLines: signed.clearedLines,
        unclearedLines: signed.unclearedLines,
        reason: signed.reason,
      });
    }
  }
  return outcome;
}
