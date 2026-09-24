import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { refuseMaskedStorageKind } from "../../platform/file-storage.ts";
import {
  requireAggregateDocumentsRead,
  requireHrmDocumentsRead,
  requirePartyInScope,
} from "../authorization.ts";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { subsidiaryVisibleFilter, withScopeSnapshot } from "../../organization/subsidiary-scope.ts";
import { HrmDocumentsError } from "./errors.ts";
import { storeCabinetFile } from "./cabinet.ts";
import { buildStoredZip, type ZipEntry } from "./zip-store.ts";
import { decryptRespondentLink } from "../../hrm/surveys/responses.ts";
import { dsarCoverageManifest } from "./dsar-coverage.ts";

/**
 * HR-19 data-subject (DSAR) exports.
 *
 * requestExport refuses when the requester lacks hrm.documents.manage
 * AND is not the subject (the party behind their login) — fail closed by
 * name, never an empty zip. Manage holders and readers are additionally
 * fenced to subjects inside their legal-entity scope: request, list and
 * download all refuse out-of-scope subjects with the uniform not-visible
 * refusal, so no full data ZIP is queued, enumerated or delivered across
 * entities. The worker duty hrm-dsar-exports drains the
 * queue through buildExport: one transaction gathers the person's party
 * record, employments and versions, change requests, leave, time entries,
 * the reviews they may see, benefits, HR documents with file bytes, and
 * payroll pay stubs with lines (the persisted historical records —
 * snapshots, never live re-resolution), writes export.json plus the
 * files into a stored zip in the File Cabinet with a viewer grant to the
 * requester ONLY, and marks the row ready. A module that throws is
 * recorded in scope as failed with its reason — the export stays
 * auditable instead of silently partial. delivered flips on download.
 * The drain holds a durable per-export claim (status building + owner +
 * lease, one atomic UPDATE) before building: only the claim owner may mark
 * ready or failed, and a lapsed lease is reclaimable, so concurrent workers
 * never build the same export twice and a loser can never fail the winner.
 */

export const DSAR_MODULES = [
  "party",
  "employments",
  "change_requests",
  "leave",
  "time",
  "reviews",
  "benefits",
  "documents",
  "payroll",
  "recruiting",
  "qualifications",
  "statements",
  "surveys",
  "clock_events",
  "exports",
] as const;

export type DsarModule = (typeof DSAR_MODULES)[number];

export interface DsarExportDTO {
  id: string;
  partyId: string;
  requestedBy: string;
  requestedAt: string;
  status: string;
  fileId: string | null;
  scope: unknown;
  completedAt: string | null;
  error: string | null;
}

type ExportRow = {
  id: string;
  party_id: string;
  requested_by: string;
  requested_at: string;
  status: string;
  file_id: string | null;
  scope: unknown;
  completed_at: string | null;
  error: string | null;
};

function toDTO(row: ExportRow): DsarExportDTO {
  return {
    id: row.id,
    partyId: row.party_id,
    requestedBy: row.requested_by,
    requestedAt: row.requested_at,
    status: row.status,
    fileId: row.file_id,
    scope: row.scope,
    completedAt: row.completed_at,
    error: row.error,
  };
}

const EXPORT_COLS = sql`
  select id, party_id, requested_by, requested_at::text as requested_at, status,
         file_id, scope, completed_at::text as completed_at, error
    from hrm_data_subject_exports`;

export async function requestExport(input: {
  orgId: string;
  actorId: string;
  partyId: string;
}): Promise<DsarExportDTO> {
  return withOrgTransaction(input.orgId, async () => {
    const manages = await actorHasPermission(db, input.orgId, input.actorId, "hrm.documents.manage");
    if (!manages) {
      const own = (await db.execute<{ partyId: string | null }>(sql`
        select party_id as "partyId" from users where org_id = ${input.orgId} and id = ${input.actorId}
      `)).rows[0]?.partyId;
      if (own !== input.partyId) {
        throw new HrmDocumentsError(
          "FORBIDDEN",
          "exports run for your own record, or with hrm.documents.manage — ask HR to request anyone else's",
        );
      }
      if (!(await actorHasPermission(db, input.orgId, input.actorId, "hrm.self.read"))) {
        throw new HrmDocumentsError(
          "FORBIDDEN",
          "your login is not linked to self-service — ask HR to request your export",
        );
      }
    }
    // The manage grant never carries a subject: the export's subject must be
    // inside the actor's legal-entity scope, or no full data ZIP is queued.
    await requirePartyInScope(db, input.orgId, input.actorId, input.partyId);
    const party = (await db.execute<{ id: string }>(sql`
      select id from parties where org_id = ${input.orgId} and id = ${input.partyId}
    `)).rows[0];
    if (!party) {
      throw new HrmDocumentsError("NOT_FOUND", "the subject is not visible in this organization");
    }
    const inserted = (await db.execute<ExportRow>(sql`
      insert into hrm_data_subject_exports (org_id, party_id, requested_by, scope, created_by, updated_by)
      values (${input.orgId}, ${input.partyId}, ${input.actorId},
              ${JSON.stringify(DSAR_MODULES)}::jsonb, ${input.actorId}, ${input.actorId})
      returning id, party_id, requested_by, requested_at::text as requested_at, status,
                file_id, scope, completed_at::text as completed_at, error
    `)).rows[0];
    if (!inserted) {
      throw new HrmDocumentsError(
        "REFUSED",
        "the export request was not stored — no row was written, so nothing is queued",
      );
    }
    return toDTO(inserted);
  });
}

export async function listExports(query: {
  orgId: string;
  actorId: string;
  partyId?: string;
}): Promise<DsarExportDTO[]> {
  // One REPEATABLE READ snapshot for the scope resolution and the list, so
  // a concurrent rehome cannot move a row between the two reads.
  return withScopeSnapshot(query.orgId, async () => {
    const allowed = await requireAggregateDocumentsRead(db, query.orgId, query.actorId);
    if (query.partyId) {
      await requirePartyInScope(db, query.orgId, query.actorId, query.partyId);
    }
    const rows = (await db.execute<ExportRow>(sql`
      ${EXPORT_COLS}
       where org_id = ${query.orgId}
         ${query.partyId ? sql`and party_id = ${query.partyId}` : sql``}
         ${exportScopePredicate(query.orgId, allowed)}
       order by requested_at desc
       limit 100
    `)).rows;
    return rows.map(toDTO);
  });
}

/**
 * Employer-subsidiary predicate for export lists: an export lists only
 * when its subject party holds at least one in-scope employment. The
 * subsidiary test itself is the canonical subsidiaryVisibleFilter.
 * Unrestricted callers read everything.
 */
