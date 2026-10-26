import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { requireHrmEmploymentManage } from "./authorization.ts";
import { insertEmploymentChange } from "./change-requests.ts";

export class EmploymentStartCorrectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmploymentStartCorrectionError";
  }
}

export interface EmploymentStartCorrection {
  readonly employmentId: string;
  readonly previousStart: string;
  readonly correctedStart: string;
  readonly changeId: string;
}

type LiveVersion = {
  id: string;
  version_no: number;
  status: string;
  effective_from: string;
  effective_to: string | null;
  before: unknown;
};

/**
 * Correct an employment's recorded start date when it was entered wrongly.
 *
 * Forward-dated hire, status and assignment changes cannot fix a wrong first
 * day: they add history after it. This records a correction instead — the
 * first employment interval, the assignment intervals that began with it,
 * the employee record's hire date and a service start that matched it all
 * move to the corrected day — as one audited 'corrected' employment event
 * whose closed versions keep the before-images.
 *
 * A start may not move past the end of the first interval (correct the later
 * history first), and may not move after the end of a pay period this
 * employee was already paid for in a committed run (void that run first).
 */
export async function correctEmploymentStart(input: {
  orgId: string;
  actorId: string;
  employmentId: string;
  correctedStart: string;
  reason: string;
}): Promise<EmploymentStartCorrection> {
  const reason = input.reason.trim();
  if (!isIsoCalendarDate(input.correctedStart)) {
    throw new EmploymentStartCorrectionError(
      "Enter the corrected start as a real calendar date (YYYY-MM-DD).",
    );
  }
  if (reason.length < 10 || reason.length > 500) {
    throw new EmploymentStartCorrectionError(
      "Record why the start date is wrong in 10-500 characters.",
    );
  }
  return withOrgTransaction(input.orgId, async () => {
    const exec: SqlExecutor = db;
    await requireHrmEmploymentManage(exec, input.orgId, input.actorId, input.employmentId);
    const employment = (
      await exec.execute<{
        revision: number;
        worker_party_id: string;
        service_start: string | null;
      }>(
        sql`
      select revision, worker_party_id::text as worker_party_id, service_start::text as service_start
        from worker_employments
       where org_id = ${input.orgId} and id = ${input.employmentId}
       for update
    `,
        "objects",
      )
    )[0];
    if (!employment)
      throw new EmploymentStartCorrectionError(
        "The employment was not found in this organization.",
      );

    const live = await exec.execute<LiveVersion>(
      sql`
      select id, version_no, status, effective_from::text as effective_from,
             effective_to::text as effective_to, to_jsonb(worker_employment_versions) as before
        from worker_employment_versions
       where org_id = ${input.orgId} and employment_id = ${input.employmentId} and recorded_until is null
       order by effective_from, version_no
    `,
      "objects",
    );
    const first = live[0];
    if (!first || first.status === "terminated") {
      throw new EmploymentStartCorrectionError("This employment has no recorded start to correct.");
    }
    const previousStart = first.effective_from;
    const corrected = input.correctedStart;
    if (corrected === previousStart) {
      throw new EmploymentStartCorrectionError(
        `The employment already starts on ${previousStart}.`,
      );
    }
    if (first.effective_to !== null && corrected >= first.effective_to) {
      throw new EmploymentStartCorrectionError(
        `The corrected start must fall before ${first.effective_to}, when the first employment interval ends; correct the later history first.`,
      );
    }
    if (corrected > previousStart) {
      const paid = await exec.execute<{ number: string | null; period_end: string }>(
        sql`
        select d.document_number as number, r.period_end::text as period_end
          from pay_runs r
          join documents d on d.org_id = r.org_id and d.id = r.document_id
         where r.org_id = ${input.orgId} and r.run_status = 'committed'
           and r.period_end < ${corrected}::date
           and exists (select 1 from pay_stubs s
                        where s.org_id = r.org_id and s.pay_run_document_id = r.document_id
                          and s.employee_party_id = ${employment.worker_party_id})
         order by r.period_end
         limit 5
      `,
        "objects",
      );
      if (paid.length > 0) {
        throw new EmploymentStartCorrectionError(
          `Committed pay runs already paid this employee before ${corrected}: ` +
            paid
              .map((run) => `${run.number ?? "pay run"} (period ending ${run.period_end})`)
              .join(", ") +
            ". Void those runs first, or keep the recorded start.",
        );
      }
    }

    const assignments = await exec.execute<LiveVersion & { assignment_id: string }>(
      sql`
      select id, assignment_id::text as assignment_id, version_no, 'assignment' as status,
             effective_from::text as effective_from, effective_to::text as effective_to,
             to_jsonb(employment_assignment_versions) as before
        from employment_assignment_versions
       where org_id = ${input.orgId} and employment_id = ${input.employmentId}
         and recorded_until is null and effective_from = ${previousStart}::date
    `,
      "objects",
    );
    for (const assignment of assignments) {
      if (assignment.effective_to !== null && corrected >= assignment.effective_to) {
        throw new EmploymentStartCorrectionError(
          `An assignment that began on ${previousStart} ends on ${assignment.effective_to}; correct the assignment history first.`,
        );
      }
    }

    const newRevision = employment.revision + 1;
    await exec.execute(sql`
      insert into hrm_graph_revisions (org_id, rev) values (${input.orgId}, 1)
      on conflict (org_id) do update set rev = hrm_graph_revisions.rev + 1, updated_at = now()
    `);
    const recordedAt = (
      await exec.execute<{ now: string }>(sql`select now()::text as now`, "objects")
    )[0]!.now;
    const employmentSuccessor = (
      await exec.execute<{ next: number }>(
        sql`
      select coalesce(max(version_no), 0) + 1 as next from worker_employment_versions
       where org_id = ${input.orgId} and employment_id = ${input.employmentId}
    `,
        "objects",
      )
    )[0]!.next;
    const changeId = await insertEmploymentChange(exec, {
      orgId: input.orgId,
      employmentId: input.employmentId,
      assignmentId: null,
      revision: newRevision,
      changeKind: "corrected",
      priorSnapshot: { startCorrection: { previousStart, correctedStart: corrected } },
      closedVersions: [
        {
          table: "worker_employment_versions",
          identity: input.employmentId,
          version_no: first.version_no,
          row_id: first.id,
          before: first.before,
        },
        ...assignments.map((assignment) => ({
          table: "employment_assignment_versions",
          identity: assignment.assignment_id,
          version_no: assignment.version_no,
          row_id: assignment.id,
          before: assignment.before,
        })),
      ],
      reason,
      actorId: input.actorId,
    });

    const closed = await exec.execute(
      sql`
      update worker_employment_versions
         set recorded_until = ${recordedAt}::timestamptz, superseded_by = ${employmentSuccessor},
             closed_by_change_id = ${changeId}
       where org_id = ${input.orgId} and id = ${first.id} and recorded_until is null
      returning id
    `,
      "objects",
    );
    if (closed.length !== 1)
      throw new EmploymentStartCorrectionError(
        "The employment changed while correcting it; reload and retry.",
      );
    const inserted = await exec.execute(
      sql`
      insert into worker_employment_versions
        (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at, created_by, updated_by)
      values (${input.orgId}, ${input.employmentId}, ${employmentSuccessor}, ${first.status},
              ${corrected}::date, ${first.effective_to}::date, ${recordedAt}::timestamptz, ${input.actorId}, ${input.actorId})
      returning id
    `,
      "objects",
    );
    if (inserted.length !== 1)
      throw new EmploymentStartCorrectionError(
        "The corrected employment interval was not saved; nothing applied.",
      );

    // Assignment versions carry every column of the interval they replace,
    // so the successor is copied from the row itself with only its dates and
    // version identity changed.
    const copied = (
      await exec.execute<{ column_name: string }>(
        sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'employment_assignment_versions'
         and is_generated = 'NEVER'
         and column_name not in ('id', 'version_no', 'effective_from', 'recorded_at', 'recorded_until',
                                 'superseded_by', 'closed_by_change_id', 'created_at', 'created_by',
                                 'updated_at', 'updated_by')
       order by ordinal_position
    `,
        "objects",
      )
    ).map((row) => sql.identifier(row.column_name));
    for (const assignment of assignments) {
      const successor = (
        await exec.execute<{ next: number }>(
          sql`
        select coalesce(max(version_no), 0) + 1 as next from employment_assignment_versions
         where org_id = ${input.orgId} and assignment_id = ${assignment.assignment_id}
      `,
          "objects",
        )
      )[0]!.next;
      const closedAssignment = await exec.execute(
        sql`
        update employment_assignment_versions
           set recorded_until = ${recordedAt}::timestamptz, superseded_by = ${successor},
               closed_by_change_id = ${changeId}
         where org_id = ${input.orgId} and id = ${assignment.id} and recorded_until is null
        returning id
      `,
        "objects",
      );
      if (closedAssignment.length !== 1)
        throw new EmploymentStartCorrectionError(
          "An assignment changed while correcting the start; reload and retry.",
        );
      const columns = sql.join(copied, sql`, `);
      const insertedAssignment = await exec.execute(
        sql`
        insert into employment_assignment_versions
          (${columns}, version_no, effective_from, recorded_at, created_by, updated_by)
        select ${columns}, ${successor}, ${corrected}::date, ${recordedAt}::timestamptz, ${input.actorId}, ${input.actorId}
          from employment_assignment_versions
         where org_id = ${input.orgId} and id = ${assignment.id}
        returning id
      `,
        "objects",
      );
      if (insertedAssignment.length !== 1)
        throw new EmploymentStartCorrectionError(
          "The corrected assignment interval was not saved; nothing applied.",
        );
    }

    // Payroll bounds its roster by the employee record's hire date, and a
    // service start recorded as the same wrong day moves with it.
    await exec.execute(sql`
      update employee_roles
         set hired_on = ${corrected}::date, updated_by = ${input.actorId}, updated_at = now()
       where org_id = ${input.orgId} and party_id = ${employment.worker_party_id}
         and hired_on = ${previousStart}::date
    `);
    if (employment.service_start === previousStart) {
      await exec.execute(sql`
        update worker_employments set service_start = ${corrected}::date
         where org_id = ${input.orgId} and id = ${input.employmentId}
      `);
    }
    const bumped = await exec.execute(
      sql`
      update worker_employments
         set revision = ${newRevision}, updated_by = ${input.actorId}, updated_at = now()
       where org_id = ${input.orgId} and id = ${input.employmentId} and revision = ${employment.revision}
      returning id
    `,
      "objects",
    );
    if (bumped.length !== 1)
      throw new EmploymentStartCorrectionError(
        "The employment changed while correcting it; reload and retry.",
      );
    await exec.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${input.orgId}, 'worker_employments', ${input.employmentId}, 'start_corrected',
              ${JSON.stringify({ before: { start: previousStart }, after: { start: corrected }, reason, changeId })}::jsonb,
              ${input.actorId})
    `);
    return { employmentId: input.employmentId, previousStart, correctedStart: corrected, changeId };
  });
}
