import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { HrmPositionError, positionDisagreements } from "./positions.ts";
import { makeEffectiveInterval, NoRevisionError, parseCivilDate, resolveAsOf } from "./temporal.ts";
import { HrmChangeRequestError, type AssignmentChangePayload } from "./change-requests-payload.ts";
import {
  type RequestRow,
  type ClosureElement,
  type AssignmentSlotVersion,
} from "./change-requests-core.ts";
import {
  insertEmploymentChange,
  linkAppliedEvidence,
  bumpAggregateRevision,
} from "./change-requests-evidence.ts";

export type DbInstant = Date | string;

export async function positionLinkWarnings(
  exec: SqlExecutor,
  args: {
    orgId: string;
    target: { id: string; position_code: string; revision: number } | null;
    windowStart: string;
    /** UTC ISO instant of the application clock (recordedAtIso), never the raw driver value. */
    asKnown: string;
    assignment: { title: string | null; departmentId: string | null; locationId: string | null };
  },
): Promise<string[]> {
  if (args.target === null) return [];
  try {
    const versions = await exec.execute<{
      title: string;
      department_id: string | null;
      location_id: string | null;
      effective_from: string;
      effective_to: string | null;
      recorded_at: string;
      recorded_until: string | null;
    }>(
      sql`
      select title, department_id::text as department_id, location_id::text as location_id,
             effective_from::text as effective_from,
             effective_to::text as effective_to,
             to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at,
             to_char(recorded_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_until
        from position_versions
       where org_id = ${args.orgId} and position_id = ${args.target.id}
         and recorded_until is null
       order by version_no
    `,
      "objects",
    );
    // resolveAsOf, NoRevisionError and parseCivilDate are the static
    // temporal imports at the top of this file — the same primitives the
    // employment paths resolve through.
    let covered;
    try {
      covered = resolveAsOf(
        versions.map((row) => ({
          effective: {
            start: parseCivilDate(row.effective_from),
            end: row.effective_to === null ? null : parseCivilDate(row.effective_to),
          },
          recordedAt: row.recorded_at,
          recordedUntil: row.recorded_until,
          payload: row,
        })),
        { effective: args.windowStart, asKnown: args.asKnown },
      );
    } catch (resolveError) {
      if (resolveError instanceof NoRevisionError) {
        return [
          `position ${args.target.position_code} covers no version at ${args.windowStart} — the assignment keeps its own title, department and location`,
        ];
      }
      throw resolveError;
    }
    return positionDisagreements(
      args.target.position_code,
      {
        title: covered.payload.title,
        departmentId: covered.payload.department_id,
        locationId: covered.payload.location_id,
      },
      args.assignment,
    );
  } catch (error) {
    if (error instanceof HrmPositionError) {
      throw new HrmChangeRequestError("REFUSED", error.message);
    }
    throw error;
  }
}

