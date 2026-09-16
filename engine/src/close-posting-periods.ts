import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "./db.ts";
import {
  assertPeriodModulesOpen,
  CloseError,
  closeModuleForDocument,
  type CloseModule,
  NON_POSTING_DOCUMENT_KINDS,
} from "./close.ts";
import { uuidArray } from "./subsidiaries.ts";

/**
 * Admin bulk assignment of posting periods to approved, unposted documents
 * that lack one (the close-readiness `posting-period-missing` population).
 *
 * The posting kernel derives a document's period from its effective date
 * (`posting_date ?? document_date`) at post time, so an unassigned approved
 * document posts fine — but the close checklist cannot attest attribution it
 * cannot see. This action makes the derivation explicit ahead of posting:
 * each candidate resolves to the non-adjustment accounting period covering
 * its effective date, exactly as `resolvePostingPeriod` would, except an
 * ambiguous calendar overlap refuses instead of picking an arbitrary row.
 * A candidate whose period is closed for its kind's close module on the
 * target book is refused, never force-assigned. Preview first, commit after;
 * both run against the same derivation so the preview is the commit.
 */

export class PostingPeriodAssignmentError extends Error {
  readonly name = "PostingPeriodAssignmentError";
}

export interface PostingPeriodCandidate {
  documentId: string;
  documentNumber: string;
  kind: string;
  subsidiaryId: string | null;
  /** The kernel's effective date: posting_date ?? document_date. */
  effectiveDate: string;
  periodId: string | null;
  periodName: string | null;
  blocked: boolean;
  blockReason: string | null;
}

export interface PostingPeriodAssignmentOptions {
  bookId: string;
  /** Explicit documents; undefined means every eligible document. */
  documentIds?: string[];
  /** Subsidiary scope; null/undefined means every subsidiary. */
  subsidiaryIds?: string[] | null;
}

async function assertBookOwned(
  runner: SqlExecutor,
  orgId: string,
  bookId: string,
): Promise<void> {
  const found = (await runner.execute<{ id: string }>(sql`
    select id from accounting_books where id = ${bookId} and org_id = ${orgId} limit 1`));
  if (!found.rows[0]) {
    throw new PostingPeriodAssignmentError("accounting book not found in this organization");
  }
}

type CandidateRow = {
  id: string;
  document_number: string;
  kind: string;
  subsidiary_id: string | null;
  effective_date: string;
};

async function loadCandidates(
  runner: SqlExecutor,
  orgId: string,
  opts: PostingPeriodAssignmentOptions,
): Promise<CandidateRow[]> {
  await assertBookOwned(runner, orgId, opts.bookId);
  const scopeIds = opts.subsidiaryIds ?? null;
  const rows = (await runner.execute<CandidateRow>(sql`
    select d.id, d.document_number, d.kind, d.subsidiary_id,
           coalesce(d.posting_date, d.document_date)::text as effective_date
      from documents d
     where d.org_id = ${orgId}
       and d.status = 'approved'
       and d.posting_period_id is null
       and d.kind not in (${sql.join(NON_POSTING_DOCUMENT_KINDS.map((k) => sql`${k}`), sql`, `)})
       ${opts.documentIds !== undefined
         ? opts.documentIds.length > 0
           ? sql`and d.id = any(${uuidArray(opts.documentIds)}::uuid[])`
           : sql`and false`
         : sql``}
       ${scopeIds ? sql`and (d.subsidiary_id = any(${uuidArray(scopeIds)}::uuid[]) or d.subsidiary_id is null)` : sql``}
     order by d.document_date, d.document_number`)).rows;
  if (opts.documentIds !== undefined && opts.documentIds.length > 0) {
    const seen = new Set(rows.map((row) => row.id));
    const missing = opts.documentIds.filter((id) => !seen.has(id));
    if (missing.length > 0) {
      throw new PostingPeriodAssignmentError(
        `${missing.length} document(s) are not assignable (unknown, not approved, or already assigned)`,
      );
    }
  }
  return rows;
}

