import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import {
  assertPeriodModulesOpen,
  canonicalPeriodLabel,
  CloseError,
  closeModuleForDocument,
  type CloseModule,
  NON_POSTING_DOCUMENT_KINDS,
  type PeriodDisplayInput,
} from "../periods/period-policy.ts";
import { resolveCoveringPeriod } from "../periods/period-resolution.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { uuidArray } from "../organization/subsidiaries.ts";

/**
 * Admin bulk assignment of posting periods to approved, unposted documents
 * that lack one (the close-readiness `posting-period-missing` population).
 *
 * The posting kernel derives a document's period from its effective date
 * (`posting_date ?? document_date`) at post time, so an unassigned approved
 * document posts fine — but the close checklist cannot attest attribution it
 * cannot see. This action makes the derivation explicit ahead of posting:
 * each candidate resolves through the shared covering-period resolver
 * (effective subsidiary calendar, regular periods, deterministic under overlaps),
 * exactly as `resolvePostingPeriod` would at post time.
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
  /** Locale-free label of the derived period (`P05 FY2026`). */
  periodName: string | null;
  /** The derived period's fiscal position and dates, for display labels. */
  periodRef: PeriodDisplayInput | null;
  blocked: boolean;
  blockReason: string | null;
  /** True when the derived period is the adjustment opt-in, not the regular cover. */
  adjustment: boolean;
  /** Open adjustment alternative for a closed regular period; null when none stands open. */
  adjustmentPeriod: AdjustmentAlternative | null;
}

/** An open adjustment period: its id, locale-free label and fiscal position. */
export interface AdjustmentAlternative {
  id: string;
  name: string;
  periodRef: PeriodDisplayInput;
}

export interface PostingPeriodAssignmentOptions {
  bookId: string;
  /** Explicit documents; undefined means every eligible document. */
  documentIds?: string[];
  /** Subsidiary scope; null/undefined means every subsidiary. */
  subsidiaryIds?: string[] | null;
  /**
   * Explicit adjustment-period opt-in for year-end corrections: candidates
   * whose regular covering period is closed are assigned here instead of
   * refused, after the same module-gate check the regular period gets. Never
   * implicit — ordinary postings must not slide into the adjustment bucket
   * unasked, so a caller that does not name it keeps the refusal.
   */
  adjustmentPeriodId?: string;
}