/** First version on a brand-new slot ('assignment_issued', no closures). */
export async function issueAssignmentSlot(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    payload: AssignmentChangePayload;
    newRevision: number;
    recordedAt: DbInstant;
  },
): Promise<void> {
  const { orgId, actorId, request, payload, newRevision, recordedAt } = args;
  if (payload.effectiveFrom === undefined) {
    throw new HrmChangeRequestError(
      "INVALID_PAYLOAD",
      "a new assignment needs effectiveFrom — name the date the slot takes effect",
    );
  }
  const windowStart = payload.effectiveFrom;
  const windowEnd = payload.effectiveTo ?? null;
  makeEffectiveInterval(windowStart, windowEnd);
  const isPrimary = payload.isPrimary ?? false;
  await assertNoPrimaryConflict(exec, {
    orgId,
    employmentId: request.employment_id,
    slotId: null,
    isPrimary,
    windowStart,
    windowEnd,
  });
  const slotId = (
    await exec.execute<{ id: string }>(
      sql`
    insert into employment_assignments (org_id, employment_id, assignment_key, created_by, updated_by)
    values (${orgId}, ${request.employment_id}, ${payload.assignmentKey}, ${actorId}, ${actorId})
    returning id
  `,
      "objects",
    )
  )[0]?.id;
  if (!slotId) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the assignment slot was not stored — nothing applied; retry the decision",
    );
  }
  await exec.execute(sql`
    insert into employment_assignment_versions
      (org_id, assignment_id, employment_id, version_no, job_title, department_id,
       location_id, fte, is_primary, effective_from, effective_to,
       recorded_at, created_by, updated_by)
    values (${orgId}, ${slotId}, ${request.employment_id}, 1,
            ${payload.jobTitle ?? null}, ${payload.departmentId ?? null}, ${payload.locationId ?? null},
            ${payload.fte ?? "1"}, ${isPrimary},
            ${windowStart}::date, ${windowEnd}::date,
            ${recordedAt}, ${actorId}, ${actorId})
  `);
  const reporting = await planLineManagerChange(exec, {
    orgId,
    employmentId: request.employment_id,
    managerId: payload.managerEmploymentId,
    windowStart,
    windowEnd,
  });
  const changeId = await insertEmploymentChange(exec, {
    orgId,
    employmentId: request.employment_id,
    assignmentId: slotId,
    revision: newRevision,
    changeKind: "assignment_issued",
    priorSnapshot: { slot: payload.assignmentKey, issued: true },
    closedVersions: reporting.change ? reporting.elements : [],
    reason: request.reason ?? "",
    action: request.action ?? null,
    reasonCode: request.reason_code ?? null,
    actorId,
  });
  await closeLineManagerChange(exec, { orgId, actorId, request, reporting, changeId, recordedAt });
  await linkAppliedEvidence(exec, { orgId, actorId, request, newRevision, changeId });
  await bumpAggregateRevision(exec, {
    orgId,
    actorId,
    request,
    expected: newRevision - 1,
    next: newRevision,
  });
}

export async function liveAssignmentVersions(
  exec: SqlExecutor,
  orgId: string,
  slotId: string,
): Promise<AssignmentSlotVersion[]> {
  const rows = await exec.execute<AssignmentSlotVersion & { before: unknown }>(
    sql`
    select id, version_no, position_id::text as position_id,
           job_title, department_id, location_id, fte::text as fte,
           is_primary, effective_from::text as effective_from,
           effective_to::text as effective_to,
           to_jsonb(employment_assignment_versions) as before
      from employment_assignment_versions
     where org_id = ${orgId} and assignment_id = ${slotId}
       and recorded_until is null
     order by version_no
  `,
    "objects",
  );
  return rows;
}

/**
 * A change window supersedes only the effective dates it covers. The parts
 * of each overlapping live slice before and after the window keep their
 * recorded content as fresh slices (numbered after the successor), so a
 * dated change never erases the assignment history beside it. The
 * employment-status path retains its uncovered intervals the same way.
 */
export async function insertRetainedAssignmentPortions(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    slotId: string;
    employmentId: string;
    overlapping: readonly AssignmentSlotVersion[];
    windowStart: string;
    windowEnd: string | null;
    firstVersionNo: number;
    recordedAt: DbInstant;
  },
): Promise<void> {
  const { orgId, actorId, slotId, employmentId, overlapping, windowStart, windowEnd, recordedAt } =
    args;
  const portions = overlapping
    .flatMap((version) => {
      const retained: { version: AssignmentSlotVersion; from: string; to: string | null }[] = [];
      if (version.effective_from < windowStart) {
        retained.push({ version, from: version.effective_from, to: windowStart });
      }
      if (
        windowEnd !== null &&
        (version.effective_to === null || version.effective_to > windowEnd)
      ) {
        retained.push({ version, from: windowEnd, to: version.effective_to });
      }
      return retained;
    })
    .sort((left, right) => left.from.localeCompare(right.from));
  for (const [offset, portion] of portions.entries()) {
    const { version } = portion;
    const inserted = await exec.execute(
      sql`
      insert into employment_assignment_versions
        (org_id, assignment_id, employment_id, position_id, version_no, job_title, department_id,
         location_id, fte, is_primary, effective_from, effective_to,
         recorded_at, created_by, updated_by)
      values (${orgId}, ${slotId}, ${employmentId}, ${version.position_id}, ${args.firstVersionNo + offset},
              ${version.job_title}, ${version.department_id}, ${version.location_id},
              ${version.fte}, ${version.is_primary},
              ${portion.from}::date, ${portion.to}::date,
              ${recordedAt}, ${actorId}, ${actorId})
      returning id
    `,
      "objects",
    );
    if (inserted.length !== 1) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "The retained assignment interval was not saved; nothing applied.",
      );
    }
  }
}