function exportScopePredicate(orgId: string, allowed: Set<string> | null): SQL {
  if (allowed === null) return sql``;
  const employmentInScope: SQL = subsidiaryVisibleFilter(sql`e.employer_subsidiary_id`, allowed);
  return sql`and exists (
    select 1 from worker_employments e
     where e.org_id = ${orgId}
       and e.worker_party_id = hrm_data_subject_exports.party_id
       ${employmentInScope}
  )`;
}

/**
 * Own exports for the Me surface (hrm.self.read, fenced to own party).
 * HR readers use the manage list; self-service without the grant meets
 * the read gate rather than everyone else's rows.
 */
export async function listOwnExports(query: {
  orgId: string;
  actorId: string;
}): Promise<{ exports: DsarExportDTO[]; partyId: string }> {
  if (!(await actorHasPermission(db, query.orgId, query.actorId, "hrm.self.read"))) {
    await requireHrmDocumentsRead(db, query.orgId, query.actorId);
    return { exports: await listExports(query), partyId: "" };
  }
  const partyId = (await db.execute<{ partyId: string | null }>(sql`
    select party_id as "partyId" from users where org_id = ${query.orgId} and id = ${query.actorId}
  `)).rows[0]?.partyId;
  if (!partyId) {
    throw new HrmDocumentsError(
      "REFUSED",
      "your login is not linked to a person record — ask HR to link it before opening your exports",
    );
  }
  const rows = (await db.execute<ExportRow>(sql`
    ${EXPORT_COLS}
     where org_id = ${query.orgId} and party_id = ${partyId}
     order by requested_at desc
     limit 100
  `)).rows;
  return { exports: rows.map(toDTO), partyId };
}

/**
 * Lease a worker holds on a claimed export: long enough for a zip build
 * (gather + store + mark) with headroom, short enough that a crashed worker
 * does not stall the queue — the next drain reclaims lapsed leases.
 */
export const DSAR_CLAIM_LEASE_SECONDS = 600;

export interface ClaimedExport extends ExportRow {
  claimedBy: string;
}

/**
 * Claim the next queued export for the worker (one claim per call, oldest
 * first). The claim is ONE atomic UPDATE to status='building' carrying a
 * random owner token and a lease expiry — the transaction commits WITH the
 * row marked, so a second worker can never claim the same export while the
 * lease is live (it skips to the next queued row, or finds nothing).
 * Expired leases ('building' past lease_expires_at, i.e. a worker that
 * crashed mid-build) are reclaimed in requested_at order, so recovery needs
 * no sweeper — the next drain picks them up.
 */
export async function claimQueuedExport(
  exec: SqlExecutor,
  orgId: string,
  owner: string = randomUUID(),
  leaseSeconds: number = DSAR_CLAIM_LEASE_SECONDS,
): Promise<ClaimedExport | null> {
  const row = (await exec.execute<ExportRow & { claimed_by: string }>(sql`
    update hrm_data_subject_exports
       set status = 'building', claimed_by = ${owner}, claimed_at = now(),
           lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
           updated_at = now()
     where id = (
       select id
         from hrm_data_subject_exports
        where org_id = ${orgId}
          and (status = 'queued'
               or (status = 'building'
                   and lease_expires_at is not null
                   and lease_expires_at < now()))
        order by requested_at
        limit 1
        for update skip locked
     )
    returning id, party_id, requested_by, requested_at::text as requested_at, status,
              file_id, scope, completed_at::text as completed_at, error, claimed_by
  `)).rows[0];
  if (!row) return null;
  return { ...row, claimedBy: row.claimed_by };
}

/**
 * Claim one SPECIFIC export for a build (buildExport's self-claim): queued
 * rows, expired leases, and re-entrant refreshes of the caller's own live
 * claim. Anything else — a live claim owned by someone else, or a terminal
 * row — matches zero and reports false, so the caller walks away instead of
 * building over another worker's export.
 */
async function claimSpecificExport(
  exec: SqlExecutor,
  orgId: string,
  exportId: string,
  owner: string,
  leaseSeconds: number = DSAR_CLAIM_LEASE_SECONDS,
): Promise<boolean> {
  const rows = (await exec.execute<{ n: string }>(sql`
    update hrm_data_subject_exports
       set status = 'building', claimed_by = ${owner}, claimed_at = now(),
           lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
           updated_at = now()
     where org_id = ${orgId} and id = ${exportId}
       and (status = 'queued'
            or (status = 'building' and claimed_by = ${owner})
            or (status = 'building'
                and lease_expires_at is not null
                and lease_expires_at < now()))
    returning 1 as n
  `)).rows;
  return rows.length > 0;
}

async function failExport(
  exec: SqlExecutor,
  orgId: string,
  exportId: string,
  owner: string,
  error: string,
): Promise<void> {
  // Conditional on owning a live claim: a worker that lost the race (or an
  // intruder naming an id it never claimed) matches zero rows and changes
  // nothing — a ready/delivered export is NEVER overwritten here. Zero
  // matches is the expected benign outcome on a lost race, not a dropped
  // write: the caller only reaches this path for a build it owned, so when
  // the row is no longer its building claim the winner's outcome stands.
  await exec.execute(sql`
    update hrm_data_subject_exports
       set status = 'failed', error = ${error}, completed_at = now(), updated_at = now()
     where org_id = ${orgId} and id = ${exportId}
       and status = 'building' and claimed_by = ${owner}
  `);
}

/**
 * Cabinet bytes for an export-referenced file: the retrievable bytes plus
 * the stored extension, or null when the record exists but no bytes remain
 * (purged, orphaned, never stored). A masked-clone tombstone refuses by
 * name — a subject-access export must never silently omit the file.
 */
async function fetchExportFileBytes(
  orgId: string,
  fileId: string,
): Promise<{ bytes: Buffer; extension: string | null } | null> {
  const blob = (await db.execute<{ storage_kind: string; bytes: Buffer | null; extension: string | null }>(sql`
    select v.storage_kind, b.bytes, f.extension
      from files f
      join file_versions v on v.id = f.current_version_id
      left join file_blobs b on b.version_id = v.id
     where f.id = ${fileId} and f.org_id = ${orgId}
  `)).rows[0];
  if (blob) refuseMaskedStorageKind(blob.storage_kind);
  if (!blob?.bytes) return null;
  return { bytes: blob.bytes as Buffer, extension: blob.extension };
}

/**
 * Build one queued export: claim it, gather every module, zip, store with a
 * requester-only grant, mark ready. Throws nothing — failure marks the
 * row failed with the reason, and ONLY when this call still owns the claim.
 *
 * The owner is the claim token from claimQueuedExport (the drain path), or
 * a fresh self-claim for direct callers. A call that cannot claim — a live
 * claim owned by another worker, or a terminal row — returns silently and
 * never fails another worker's export.
 */
