import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { requireHrmDocumentsManage, requireHrmDocumentsRead } from "../authorization.ts";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { HrmDocumentsError } from "./errors.ts";
import { storeCabinetFile } from "./cabinet.ts";
import { buildStoredZip, type ZipEntry } from "./zip-store.ts";

/**
 * HR-19 data-subject (DSAR) exports.
 *
 * requestExport refuses when the requester lacks hrm.documents.manage
 * AND is not the subject (the party behind their login) — fail closed by
 * name, never an empty zip. The worker duty hrm-dsar-exports drains the
 * queue through buildExport: one transaction gathers the person's party
 * record, employments and versions, change requests, leave, time entries,
 * the reviews they may see, benefits, HR documents with file bytes, and
 * payroll pay stubs with lines (the persisted historical records —
 * snapshots, never live re-resolution), writes export.json plus the
 * files into a stored zip in the File Cabinet with a viewer grant to the
 * requester ONLY, and marks the row ready. A module that throws is
 * recorded in scope as failed with its reason — the export stays
 * auditable instead of silently partial. delivered flips on download.
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
  await requireHrmDocumentsRead(db, query.orgId, query.actorId);
  const rows = (await db.execute<ExportRow>(sql`
    ${EXPORT_COLS}
     where org_id = ${query.orgId}
       ${query.partyId ? sql`and party_id = ${query.partyId}` : sql``}
     order by requested_at desc
     limit 100
  `)).rows;
  return rows.map(toDTO);
}

/** Next queued export for the worker (one claim per call, oldest first). */
export async function claimQueuedExport(
  exec: SqlExecutor,
  orgId: string,
): Promise<ExportRow | null> {
  const row = (await exec.execute<ExportRow>(sql`
    select id, party_id, requested_by, requested_at::text as requested_at, status,
           file_id, scope, completed_at::text as completed_at, error
      from hrm_data_subject_exports
     where org_id = ${orgId} and status = 'queued'
     order by requested_at
     limit 1
     for update skip locked
  `)).rows[0];
  return row ?? null;
}

async function failExport(
  exec: SqlExecutor,
  orgId: string,
  exportId: string,
  error: string,
): Promise<void> {
  await exec.execute(sql`
    update hrm_data_subject_exports
       set status = 'failed', error = ${error}, completed_at = now(), updated_at = now()
     where org_id = ${orgId} and id = ${exportId}
  `);
}

/**
 * Build one queued export: gather every module, zip, store with a
 * requester-only grant, mark ready. Throws nothing — failure marks the
 * row failed with the reason.
 */
export async function buildExport(orgId: string, exportId: string): Promise<void> {
  await withOrgTransaction(orgId, async () => {
    const row = (await db.execute<ExportRow>(sql`
      ${EXPORT_COLS} where org_id = ${orgId} and id = ${exportId}
    `)).rows[0];
    if (!row) {
      throw new HrmDocumentsError("NOT_FOUND", "export request is not visible in this organization");
    }
    if (row.status !== "queued") return;
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
    });

    await gather("time", async () => {
      payload.timeEntries = (await db.execute<Record<string, unknown>>(sql`
        select id, worked_on::text as worked_on, hours, status, project_id
          from time_entries
         where org_id = ${orgId} and employee_party_id = ${partyId}
         order by worked_on
         limit 2000
      `)).rows;
    });

    await gather("reviews", async () => {
      // Only reviews the person may see: shared/acknowledged reviews of
      // them, plus reviews they authored. Drafts and pending peer reviews
      // stay out — an export never leaks an unfinished assessment.
      payload.reviews = (await db.execute<Record<string, unknown>>(sql`
        select id, cycle_id, kind, status, submitted_at::text as submitted_at
          from hrm_reviews
         where org_id = ${orgId}
           and ((subject_party_id = ${partyId} and status in ('shared', 'acknowledged'))
                or reviewer_party_id = ${partyId})
         order by submitted_at nulls last
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
    });

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
        if (!doc.file_id) continue;
        const blob = (await db.execute<{ bytes: Buffer }>(sql`
          select b.bytes
            from files f
            join file_versions v on v.id = f.current_version_id
            join file_blobs b on b.version_id = v.id
           where f.id = ${doc.file_id} and f.org_id = ${orgId}
        `)).rows[0];
        if (!blob) continue;
        n += 1;
        entries.push({
          name: `documents/${String(n).padStart(2, "0")}-${doc.title.replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "document"}.pdf`,
          data: blob.bytes as Buffer,
        });
      }
    });

    await gather("payroll", async () => {
      // The persisted stub records (snapshots at calculate time — the
      // payroll read seam), never live re-resolution.
      const stubs = (await db.execute<{
        id: string;
        pay_date: string;
        tax_year: number;
        gross: string;
        net_pay: string;
        currency: string;
      }>(sql`
        select id, pay_date::text as pay_date, tax_year, gross::text as gross,
               net_pay::text as net_pay, currency_code as currency
          from pay_stubs
         where org_id = ${orgId} and employee_party_id = ${partyId}
         order by pay_date
      `)).rows;
      payload.payStubs = stubs;
      const lines = stubs.length
        ? (await db.execute<Record<string, unknown>>(sql`
            select stub_id, description, kind, amount::text as amount
              from pay_stub_lines
             where stub_id in (${sql.join(stubs.map((s) => sql`${s.id}`), sql`, `)})
             order by stub_id
          `)).rows
        : [];
      payload.payStubLines = lines;
    });

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
    const marked = (await db.execute<{ n: string }>(sql`
      update hrm_data_subject_exports
         set status = 'ready', file_id = ${fileId}, scope = ${JSON.stringify(included)}::jsonb,
             completed_at = now(), updated_at = now()
       where org_id = ${orgId} and id = ${exportId} and status = 'queued'
      returning 1
    `)).rows.length;
    if (marked === 0) {
      throw new HrmDocumentsError(
        "REFUSED",
        "the export left the queue while building — the ready mark matched no row, so the zip is refused rather than orphaned",
      );
    }
  }).catch(async (e) => {
    await withOrgTransaction(orgId, async () => {
      await failExport(db, orgId, exportId, describeExportError(e));
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

/** Drain the org's queue (worker duty hrm-dsar-exports, oldest first). */
export async function drainExportQueue(orgId: string, limit = 5): Promise<number> {
  let done = 0;
  for (let i = 0; i < limit; i++) {
    const claimed = await withOrgTransaction(orgId, () => claimQueuedExport(db, orgId));
    if (!claimed) break;
    await buildExport(orgId, claimed.id);
    done += 1;
  }
  return done;
}

/** Download a ready export (subject or manage) — flips ready to delivered. */
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
    if (row.status !== "ready" && row.status !== "delivered") {
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
    if (!row.file_id) throw new HrmDocumentsError("NOT_FOUND", "this export has no file yet");
    const blob = (await db.execute<{ bytes: Buffer }>(sql`
      select b.bytes
        from files f
        join file_versions v on v.id = f.current_version_id
        join file_blobs b on b.version_id = v.id
       where f.id = ${row.file_id} and f.org_id = ${query.orgId}
    `)).rows[0];
    if (!blob) throw new HrmDocumentsError("NOT_FOUND", "the export file is missing from the cabinet");
    if (row.status === "ready") {
      await db.execute(sql`
        update hrm_data_subject_exports set status = 'delivered', updated_at = now()
         where org_id = ${query.orgId} and id = ${query.exportId} and status = 'ready'
      `);
    }
    return { bytes: blob.bytes as Buffer, filename: `subject-access-export-${row.id.slice(0, 8)}.zip` };
  });
}