/**
 * Prove foreign references before writing: a department, location, or
 * manager from another organization (or a typo) is refused with the field
 * named — never left to a raw constraint violation. A manager must also be
 * a real employment and never the subject itself.
 */
export async function assertAssignmentRefs(
  exec: SqlExecutor,
  args: { orgId: string; employmentId: string; payload: AssignmentChangePayload },
): Promise<void> {
  const { orgId, employmentId, payload } = args;
  if (payload.departmentId) {
    const found = (
      await exec.execute(
        sql`
      select 1 as one from departments where org_id = ${orgId} and id = ${payload.departmentId}
    `,
        "objects",
      )
    )[0];
    if (!found) {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        "the department is not visible in this organization — pick a department of this organization",
      );
    }
  }
  if (payload.locationId) {
    const found = (
      await exec.execute(
        sql`
      select 1 as one from locations where org_id = ${orgId} and id = ${payload.locationId}
    `,
        "objects",
      )
    )[0];
    if (!found) {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        "the location is not visible in this organization — pick a location of this organization",
      );
    }
  }
  if (payload.managerEmploymentId !== undefined && payload.managerEmploymentId !== null) {
    if (payload.managerEmploymentId === employmentId) {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        "an employment cannot report to itself — name another employment as manager",
      );
    }
    const found = (
      await exec.execute(
        sql`
      select 1 as one from worker_employments where org_id = ${orgId} and id = ${payload.managerEmploymentId}
    `,
        "objects",
      )
    )[0];
    if (!found) {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        "the manager employment is not visible in this organization — name an employment of this organization",
      );
    }
  }
}

/**
 * Single-primary invariant, checked before writing: a primary successor
 * overlapping another slot's live primary in both dimensions is refused by
 * name instead of tripping the deferred exclusion at commit.
 */
export async function assertNoPrimaryConflict(
  exec: SqlExecutor,
  args: {
    orgId: string;
    employmentId: string;
    slotId: string | null;
    isPrimary: boolean;
    windowStart: string;
    windowEnd: string | null;
  },
): Promise<void> {
  if (!args.isPrimary) return;
  const rows = await exec.execute<{ assignment_key: string }>(
    sql`
    select a.assignment_key
      from employment_assignment_versions av
      join employment_assignments a on a.id = av.assignment_id and a.org_id = av.org_id
     where av.org_id = ${args.orgId} and av.employment_id = ${args.employmentId}
       ${args.slotId === null ? sql`` : sql`and av.assignment_id <> ${args.slotId}`}
       and av.is_primary and av.recorded_until is null
       and daterange(av.effective_from, coalesce(av.effective_to, 'infinity'::date), '[)')
           && daterange(${args.windowStart}::date, coalesce(${args.windowEnd}::date, 'infinity'::date), '[)')
     limit 1
  `,
    "objects",
  );
  const clash = rows[0];
  if (clash) {
    throw new HrmChangeRequestError(
      "REFUSED",
      `assignment ${clash.assignment_key} is already primary over that window — at most one assignment may be primary at one as-of point`,
    );
  }
}

export type LiveLineRelationship = {
  id: string;
  relationship_id: string;
  version_no: number;
  manager_employment_id: string;
  effective_from: string;
  effective_to: string | null;
  before: unknown;
};

export type LineManagerPlan =
  | { readonly change: false }
  | {
      readonly change: true;
      readonly live: LiveLineRelationship | null;
      readonly managerId: string;
      readonly windowStart: string;
      readonly windowEnd: string | null;
      readonly elements: ClosureElement[];
    };

/**
 * Plan phase of a manager repoint: undefined leaves reporting untouched;
 * an unchanged manager is no change; otherwise the live line (if any) is
 * evidenced for closure and the successor reuses the assignment window.
 */