export async function buildExport(orgId: string, exportId: string, opts?: { owner?: string }): Promise<void> {
  const owner = opts?.owner ?? randomUUID();
  const claimed = await withOrgTransaction(orgId, () =>
    claimSpecificExport(db, orgId, exportId, owner),
  );
  if (!claimed) return;
  await withOrgTransaction(orgId, async () => {
    const row = (await db.execute<ExportRow & { claimed_by: string | null }>(sql`
      select id, party_id, requested_by, requested_at::text as requested_at, status,
             file_id, scope, completed_at::text as completed_at, error, claimed_by
        from hrm_data_subject_exports where org_id = ${orgId} and id = ${exportId}
    `)).rows[0];
    if (!row) {
      throw new HrmDocumentsError("NOT_FOUND", "export request is not visible in this organization");
    }
    // The self-claim above just marked this row building under our owner;
    // anything else here means the claim moved on without us — walk away
    // rather than building over whoever holds it now.
    if (row.status !== "building" || row.claimed_by !== owner) return;
    const partyId = row.party_id;
    const requesterId = row.requested_by;
    const included: { module: string; status: string; detail?: string }[] = [];
    const entries: ZipEntry[] = [];
    const fail = (module: string, detail: string) => included.push({ module, status: "failed", detail });

    // Each module gathers inside its own savepoint: a failed module
    // query ABORTS its savepoint only, not the export transaction — a
    // bare try/catch around raw SQL cannot continue after Postgres has
    // poisoned the transaction, so without this the first failing module
    // would fail every later module with "current transaction is
    // aborted". Savepoint names come from the fixed DSAR_MODULES list,
    // never from input, so interpolation is safe.
    const gather = async (module: DsarModule, fn: () => Promise<void>) => {
      const savepoint = `hrm_dsar_${module}`;
      await db.execute(sql.raw(`savepoint ${savepoint}`));
      try {
        await fn();
        included.push({ module, status: "included" });
      } catch (e) {
        await db.execute(sql.raw(`rollback to savepoint ${savepoint}`));
        fail(module, describeExportError(e));
      } finally {
        await db.execute(sql.raw(`release savepoint ${savepoint}`));
      }
    };

    const payload: Record<string, unknown> = {
      exportedAt: new Date().toISOString(),
      orgId,
      partyId,
    };

    await gather("party", async () => {
      const party = (await db.execute<Record<string, unknown>>(sql`
        select id, display_name, legal_name, email, phone, kind, created_at::text as created_at
          from parties where org_id = ${orgId} and id = ${partyId}
      `)).rows[0];
      if (!party) throw new Error("subject party is gone");
      payload.party = party;
    });

    await gather("employments", async () => {
      const employments = (await db.execute<Record<string, unknown>>(sql`
        select e.id, e.revision, v.version_no, v.status, v.effective_from::text as effective_from,
               v.effective_to::text as effective_to
          from worker_employments e
          join worker_employment_versions v
            on v.org_id = e.org_id and v.employment_id = e.id and v.recorded_until is null
         where e.org_id = ${orgId} and e.worker_party_id = ${partyId}
         order by e.id, v.version_no
      `)).rows;
      const assignments = (await db.execute<Record<string, unknown>>(sql`
        select a.employment_id, a.assignment_key, v.job_title, v.department_id, v.location_id,
               v.fte, v.is_primary, v.effective_from::text as effective_from,
               v.effective_to::text as effective_to
          from employment_assignments a
          join employment_assignment_versions v
            on v.org_id = a.org_id and v.assignment_id = a.id and v.recorded_until is null
         where a.org_id = ${orgId} and a.employment_id in (
           select id from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}
         )
         order by a.employment_id, v.effective_from
      `)).rows;
      payload.employments = employments;
      payload.assignments = assignments;
      // Employment-lifecycle records keyed by the subject's full employment
      // set (the party subselect, never the versioned read above, so an
      // employment without a current version still exports its history).
      const subjectEmployments = sql`select id from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}`;
      payload.employmentChanges = (await db.execute<Record<string, unknown>>(sql`
        select id, employment_id, change_kind, reason, recorded_at::text as recorded_at
          from employment_changes
         where org_id = ${orgId} and employment_id in (${subjectEmployments})
         order by recorded_at
      `)).rows;
      payload.exitRecords = (await db.execute<Record<string, unknown>>(sql`
        select id, employment_id, reason_kind, is_voluntary, is_regrettable,
               would_rehire, interview_held_on::text as interview_held_on,
               interviewer_party_id, destination, notes, recorded_at::text as recorded_at
          from hrm_exit_records
         where org_id = ${orgId} and employment_id in (${subjectEmployments})
         order by recorded_at
      `)).rows;
      payload.complianceFindings = (await db.execute<Record<string, unknown>>(sql`
        select id, employment_id, kind, project_id, worked_on::text as worked_on,
               detail, status, resolved_reason, recorded_at::text as recorded_at
          from hrm_compliance_findings
         where org_id = ${orgId} and employment_id in (${subjectEmployments})
         order by recorded_at
      `)).rows;
      payload.employmentClassifications = (await db.execute<Record<string, unknown>>(sql`
        select id, employment_id, classification_id, effective_from::text as effective_from,
               effective_to::text as effective_to
          from hrm_employment_classifications
         where org_id = ${orgId} and employment_id in (${subjectEmployments})
         order by effective_from
      `)).rows;
      payload.processes = (await db.execute<Record<string, unknown>>(sql`
        select id, employment_id, kind, effective_date::text as effective_date,
               status, cancel_reason, completed_at::text as completed_at
          from hrm_processes
         where org_id = ${orgId} and employment_id in (${subjectEmployments})
         order by effective_date
      `)).rows;
    });

    await gather("change_requests", async () => {
      payload.changeRequests = (await db.execute<Record<string, unknown>>(sql`
        select r.id, r.employment_id, r.status, r.reason,
               r.submitted_by, r.created_at::text as created_at
          from hrm_employment_change_requests r
         where r.org_id = ${orgId} and r.employment_id in (
           select id from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}
         )
         order by r.created_at
      `)).rows;
    });

    await gather("leave", async () => {
      payload.leaveRequests = (await db.execute<Record<string, unknown>>(sql`
        select r.id, r.employment_id, r.status, r.starts_on::text as starts_on,
               r.ends_on::text as ends_on, r.created_at::text as created_at
          from hrm_leave_requests r
         where r.org_id = ${orgId} and r.employment_id in (
           select id from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}
         )
         order by r.starts_on
      `)).rows;
      payload.absences = (await db.execute<Record<string, unknown>>(sql`
        select a.id, a.leave_request_id, a.employment_id, a.on_date::text as on_date,
               a.hours, a.leave_type_id, a.source
          from hrm_absences a
         where a.org_id = ${orgId} and a.employment_id in (
           select id from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}
         )
         order by a.on_date
      `)).rows;
    });

    await gather("time", async () => {
      // Keyset-paginated (worked_on, id): a bare LIMIT would silently
      // truncate a long-serving worker's history while the export still
      // reports ready. Pages of 1000 keep each statement bounded no
      // matter how many decades the history spans.
      type TimeRow = { id: string; worked_on: string };
      const timeEntries: Record<string, unknown>[] = [];
      let lastWorkedOn: string | null = null;
      let lastId: string | null = null;
      for (;;) {
        const page: (Record<string, unknown> & TimeRow)[] = (await db.execute<Record<string, unknown> & TimeRow>(sql`
          select id, worked_on::text as worked_on, hours, status, project_id
            from time_entries
           where org_id = ${orgId} and employee_party_id = ${partyId}
             and (${lastWorkedOn}::date is null
                  or (worked_on, id) > (${lastWorkedOn}::date, ${lastId}::uuid))
           order by worked_on, id
           limit 1000
        `)).rows;
        timeEntries.push(...page);
        if (page.length < 1000) break;
        lastWorkedOn = page[page.length - 1]!.worked_on;
        lastId = page[page.length - 1]!.id;
      }
      payload.timeEntries = timeEntries;
    });

    await gather("reviews", async () => {
      // Only reviews the person may see: shared/acknowledged reviews of
      // them, plus reviews they authored. Drafts and pending peer reviews
      // stay out — an export never leaks an unfinished assessment.
      const reviews = (await db.execute<Record<string, unknown> & { id: string }>(sql`
        select id, cycle_id, kind, status, submitted_at::text as submitted_at
          from hrm_reviews
         where org_id = ${orgId}
           and ((subject_party_id = ${partyId} and status in ('shared', 'acknowledged'))
                or reviewer_party_id = ${partyId})
         order by submitted_at nulls last
      `)).rows;
      payload.reviews = reviews;
      const reviewIds = reviews.map((r) => r.id);
      payload.reviewAnswers = reviewIds.length
        ? (await db.execute<Record<string, unknown>>(sql`
            select id, review_id, section_title, question_prompt, position,
                   answer_kind, rating, text
              from hrm_review_answers
             where org_id = ${orgId} and review_id in (${sql.join(
               reviewIds.map((id) => sql`${id}`),
               sql`, `,
             )})
             order by review_id, position
          `)).rows
        : [];
      payload.goals = (await db.execute<Record<string, unknown> & { id: string }>(sql`
        select g.id, g.employment_id, g.title, g.description, g.due_on::text as due_on,
               g.weight, g.status, g.progress_percent
          from hrm_goals g
         where g.org_id = ${orgId} and g.employment_id in (
           select id from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}
         )
         order by g.due_on nulls last
      `)).rows;
      const goalIds = (payload.goals as ({ id: string })[]).map((g) => g.id);
      payload.goalUpdates = goalIds.length
        ? (await db.execute<Record<string, unknown>>(sql`
            select id, goal_id, progress_percent, note, recorded_at::text as recorded_at
              from hrm_goal_updates
             where org_id = ${orgId} and goal_id in (${sql.join(
               goalIds.map((id) => sql`${id}`),
               sql`, `,
             )})
             order by recorded_at
          `)).rows
        : [];
      payload.successionCandidates = (await db.execute<Record<string, unknown>>(sql`
        select id, plan_id, employment_id, readiness, candidate_order, notes
          from hrm_succession_candidates
         where org_id = ${orgId} and employment_id in (
           select id from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}
         )
         order by candidate_order
      `)).rows;
      payload.talentReviews = (await db.execute<Record<string, unknown>>(sql`
        select id, employment_id, cycle_id, performance_key, potential_key,
               impact_of_loss, risk_of_loss, promotion_ready, notes,
               reviewed_at::text as reviewed_at
          from hrm_talent_reviews
         where org_id = ${orgId} and employment_id in (
           select id from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}
         )
         order by reviewed_at nulls last
      `)).rows;
    });

    await gather("benefits", async () => {
      payload.benefitEnrollments = (await db.execute<Record<string, unknown>>(sql`
        select e.id, e.plan_id, e.status, e.effective_from::text as effective_from,
               e.effective_to::text as effective_to
          from hrm_benefit_enrollments e
         where e.org_id = ${orgId} and e.employment_id in (
           select id from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}
         )
         order by e.effective_from
      `)).rows;
      // Dependents are third parties, but their records live on the
      // subject's employment file — the export carries them as part of
      // that file, like any other HR record about the subject's account.
      payload.benefitDependents = (await db.execute<Record<string, unknown>>(sql`
        select d.id, d.employment_id, d.relationship, d.display_name,
               d.birth_date::text as birth_date, d.is_active
          from hrm_benefit_dependents d
         where d.org_id = ${orgId} and d.employment_id in (
           select id from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}
         )
         order by d.display_name
      `)).rows;
    });

    // Omission evidence for the manifest: every requested document whose
    // bytes cannot be retrieved is named here with its reason. A non-empty
    // list marks the documents module — and the whole export — 'incomplete',
    // never 'ready': a subject-access export presented as complete while
    // files are missing is a completeness lie, and the legal property that
    // matters is whether the requester got everything.
    const omittedDocuments: { id: string; title: string; reason: string }[] = [];
    await gather("documents", async () => {
      const docs = (await db.execute<{
        id: string;
        title: string;
        status: string;
        file_id: string | null;
        completed_at: string | null;
      }>(sql`
        select id, title, status, file_id, completed_at::text as completed_at
          from hrm_documents
         where org_id = ${orgId} and party_id = ${partyId} and status != 'deleted'
         order by created_at
      `)).rows;
      payload.documents = docs.map((d) => ({
        id: d.id,
        title: d.title,
        status: d.status,
        completedAt: d.completed_at,
      }));
      let n = 0;
      for (const doc of docs) {
        if (!doc.file_id) {
          omittedDocuments.push({
            id: doc.id,
            title: doc.title,
            reason: "the document has no cabinet file — nothing was ever stored to export",
          });
          continue;
        }
        const blob = (await db.execute<{ storage_kind: string; bytes: Buffer | null }>(sql`
          select v.storage_kind, b.bytes
            from files f
            join file_versions v on v.id = f.current_version_id
            left join file_blobs b on b.version_id = v.id
           where f.id = ${doc.file_id} and f.org_id = ${orgId}
        `)).rows[0];
        // A masked-clone tombstone refuses by name: a subject-access export
        // must never silently omit the file (that would certify a complete
        // export that is missing documents).
        if (blob) refuseMaskedStorageKind(blob.storage_kind);
        // Missing bytes are NEVER silently skipped: the file row exists but
        // the version/blob join finds nothing (purged, orphaned, or never
        // stored). Record the omission and keep the export auditable.
        if (!blob?.bytes) {
          omittedDocuments.push({
            id: doc.id,
            title: doc.title,
            reason: "the cabinet file's bytes are missing — the file record exists but no retrievable bytes remain",
          });
          continue;
        }
        n += 1;
        entries.push({
          name: `documents/${String(n).padStart(2, "0")}-${doc.title.replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "document"}.pdf`,
          data: blob.bytes as Buffer,
        });
      }
      payload.omittedDocuments = omittedDocuments;
    });
    if (omittedDocuments.length > 0) {
      const entry = included.find((s) => s.module === "documents");
      const detail =
        `${omittedDocuments.length} document file(s) unavailable: ` +
        omittedDocuments.map((o) => `${o.title} (${o.id}): ${o.reason}`).join("; ");
      // A failed gather keeps its failure (the error is the story there);
      // omissions downgrade a SUCCESSFUL gather from included to incomplete.
      if (entry && entry.status === "included") {
        entry.status = "incomplete";
        entry.detail = detail;
      } else if (!entry) {
        included.push({ module: "documents", status: "incomplete", detail });
      }
    }
    const exportIncomplete = included.some((s) => s.status === "incomplete");
    await gather("payroll", async () => {
      // The persisted stub records (snapshots at calculate time — the
      // payroll read seam), never live re-resolution. Stubs paginate by
      // (pay_date, id) and lines fetch per stub chunk: a lifetime of pay
      // history has no bound, and one giant IN list would blow the
      // statement past the parameter limit while a bare query would hold
      // the whole history in one statement either way.
      type StubRow = {
        id: string;
        pay_date: string;
        tax_year: number;
        gross: string;
        net_pay: string;
        currency: string;
      };
      const stubs: StubRow[] = [];
      let lastPayDate: string | null = null;
      let lastStubId: string | null = null;
      for (;;) {
        const page: StubRow[] = (await db.execute<StubRow>(sql`
          select id, pay_date::text as pay_date, tax_year, gross::text as gross,
                 net_pay::text as net_pay, currency_code as currency
            from pay_stubs
           where org_id = ${orgId} and employee_party_id = ${partyId}
             and (${lastPayDate}::date is null
                  or (pay_date, id) > (${lastPayDate}::date, ${lastStubId}::uuid))
           order by pay_date, id
           limit 500
        `)).rows;
        stubs.push(...page);
        if (page.length < 500) break;
        lastPayDate = page[page.length - 1]!.pay_date;
        lastStubId = page[page.length - 1]!.id;
      }
      payload.payStubs = stubs;
      // Chunks follow stub order and each chunk orders by stub_id, so the
      // concatenated lines keep the old global stub_id order.
      const lines: Record<string, unknown>[] = [];
      for (let at = 0; at < stubs.length; at += 500) {
        const chunk = stubs.slice(at, at + 500);
        lines.push(...(await db.execute<Record<string, unknown>>(sql`
          select stub_id, description, kind, amount::text as amount
            from pay_stub_lines
           where stub_id in (${sql.join(chunk.map((s) => sql`${s.id}`), sql`, `)})
           order by stub_id
        `)).rows);
      }
      payload.payStubLines = lines;
      // Pay inputs about the subject's employments: allowances, benefit
      // deductions and payroll inputs awaiting (or consumed by) a run, plus
      // per-diem and travel entries. Same subject link as the stubs.
      const subjectPartyEmployments = sql`select id from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}`;
      payload.allowancePayrollInputs = (await db.execute<Record<string, unknown>>(sql`
        select id, employment_id, entry_kind, amount::text as amount, currency,
               coverage_date::text as coverage_date, status
          from hrm_allowance_payroll_inputs
         where org_id = ${orgId} and employment_id in (${subjectPartyEmployments})
         order by coverage_date
      `)).rows;
      payload.benefitPayrollInputs = (await db.execute<Record<string, unknown>>(sql`
        select id, employment_id, kind, amount::text as amount, currency,
               coverage_from::text as coverage_from, coverage_to::text as coverage_to, status
          from hrm_benefit_payroll_inputs
         where org_id = ${orgId} and employment_id in (${subjectPartyEmployments})
         order by coverage_from
      `)).rows;
      payload.payrollInputs = (await db.execute<Record<string, unknown>>(sql`
        select id, employment_id, kind, absence_date::text as absence_date,
               hours, status
          from hrm_payroll_inputs
         where org_id = ${orgId} and employment_id in (${subjectPartyEmployments})
         order by absence_date nulls last
      `)).rows;
      payload.perDiemEntries = (await db.execute<Record<string, unknown>>(sql`
        select id, employment_id, worked_on::text as worked_on, amount::text as amount,
               currency, status
          from hrm_per_diem_entries
         where org_id = ${orgId} and employment_id in (${subjectPartyEmployments})
         order by worked_on
      `)).rows;
      payload.travelPayEntries = (await db.execute<Record<string, unknown>>(sql`
        select id, employment_id, worked_on::text as worked_on, amount::text as amount,
               currency, status
          from hrm_travel_pay_entries
         where org_id = ${orgId} and employment_id in (${subjectPartyEmployments})
         order by worked_on
      `)).rows;
    });

    // Omission evidence for export-referenced files beyond documents:
    // statement PDFs, qualification evidence and clock photos are the
    // subject's records too — a missing file marks the export incomplete
    // with its reason, never a silent gap.
    const omittedStatements: { id: string; title: string; reason: string }[] = [];
    const omittedQualificationFiles: { id: string; title: string; reason: string }[] = [];
    const omittedClockPhotos: { id: string; title: string; reason: string }[] = [];
    const markIncompleteOnOmissions = (
      module: string,
      omitted: { id: string; title: string; reason: string }[],
    ) => {
      if (omitted.length === 0) return;
      const entry = included.find((s) => s.module === module);
      const detail =
        `${omitted.length} file(s) unavailable: ` +
        omitted.map((o) => `${o.title} (${o.id}): ${o.reason}`).join("; ");
      if (entry && entry.status === "included") {
        entry.status = "incomplete";
        entry.detail = detail;
      } else if (!entry) {
        included.push({ module, status: "incomplete", detail });
      }
    };

    await gather("recruiting", async () => {
      // Candidates are the subject link (party_id); external candidates
      // without a party are nobody's DSAR subject and stay out. Scorecards
      // gather both ways: assessments OF the subject's interviews, and
      // assessments the subject authored as interviewer — mirroring the
      // reviews module's subject-or-author rule.
      const candidates = (await db.execute<Record<string, unknown> & { id: string }>(sql`
        select id, display_name, email, phone, source, source_detail,
               consent_recorded_at::text as consent_recorded_at, is_internal,
               notes, created_at::text as created_at
          from hrm_candidates
         where org_id = ${orgId} and party_id = ${partyId}
         order by created_at
      `)).rows;
      payload.candidates = candidates;
      const candidateIds = candidates.map((c) => c.id);
      payload.candidateConsents = candidateIds.length
        ? (await db.execute<Record<string, unknown>>(sql`
            select id, candidate_id, purpose, granted_at::text as granted_at,
                   expires_at::text as expires_at, withdrawn_at::text as withdrawn_at, source
              from hrm_candidate_consents
             where org_id = ${orgId} and candidate_id in (${sql.join(
               candidateIds.map((id) => sql`${id}`),
               sql`, `,
             )})
             order by granted_at
          `)).rows
        : [];
      const applications = candidateIds.length
        ? (await db.execute<Record<string, unknown> & { id: string }>(sql`
            select id, requisition_id, candidate_id, stage_id, status,
                   applied_on::text as applied_on, rejected_reason,
                   withdrawn_at::text as withdrawn_at, hired_employment_id
              from hrm_applications
             where org_id = ${orgId} and candidate_id in (${sql.join(
               candidateIds.map((id) => sql`${id}`),
               sql`, `,
             )})
             order by applied_on
          `)).rows
        : [];
      payload.applications = applications;
      const applicationIds = applications.map((a) => a.id);
      payload.applicationEvents = applicationIds.length
        ? (await db.execute<Record<string, unknown>>(sql`
            select id, application_id, kind, reason, recorded_at::text as recorded_at
              from hrm_application_events
             where org_id = ${orgId} and application_id in (${sql.join(
               applicationIds.map((id) => sql`${id}`),
               sql`, `,
             )})
             order by recorded_at
          `)).rows
        : [];
      const interviews = applicationIds.length
        ? (await db.execute<Record<string, unknown> & { id: string }>(sql`
            select id, application_id, kind, scheduled_at::text as scheduled_at,
                   location, status, outcome, feedback, scorecard,
                   completed_at::text as completed_at
              from hrm_interviews
             where org_id = ${orgId} and application_id in (${sql.join(
               applicationIds.map((id) => sql`${id}`),
               sql`, `,
             )})
             order by scheduled_at
          `)).rows
        : [];
      payload.interviews = interviews;
      const interviewIds = interviews.map((i) => i.id);
      const scorecards = (await db.execute<Record<string, unknown> & { id: string }>(sql`
        select id, interview_id, interviewer_party_id, overall,
               submitted_at::text as submitted_at, private_notes, shared_notes
          from hrm_scorecards
         where org_id = ${orgId}
           and (${interviewIds.length
             ? sql`interview_id in (${sql.join(
               interviewIds.map((id) => sql`${id}`),
               sql`, `,
             )})`
             : sql`false`}
               or interviewer_party_id = ${partyId})
         order by submitted_at nulls last
      `)).rows;
      payload.scorecards = scorecards;
      const scorecardIds = scorecards.map((s) => s.id);
      payload.scorecardRatings = scorecardIds.length
        ? (await db.execute<Record<string, unknown>>(sql`
            select id, scorecard_id, attribute_id, rating_key, note
              from hrm_scorecard_ratings
             where org_id = ${orgId} and scorecard_id in (${sql.join(
               scorecardIds.map((id) => sql`${id}`),
               sql`, `,
             )})
             order by scorecard_id
          `)).rows
        : [];
      const offers = applicationIds.length
        ? (await db.execute<Record<string, unknown> & { id: string }>(sql`
            select id, application_id, job_title, proposed_start_on::text as proposed_start_on,
                   compensation_amount::text as compensation_amount, compensation_currency,
                   status, sent_at::text as sent_at, decline_reason
              from hrm_offers
             where org_id = ${orgId} and application_id in (${sql.join(
               applicationIds.map((id) => sql`${id}`),
               sql`, `,
             )})
             order by sent_at nulls last
          `)).rows
        : [];
      payload.offers = offers;
      const offerIds = offers.map((o) => o.id);
      payload.offerVersions = offerIds.length
        ? (await db.execute<Record<string, unknown>>(sql`
            select id, offer_id, version, payload
              from hrm_offer_versions
             where org_id = ${orgId} and offer_id in (${sql.join(
               offerIds.map((id) => sql`${id}`),
               sql`, `,
             )})
             order by version
          `)).rows
        : [];
      payload.talentPoolMembers = candidateIds.length
        ? (await db.execute<Record<string, unknown>>(sql`
            select id, pool_id, candidate_id, added_at::text as added_at, note
              from hrm_talent_pool_members
             where org_id = ${orgId} and candidate_id in (${sql.join(
               candidateIds.map((id) => sql`${id}`),
               sql`, `,
             )})
             order by added_at
          `)).rows
        : [];
      payload.interviewPanel = (await db.execute<Record<string, unknown>>(sql`
        select id, interview_id, party_id
          from hrm_interview_panel
         where org_id = ${orgId}
           and (${interviewIds.length
             ? sql`interview_id in (${sql.join(
               interviewIds.map((id) => sql`${id}`),
               sql`, `,
             )})`
             : sql`false`}
               or party_id = ${partyId})
      `)).rows;
    });

    await gather("qualifications", async () => {
      const qualifications = (await db.execute<
        Record<string, unknown> & { id: string; evidence_file_id: string | null }
      >(sql`
        select id, employment_id, type_id, identifier, issued_on::text as issued_on,
               expires_on::text as expires_on, status, evidence_file_id,
               verified_at::text as verified_at, notes
          from hrm_worker_qualifications
         where org_id = ${orgId} and employment_id in (
           select id from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}
         )
         order by issued_on
      `)).rows;
      payload.qualifications = qualifications.map(({ evidence_file_id, ...rest }) => ({
        ...rest,
        hasEvidenceFile: evidence_file_id !== null,
      }));
      const qualificationIds = qualifications.map((q) => q.id);
      payload.qualificationEvents = qualificationIds.length
        ? (await db.execute<Record<string, unknown>>(sql`
            select id, qualification_id, kind, reason, recorded_at::text as recorded_at
              from hrm_qualification_events
             where org_id = ${orgId} and qualification_id in (${sql.join(
               qualificationIds.map((id) => sql`${id}`),
               sql`, `,
             )})
             order by recorded_at
          `)).rows
        : [];
      let n = 0;
      for (const q of qualifications) {
        const fileId = q.evidence_file_id;
        if (!fileId) continue;
        const fetched = await fetchExportFileBytes(orgId, fileId);
        if (!fetched) {
          omittedQualificationFiles.push({
            id: q.id,
            title: `qualification evidence ${q.id.slice(0, 8)}`,
            reason: "the cabinet file's bytes are missing — the file record exists but no retrievable bytes remain",
          });
          continue;
        }
        n += 1;
        entries.push({
          name: `qualifications/${String(n).padStart(2, "0")}-evidence-${q.id.slice(0, 8)}.${fetched.extension ?? "bin"}`,
          data: fetched.bytes,
        });
      }
    });

    await gather("statements", async () => {
      const statements = (await db.execute<
        Record<string, unknown> & { id: string; file_id: string | null; period_from: string }
      >(sql`
        select id, employment_id, cycle_id, period_from::text as period_from,
               period_to::text as period_to, payload, file_id,
               generated_at::text as generated_at
          from hrm_comp_statements
         where org_id = ${orgId} and employment_id in (
           select id from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}
         )
         order by period_from
      `)).rows;
      payload.compStatements = statements.map(({ file_id, ...rest }) => ({
        ...rest,
        hasFile: file_id !== null,
      }));
      payload.compCycleLines = (await db.execute<Record<string, unknown>>(sql`
        select id, cycle_id, employment_id, status
          from hrm_comp_cycle_lines
         where org_id = ${orgId} and employment_id in (
           select id from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}
         )
         order by cycle_id
      `)).rows;
      payload.payInformationRequests = (await db.execute<Record<string, unknown>>(sql`
        select id, employment_id
          from hrm_pay_information_requests
         where org_id = ${orgId} and employment_id in (
           select id from worker_employments where org_id = ${orgId} and worker_party_id = ${partyId}
         )
      `)).rows;
      let n = 0;
      for (const s of statements) {
        const fileId = s.file_id;
        if (!fileId) continue;
        const fetched = await fetchExportFileBytes(orgId, fileId);
        const period = s.period_from;
        if (!fetched) {
          omittedStatements.push({
            id: s.id,
            title: `compensation statement ${period}`,
            reason: "the cabinet file's bytes are missing — the file record exists but no retrievable bytes remain",
          });
          continue;
        }
        n += 1;
        entries.push({
          name: `statements/${String(n).padStart(2, "0")}-${period}-${s.id.slice(0, 8)}.${fetched.extension ?? "pdf"}`,
          data: fetched.bytes,
        });
      }
    });

    await gather("surveys", async () => {
      const invitations = (await db.execute<Record<string, unknown> & { survey_id: string }>(sql`
        select i.id, i.survey_id, s.name as survey_name,
               i.sent_at::text as sent_at, i.responded_at::text as responded_at
          from hrm_survey_invitations i
          join hrm_surveys s on s.org_id = i.org_id and s.id = i.survey_id
         where i.org_id = ${orgId} and i.party_id = ${partyId}
         order by i.sent_at
      `)).rows;
      payload.surveyInvitations = invitations;
      // Only attributable responses export: anonymous surveys store a NULL
      // link by design and stay out (counted, never decrypted). Anything
      // that no longer decrypts is unattributable and stays out too.
      const rows = (await db.execute<{
        id: string;
        survey_id: string;
        respondent_link_enc: Buffer | null;
        submitted_at: string;
        answers: unknown;
        segment_snapshot: unknown;
      }>(sql`
        select id, survey_id, respondent_link_enc, submitted_at::text as submitted_at,
               answers, segment_snapshot
          from hrm_survey_responses
         where org_id = ${orgId}
         order by submitted_at
      `)).rows;
      const mine: Record<string, unknown>[] = [];
      let anonymousSkipped = 0;
      for (const row of rows) {
        if (!row.respondent_link_enc) {
          anonymousSkipped += 1;
          continue;
        }
        let linkedParty: string | null = null;
        try {
          linkedParty = decryptRespondentLink(orgId, row.respondent_link_enc);
        } catch {
          linkedParty = null;
        }
        if (linkedParty !== partyId) continue;
        const { respondent_link_enc: _dropped, ...rest } = row;
        mine.push(rest);
      }
      payload.surveyResponses = mine;
      payload.surveyAnonymousSkipped = anonymousSkipped;
    });

    await gather("clock_events", async () => {
      const events = (await db.execute<
        Record<string, unknown> & { id: string; photo_file_id: string | null; occurred_at: string }
      >(sql`
        select id, kind, occurred_at::text as occurred_at, device_id, source,
               project_id, geo, geo_check, photo_file_id, status, void_reason
          from time_clock_events
         where org_id = ${orgId} and employee_party_id = ${partyId}
         order by occurred_at
      `)).rows;
      payload.clockEvents = events.map(({ photo_file_id, ...rest }) => ({
        ...rest,
        hasPhoto: photo_file_id !== null,
      }));
      let n = 0;
      for (const e of events) {
        const photoId = e.photo_file_id;
        if (!photoId) continue;
        const fetched = await fetchExportFileBytes(orgId, photoId);
        const when = e.occurred_at;
        if (!fetched) {
          omittedClockPhotos.push({
            id: e.id,
            title: `clock photo ${when}`,
            reason: "the cabinet file's bytes are missing — the file record exists but no retrievable bytes remain",
          });
          continue;
        }
        n += 1;
        entries.push({
          name: `clock-photos/${String(n).padStart(2, "0")}-${when.slice(0, 10)}-${e.id.slice(0, 8)}.${fetched.extension ?? "bin"}`,
          data: fetched.bytes,
        });
      }
    });

    await gather("exports", async () => {
      // The subject's own prior export ledger (metadata only, never file
      // bytes: the current export must not nest itself). The row being
      // built is excluded — it is still mid-build, not history.
      payload.priorExports = (await db.execute<Record<string, unknown>>(sql`
        select id, requested_at::text as requested_at, status, scope,
               completed_at::text as completed_at, error
          from hrm_data_subject_exports
         where org_id = ${orgId} and party_id = ${partyId} and id != ${exportId}
         order by requested_at
      `)).rows;
    });

    // Omission downgrades run after their gathers resolve, where the module
    // entries exist — mirroring the documents block above.
    markIncompleteOnOmissions("qualifications", omittedQualificationFiles);
    markIncompleteOnOmissions("statements", omittedStatements);
    markIncompleteOnOmissions("clock_events", omittedClockPhotos);

    // The manifest closes the completeness loop: every domain gathered
    // with its status, plus every explicitly excluded table with its
    // reviewed reason (dsar-coverage.ts). A reader can verify the export
    // covers the whole personal-data inventory without trusting the code.
    payload.manifest = dsarCoverageManifest(included);
    entries.unshift({ name: "export.json", data: Buffer.from(JSON.stringify(payload, null, 2), "utf8") });
    const zip = buildStoredZip(entries);
    const { fileId } = await storeCabinetFile(db, {
      orgId,
      recordTable: "hrm_data_subject_exports",
      recordId: exportId,
      groupLabel: "HR Data Exports",
      filename: `subject-access-export-${exportId.slice(0, 8)}.zip`,
      contentType: "application/zip",
      bytes: zip,
      createdBy: null,
      // Grant to the requester ONLY: the subject reads their export
      // through the download route, which re-checks subject-or-manage.
      viewerUserIds: [requesterId],
    });
    // Owner-gated: only the claim that built this zip may mark it done.
    // Zero matches means the claim lapsed mid-build and someone else took
    // over (or finished) — their outcome stands, and the fail path below
    // matches nothing either, so this attempt dissolves instead of failing
    // the winner. The freshly stored zip is then unreferenced cabinet bytes
    // under the export's folder rather than anyone's download — refused
    // rather than orphaned into the wrong hands.
    // Completeness: an export with omitted document bytes is marked
    // 'incomplete', never 'ready' — the scope manifest and export.json name
    // every omission, and the UI/API show the incomplete status distinctly.
    const terminalStatus = exportIncomplete ? "incomplete" : "ready";
    const marked = (await db.execute<{ n: string }>(sql`
      update hrm_data_subject_exports
         set status = ${terminalStatus}, file_id = ${fileId}, scope = ${JSON.stringify(included)}::jsonb,
             completed_at = now(), updated_at = now()
       where org_id = ${orgId} and id = ${exportId}
         and status = 'building' and claimed_by = ${owner}
      returning 1
    `)).rows.length;
    if (marked === 0) {
      throw new HrmDocumentsError(
        "REFUSED",
        "the export claim lapsed while building — the ready mark matched no row, so the zip is refused rather than orphaned",
      );
    }
  }).catch(async (e) => {
    await withOrgTransaction(orgId, async () => {
      await failExport(db, orgId, exportId, owner, describeExportError(e));
    });
  });
}