async function resolveCandidate(
  runner: SqlExecutor,
  orgId: string,
  bookId: string,
  row: CandidateRow,
): Promise<PostingPeriodCandidate> {
  const base = {
    documentId: row.id,
    documentNumber: row.document_number,
    kind: row.kind,
    subsidiaryId: row.subsidiary_id,
    effectiveDate: row.effective_date,
  };
  let module: CloseModule;
  try {
    module = closeModuleForDocument(row.kind);
  } catch (error) {
    return {
      ...base,
      periodId: null,
      periodName: null,
      blocked: true,
      blockReason: error instanceof Error ? error.message : String(error),
    };
  }
  const periods = (await runner.execute<{ id: string; name: string }>(sql`
    select id, name from accounting_periods
     where org_id = ${orgId}
       and starts_on <= ${row.effective_date}
       and ends_on >= ${row.effective_date}
       and is_adjustment = false`)).rows;
  if (periods.length === 0) {
    return {
      ...base,
      periodId: null,
      periodName: null,
      blocked: true,
      blockReason: `no accounting period covers ${row.effective_date}`,
    };
  }
  if (periods.length > 1) {
    return {
      ...base,
      periodId: null,
      periodName: null,
      blocked: true,
      blockReason: `multiple accounting periods cover ${row.effective_date}; assign manually`,
    };
  }
  const period = periods[0]!;
  try {
    await assertPeriodModulesOpen(runner, {
      orgId,
      periodId: period.id,
      bookId,
      subsidiaryIds: [row.subsidiary_id as string],
      modules: [module],
    });
  } catch (error) {
    return {
      ...base,
      periodId: period.id,
      periodName: period.name,
      blocked: true,
      blockReason: error instanceof CloseError
        ? `period ${period.name} is closed for ${module.toUpperCase()} on this book`
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
  return { ...base, periodId: period.id, periodName: period.name, blocked: false, blockReason: null };
}

/** Read-only preview: every candidate with its derived period or refusal reason. */
export async function previewPostingPeriodAssignment(
  orgId: string,
  opts: PostingPeriodAssignmentOptions,
): Promise<{ bookId: string; rows: PostingPeriodCandidate[] }> {
  return withOrgTransaction(orgId, async () => {
    const candidates = await loadCandidates(db, orgId, opts);
    const rows: PostingPeriodCandidate[] = [];
    for (const row of candidates) rows.push(await resolveCandidate(db, orgId, opts.bookId, row));
    return { bookId: opts.bookId, rows };
  });
}

export interface PostingPeriodCommitResult {
  assigned: { documentId: string; periodId: string }[];
  skipped: { documentId: string; reason: string }[];
  refused: { documentId: string; reason: string }[];
}

/**
 * Commit the assignment in one transaction. Assignable rows are updated only
 * from the still-unassigned state (concurrent runs report `skipped`, never
 * double-write); blocked rows are reported in `refused` and never touched.
 * Every assignment writes an audit row with before/after state and actor.
 * Idempotent: a re-run assigns nothing.
 */
export async function commitPostingPeriodAssignment(
  orgId: string,
  opts: PostingPeriodAssignmentOptions & { actorId: string | null },
): Promise<PostingPeriodCommitResult> {
  return withOrgTransaction(orgId, () =>
    db.transaction(async (tx) => {
      const candidates = await loadCandidates(tx, orgId, opts);
      const result: PostingPeriodCommitResult = { assigned: [], skipped: [], refused: [] };
      for (const row of candidates) {
        const resolved = await resolveCandidate(tx, orgId, opts.bookId, row);
        if (resolved.blocked || !resolved.periodId) {
          result.refused.push({ documentId: row.id, reason: resolved.blockReason ?? "not assignable" });
          continue;
        }
        const updated = (await tx.execute<{ id: string }>(sql`
          update documents
             set posting_period_id = ${resolved.periodId},
                 updated_at = now(), updated_by = ${opts.actorId}
           where id = ${row.id} and org_id = ${orgId}
             and status = 'approved' and posting_period_id is null
          returning id`)).rows;
        if (updated.length === 0) {
          result.skipped.push({ documentId: row.id, reason: "no longer assignable" });
          continue;
        }
        await tx.execute(sql`
          insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
          values (${orgId}, 'documents', ${row.id}, 'update',
                  ${JSON.stringify({
                    before: { posting_period_id: null },
                    after: { posting_period_id: resolved.periodId },
                    reason: "bulk posting-period assignment",
                  })}::jsonb, ${opts.actorId})`);
        result.assigned.push({ documentId: row.id, periodId: resolved.periodId });
      }
      return result;
    }));
}