export async function planLineManagerChange(
  exec: SqlExecutor,
  args: {
    orgId: string;
    employmentId: string;
    managerId: string | null | undefined;
    windowStart: string;
    windowEnd: string | null;
  },
): Promise<LineManagerPlan> {
  if (args.managerId === undefined) return { change: false };
  if (args.managerId === null) {
    throw new HrmChangeRequestError(
      "INVALID_PAYLOAD",
      "manager removal is not modeled — a reporting line closes only onto a successor manager; file the change without managerEmploymentId to leave reporting untouched",
    );
  }
  const live =
    (
      await exec.execute<LiveLineRelationship>(
        sql`
    select id, relationship_id, version_no, manager_employment_id,
           effective_from::text as effective_from,
           effective_to::text as effective_to,
           to_jsonb(reporting_relationships) as before
      from reporting_relationships
     where org_id = ${args.orgId} and employment_id = ${args.employmentId}
       and kind = 'line' and recorded_until is null
     order by version_no desc
     limit 1
  `,
        "objects",
      )
    )[0] ?? null;
  if (live && live.manager_employment_id === args.managerId) {
    return { change: false };
  }
  if (live && live.version_no < 1) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "the reporting line carries no version — refuse the repoint",
    );
  }
  return {
    change: true,
    live,
    managerId: args.managerId,
    windowStart: args.windowStart,
    windowEnd: args.windowEnd,
    elements:
      live === null
        ? []
        : [
            {
              table: "reporting_relationships",
              identity: live.relationship_id,
              version_no: live.version_no,
              row_id: live.id,
              before: live.before,
            },
          ],
  };
}

/**
 * Write phase: close the live line onto its successor (or open the first
 * line). Cycle and depth refusals from the 0184 guard keep their message
 * and gain the remedy; everything else propagates so nothing is masked.
 */
export async function closeLineManagerChange(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    reporting: LineManagerPlan;
    changeId: string;
    recordedAt: DbInstant;
  },
): Promise<void> {
  if (!args.reporting.change) return;
  const { orgId, actorId, request, reporting, changeId, recordedAt } = args;
  try {
    if (reporting.live === null) {
      await exec.execute(sql`
        insert into reporting_relationships
          (org_id, employment_id, manager_employment_id, kind, relationship_id,
           version_no, effective_from, effective_to, recorded_at, created_by, updated_by)
        values (${orgId}, ${request.employment_id}, ${reporting.managerId}, 'line',
                ${randomUUID()}, 1,
                ${reporting.windowStart}::date, ${reporting.windowEnd}::date,
                ${recordedAt}, ${actorId}, ${actorId})
      `);
      return;
    }
    const successorNo = reporting.live.version_no + 1;
    const closed = await exec.execute(
      sql`
      update reporting_relationships
         set recorded_until = ${recordedAt}, superseded_by = ${successorNo},
             closed_by_change_id = ${changeId}
       where org_id = ${orgId} and id = ${reporting.live.id} and recorded_until is null
      returning id
    `,
      "objects",
    );
    if (closed.length !== 1) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the reporting line changed while the approval was applying — retry the decision",
      );
    }
    await exec.execute(sql`
      insert into reporting_relationships
        (org_id, employment_id, manager_employment_id, kind, relationship_id,
         version_no, effective_from, effective_to, recorded_at, created_by, updated_by)
      values (${orgId}, ${request.employment_id}, ${reporting.managerId}, 'line',
              ${reporting.live.relationship_id}, ${successorNo},
              ${reporting.windowStart}::date, ${reporting.windowEnd}::date,
              ${recordedAt}, ${actorId}, ${actorId})
    `);
  } catch (error) {
    if (error instanceof HrmChangeRequestError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/management cycle|65 edges/i.test(message)) {
      throw new HrmChangeRequestError(
        "REFUSED",
        `${message} — choose a manager outside the subordinate's reporting chain`,
      );
    }
    throw error;
  }
}

/**
 * Every change kind the engine writes into employment_changes. All writes
 * flow through insertEmploymentChange below, so this union is the complete
 * list the employment_changes_kind CHECK must admit. The kind guard
 * integration test inserts one row per entry, so a vocabulary that drops
 * a written kind fails loudly instead of inside a live application.
 */