/** Root-cause-first error rendering: the driver wraps Postgres errors in
 * a Failed-query shell naming the statement, so the stored error walks
 * the cause chain to the violation that actually refused the write. */
export function describeExportError(e: unknown): string {
  const parts: string[] = [];
  let cursor: unknown = e;
  while (cursor instanceof Error && parts.length < 5) {
    parts.push(cursor.message);
    const cause = (cursor as { cause?: unknown }).cause;
    cursor = cause instanceof Error ? cause : cause !== undefined && cause !== null ? new Error(String(cause)) : null;
  }
  if (parts.length === 0) return String(e);
  return parts.join(" | caused by ");
}

/**
 * Drain the org's queue (worker duty hrm-dsar-exports, oldest first). Each
 * iteration holds a durable claim before building, so N concurrent drains
 * build N different exports — never the same one twice.
 */
export async function drainExportQueue(orgId: string, limit = 5): Promise<number> {
  let done = 0;
  for (let i = 0; i < limit; i++) {
    const claimed = await withOrgTransaction(orgId, () => claimQueuedExport(db, orgId));
    if (!claimed) break;
    await buildExport(orgId, claimed.id, { owner: claimed.claimedBy });
    done += 1;
  }
  return done;
}

/**
 * Download a finished export (subject or manage). Ready flips to delivered
 * on download; incomplete STAYS incomplete — flipping it would erase the
 * distinct partial status the requester must keep seeing.
 */