async function assertBookOwned(runner: SqlExecutor, orgId: string, bookId: string): Promise<void> {
  const found = await runner.execute<{ id: string }>(
    sql`
    select id from accounting_books where id = ${bookId} and org_id = ${orgId} limit 1`,
    "objects",
  );
  if (!found[0]) {
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

/**
 * The caller's subsidiary scope as a set, or null for unrestricted. An
 * explicit empty set denies every row; only an explicit null is unrestricted.
 */
function scopeSet(opts: PostingPeriodAssignmentOptions): ReadonlySet<string> | null {
  if (opts.subsidiaryIds === undefined || opts.subsidiaryIds === null) return null;
  return new Set(opts.subsidiaryIds);
}

async function loadCandidates(
  runner: SqlExecutor,
  orgId: string,
  opts: PostingPeriodAssignmentOptions,
): Promise<CandidateRow[]> {
  await assertBookOwned(runner, orgId, opts.bookId);
  const scopeIds = opts.subsidiaryIds ?? null;
  const rows = await runner.execute<CandidateRow>(
    sql`
    select d.id, d.document_number, d.kind, d.subsidiary_id,
           coalesce(d.posting_date, d.document_date)::text as effective_date
      from documents d
     where d.org_id = ${orgId}
       and d.status = 'approved'
       and d.posting_period_id is null
       and d.kind not in (${sql.join(
         NON_POSTING_DOCUMENT_KINDS.map((k) => sql`${k}`),
         sql`, `,
       )})
       ${
         opts.documentIds !== undefined
           ? opts.documentIds.length > 0
             ? sql`and d.id = any(${uuidArray(opts.documentIds)}::uuid[])`
             : sql`and false`
           : sql``
       }
       ${
         scopeIds
           ? // A null subsidiary fails closed for restricted callers, exactly
             // like direct document access: only an unrestricted caller (null
             // scope) may see or touch unattributed documents.
             sql`and d.subsidiary_id = any(${uuidArray(scopeIds)}::uuid[])`
           : sql``
       }
     order by d.document_date, d.document_number`,
    "objects",
  );
  if (opts.documentIds !== undefined && opts.documentIds.length > 0) {
    const seen = new Set(rows.map((row) => row.id));
    const missing = opts.documentIds.filter((id) => !seen.has(id));
    if (missing.length > 0) {
      throw new PostingPeriodAssignmentError(
        `${missing.length} document(s) are not assignable (unknown, not approved, already assigned, or outside your subsidiary scope)`,
      );
    }
  }
  return rows;
}

/**
 * The open adjustment period for a regular period's fiscal year, if one
 * stands open for the document kind's module gate on the target book. Read
 * only: naming it never assigns anything — the caller opts in explicitly.
 */
async function openAdjustmentAlternative(
  runner: SqlExecutor,
  orgId: string,
  bookId: string,
  module: CloseModule,
  subsidiaryId: string | null,
  calendarId: string,
  fiscalYear: number,
): Promise<AdjustmentAlternative | null> {
  const row = (
    await runner.execute<{ id: string; period_number: number; starts_on: string; ends_on: string }>(
      sql`
    select id, period_number, starts_on::text as starts_on, ends_on::text as ends_on from accounting_periods
     where org_id = ${orgId} and fiscal_calendar_id = ${calendarId}
       and fiscal_year = ${fiscalYear} and is_adjustment
     order by period_number limit 1`,
      "objects",
    )
  )[0];
  if (!row) return null;
  const periodRef: PeriodDisplayInput = {
    fiscalYear,
    periodNumber: Number(row.period_number),
    adjustment: true,
    startsOn: row.starts_on,
    endsOn: row.ends_on,
  };
  const adjustment: AdjustmentAlternative = {
    id: row.id,
    name: canonicalPeriodLabel(periodRef),
    periodRef,
  };
  try {
    await assertPeriodModulesOpen(runner, {
      orgId,
      periodId: adjustment.id,
      bookId,
      subsidiaryIds: subsidiaryId ? [subsidiaryId] : [],
      modules: [module],
    });
  } catch (error) {
    if (error instanceof CloseError) return null;
    throw error;
  }
  return adjustment;
}

async function resolveCandidate(
  runner: SqlExecutor,
  orgId: string,
  bookId: string,
  row: CandidateRow,
  adjustmentPeriodId?: string,
): Promise<PostingPeriodCandidate> {
  const base = {
    documentId: row.id,
    documentNumber: row.document_number,
    kind: row.kind,
    subsidiaryId: row.subsidiary_id,
    effectiveDate: row.effective_date,
    adjustment: false as boolean,
    adjustmentPeriod: null as AdjustmentAlternative | null,
  };
  const unresolved = { periodId: null, periodName: null, periodRef: null };
  let module: CloseModule;
  try {
    module = closeModuleForDocument(row.kind);
  } catch (error) {
    // An undecided kind stays blocked with operator copy: the registry name
    // is an engineering detail and never reaches the screen. Only kinds the
    // product itself creates can land here, so this names the document, the
    // consequence, and the fix.
    if (error instanceof CloseError) {
      return {
        ...base,
        ...unresolved,
        blocked: true,
        blockReason: `document kind "${row.kind}" is not configured for period close, so ${row.document_number} cannot be assigned a period and stays blocked; your system administrator must add a period-close decision for this kind`,
      };
    }
    return {
      ...base,
      ...unresolved,
      blocked: true,
      blockReason: error instanceof Error ? error.message : String(error),
    };
  }
  // Resolve on the document's effective subsidiary calendar, matching the
  // posting kernel. Overlapping calendars cannot redirect the assignment.
  const period = await resolveCoveringPeriod(runner, orgId, row.effective_date, row.subsidiary_id);
  if (!period) {
    return {
      ...base,
      ...unresolved,
      blocked: true,
      blockReason: `no accounting period covers ${row.effective_date}`,
    };
  }
  const periodRef: PeriodDisplayInput = {
    fiscalYear: period.fiscal_year,
    periodNumber: period.period_number,
    adjustment: false,
    startsOn: period.starts_on,
    endsOn: period.ends_on,
  };
  const covering = { periodId: period.id, periodName: canonicalPeriodLabel(periodRef), periodRef };
  try {
    await assertPeriodModulesOpen(runner, {
      orgId,
      periodId: period.id,
      bookId,
      subsidiaryIds: row.subsidiary_id ? [row.subsidiary_id] : [],
      modules: [module],
    });
  } catch (error) {
    if (!(error instanceof CloseError)) {
      return {
        ...base,
        ...covering,
        blocked: true,
        blockReason: error instanceof Error ? error.message : String(error),
      };
    }
    // The regular period is closed for this kind: offer the fiscal year's
    // open adjustment period instead, and take it only when the caller named
    // exactly that period. The kernel re-validates the window and the gate
    // at post time, so preview and commit agree by construction.
    const alternative = await openAdjustmentAlternative(
      runner,
      orgId,
      bookId,
      module,
      row.subsidiary_id,
      period.fiscal_calendar_id,
      period.fiscal_year,
    );
    if (alternative && adjustmentPeriodId === alternative.id) {
      return {
        ...base,
        periodId: alternative.id,
        periodName: alternative.name,
        periodRef: alternative.periodRef,
        blocked: false,
        blockReason: null,
        adjustment: true,
        adjustmentPeriod: alternative,
      };
    }
    return {
      ...base,
      ...covering,
      blocked: true,
      blockReason:
        `period ${covering.periodName} is closed for ${module.toUpperCase()} on this book` +
        (alternative
          ? `; the open adjustment period "${alternative.name}" can take it instead`
          : ""),
      adjustmentPeriod: alternative,
    };
  }
  return { ...base, ...covering, blocked: false, blockReason: null };
}

/** A named adjustment opt-in must name the org's own adjustment period — a
 * typo'd id assigns nothing anywhere, which reads as success with zero
 * writes, so it refuses instead. */
async function assertAdjustmentOwned(
  runner: SqlExecutor,
  orgId: string,
  adjustmentPeriodId: string,
): Promise<void> {
  const found = await runner.execute<{ id: string }>(
    sql`
    select id from accounting_periods
     where id = ${adjustmentPeriodId} and org_id = ${orgId} and is_adjustment limit 1`,
    "objects",
  );
  if (!found[0]) {
    throw new PostingPeriodAssignmentError("adjustment period not found in this organization");
  }
}

/** Read-only preview: every candidate with its derived period or refusal reason. */
export async function previewPostingPeriodAssignment(
  orgId: string,
  opts: PostingPeriodAssignmentOptions,
): Promise<{ bookId: string; rows: PostingPeriodCandidate[] }> {
  return withOrgTransaction(orgId, async () => {
    if (opts.adjustmentPeriodId) await assertAdjustmentOwned(db, orgId, opts.adjustmentPeriodId);
    const candidates = await loadCandidates(db, orgId, opts);
    const rows: PostingPeriodCandidate[] = [];
    for (const row of candidates)
      rows.push(await resolveCandidate(db, orgId, opts.bookId, row, opts.adjustmentPeriodId));
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
      if (opts.adjustmentPeriodId) await assertAdjustmentOwned(tx, orgId, opts.adjustmentPeriodId);
      const candidates = await loadCandidates(tx, orgId, opts);
      const scope = scopeSet(opts);
      const result: PostingPeriodCommitResult = { assigned: [], skipped: [], refused: [] };
      for (const row of candidates) {
        // Lock the document and recheck its subsidiary inside the write
        // transaction: the candidate read above is unlocked, so a concurrent
        // A→B rehome between that read and this update must not let an
        // A-scoped caller assign B's document. The predicate runs under the
        // row lock, so it sees the latest committed subsidiary — never the
        // candidate's stale one. A null subsidiary fails closed for
        // restricted callers, like the candidate filter above.
        const locked = (
          await tx.execute<{ subsidiary_id: string | null }>(
            sql`
          select subsidiary_id from documents
           where id = ${row.id} and org_id = ${orgId} for update`,
            "objects",
          )
        )[0];
        if (!locked || !subsidiaryScopeAllows(scope, locked.subsidiary_id)) {
          result.skipped.push({ documentId: row.id, reason: "no longer assignable" });
          continue;
        }
        const resolved = await resolveCandidate(
          tx,
          orgId,
          opts.bookId,
          row,
          opts.adjustmentPeriodId,
        );
        if (resolved.blocked || !resolved.periodId) {
          result.refused.push({
            documentId: row.id,
            reason: resolved.blockReason ?? "not assignable",
          });
          continue;
        }
        const updated = await tx.execute<{ id: string }>(
          sql`
          update documents
             set posting_period_id = ${resolved.periodId},
                 updated_at = now(), updated_by = ${opts.actorId}
           where id = ${row.id} and org_id = ${orgId}
             and status = 'approved' and posting_period_id is null
             ${scope ? sql`and subsidiary_id = any(${uuidArray([...scope])}::uuid[])` : sql``}
          returning id`,
          "objects",
        );
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
                    reason: resolved.adjustment
                      ? `bulk posting-period assignment to adjustment period ${resolved.periodName}`
                      : "bulk posting-period assignment",
                  })}::jsonb, ${opts.actorId})`);
        result.assigned.push({ documentId: row.id, periodId: resolved.periodId });
      }
      return result;
    }),
  );
}