export async function downloadExport(query: {
  orgId: string;
  actorId: string;
  exportId: string;
}): Promise<{ bytes: Buffer; filename: string }> {
  return withOrgTransaction(query.orgId, async () => {
    const row = (await db.execute<ExportRow>(sql`
      ${EXPORT_COLS} where org_id = ${query.orgId} and id = ${query.exportId}
    `)).rows[0];
    if (!row) throw new HrmDocumentsError("NOT_FOUND", "export request is not visible in this organization");
    if (row.status !== "ready" && row.status !== "incomplete" && row.status !== "delivered") {
      throw new HrmDocumentsError(
        "REFUSED",
        `this export is ${row.status} — download opens once it is ready`,
      );
    }
    const manages = await actorHasPermission(db, query.orgId, query.actorId, "hrm.documents.manage");
    if (!manages) {
      const own = (await db.execute<{ partyId: string | null }>(sql`
        select party_id as "partyId" from users where org_id = ${query.orgId} and id = ${query.actorId}
      `)).rows[0]?.partyId;
      if (own !== row.party_id) {
        throw new HrmDocumentsError(
          "FORBIDDEN",
          "this export belongs to someone else — ask HR for access instead",
        );
      }
    }
    // A ready ZIP for an out-of-scope subject is indistinguishable from a
    // missing one — and it is never marked delivered on a refused read.
    await requirePartyInScope(db, query.orgId, query.actorId, row.party_id);
    if (!row.file_id) throw new HrmDocumentsError("NOT_FOUND", "this export has no file yet");
    const blob = (await db.execute<{ storage_kind: string; bytes: Buffer | null }>(sql`
      select v.storage_kind, b.bytes
        from files f
        join file_versions v on v.id = f.current_version_id
        left join file_blobs b on b.version_id = v.id
       where f.id = ${row.file_id} and f.org_id = ${query.orgId}
    `)).rows[0];
    if (!blob) throw new HrmDocumentsError("NOT_FOUND", "the export file is missing from the cabinet");
    // Masked-clone tombstone: refuse by name (mapped to 403 downstream),
    // never as a missing file or a bare 500.
    refuseMaskedStorageKind(blob.storage_kind);
    if (!blob.bytes) throw new HrmDocumentsError("NOT_FOUND", "the export file is missing from the cabinet");
    if (row.status === "ready") {
      await db.execute(sql`
        update hrm_data_subject_exports set status = 'delivered', updated_at = now()
         where org_id = ${query.orgId} and id = ${query.exportId} and status = 'ready'
      `);
    }
    return { bytes: blob.bytes as Buffer, filename: `subject-access-export-${row.id.slice(0, 8)}.zip` };
  });
}
