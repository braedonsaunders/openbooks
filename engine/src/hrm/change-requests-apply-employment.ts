import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { recordPositionAssignmentEvent } from "./positions.ts";
import { assertEmploymentHireWorker } from "./employment-worker.ts";
import { makeEffectiveInterval, parseCivilDate } from "./temporal.ts";
import { autoOpenProcessForChange, processTriggerForApply } from "./processes.ts";
import { endEnrollmentsForTermination } from "./benefits/enrollments.ts";
import {
  HrmChangeRequestError,
  type HirePayload,
  type HireInitialAssignment,
  type StatusChangePayload,
  type AssignmentChangePayload,
  type TerminationPayload,
} from "./change-requests-payload.ts";
import {
  type RequestRow,
  liveEmploymentVersions,
  employmentVersionCount,
  effectiveOverlaps,
  assertHistoricalStatusWindow,
} from "./change-requests-core.ts";
import {
  insertEmploymentChange,
  linkAppliedEvidence,
  bumpAggregateRevision,
} from "./change-requests-evidence.ts";
import {
  type DbInstant,
  positionLinkWarnings,
  assertAssignmentRefs,
  assertNoPrimaryConflict,
  planLineManagerChange,
  closeLineManagerChange,
} from "./change-requests-apply-helpers.ts";

export async function applyHire(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    payload: HirePayload;
    newRevision: number;
    recordedAt: DbInstant;
    /** The same clock as recordedAt, as a UTC ISO instant for as-of reads. */
    recordedAtIso: string;
  },
): Promise<void> {
  const { orgId, actorId, request, payload, newRevision, recordedAt, recordedAtIso } = args;
  await assertEmploymentHireWorker(exec, orgId, request.employment_id);
  const count = await employmentVersionCount(exec, orgId, request.employment_id);
  if (count > 0) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "an effective version landed while this hire awaited approval — file a status change, not a second hire",
    );
  }
  await exec.execute(sql`
    insert into worker_employment_versions
      (org_id, employment_id, version_no, status, effective_from, effective_to,
       recorded_at, created_by, updated_by)
    values (${orgId}, ${request.employment_id}, 1, ${payload.status},
            ${payload.effectiveFrom}::date, ${payload.effectiveTo}::date,
            ${recordedAt}, ${actorId}, ${actorId})
  `);
  const changeId = await insertEmploymentChange(exec, {
    orgId,
    employmentId: request.employment_id,
    assignmentId: null,
    revision: newRevision,
    changeKind: "created",
    priorSnapshot: {},
    closedVersions: [],
    reason: request.reason ?? "",
    action: request.action ?? null,
    reasonCode: request.reason_code ?? null,
    actorId,
  });
  // The hire owes its onboarding checklist in this same transaction: a throw
  // (no template, duplicate open) rolls the version back with it, so a hire
  // without its checklist cannot exist while hrm is on. No-op while hrm is
  // off (payroll stays independent of the checklist module).
  const hireTrigger = processTriggerForApply({
    kind: "hire",
    effectiveFrom: payload.effectiveFrom,
  });
  if (hireTrigger !== null) {
    await autoOpenProcessForChange(exec, {
      orgId,
      actorId,
      employmentId: request.employment_id,
      changeId,
      trigger: hireTrigger,
    });
  }
  if (payload.initialAssignment === undefined) {
    await linkAppliedEvidence(exec, { orgId, actorId, request, newRevision, changeId });
    await bumpAggregateRevision(exec, {
      orgId,
      actorId,
      request,
      expected: newRevision - 1,
      next: newRevision,
    });
    return;
  }
  const assignmentRevision = newRevision + 1;
  // The request links the assignment's event: the guard proves the linked
  // change carries the stamped revision, so the hire's own event (one
  // revision back) must never be stamped here.
  const assignmentChangeId = await applyInitialAssignment(exec, {
    orgId,
    actorId,
    request,
    hire: payload,
    assignment: payload.initialAssignment,
    newRevision: assignmentRevision,
    recordedAt,
    recordedAtIso,
  });
  await linkAppliedEvidence(exec, {
    orgId,
    actorId,
    request,
    newRevision: assignmentRevision,
    changeId: assignmentChangeId,
  });
  await bumpAggregateRevision(exec, {
    orgId,
    actorId,
    request,
    expected: newRevision - 1,
    next: assignmentRevision,
  });
}

/**
 * Issue the first assignment slot riding a hire: the slot and its first
 * version (title, department, location, FTE, primary, the hire's window)
 * plus the line-manager reporting and the establishment link, evidenced
 * as 'assignment_issued'. Shares the hire's approval transaction and the
 * hire's revision chain — it writes its event but never links the request
 * or bumps the aggregate; applyHire stamps the final revision once.
 */
async function applyInitialAssignment(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    hire: HirePayload;
    assignment: HireInitialAssignment;
    newRevision: number;
    recordedAt: DbInstant;
    recordedAtIso: string;
  },
): Promise<string> {
  // Returns the assignment event id: the caller links the request to the
  // event carrying the stamped revision (never the hire's own event, one
  // revision back).
  const { orgId, actorId, request, hire, assignment, newRevision, recordedAt, recordedAtIso } =
    args;
  const windowStart = hire.effectiveFrom;
  const windowEnd = hire.effectiveTo;
  makeEffectiveInterval(windowStart, windowEnd);
  const asAssignment: AssignmentChangePayload = {
    kind: "assignment_change",
    assignmentKey: assignment.assignmentKey,
    jobTitle: assignment.jobTitle ?? null,
    departmentId: assignment.departmentId ?? null,
    locationId: assignment.locationId ?? null,
    fte: assignment.fte,
    isPrimary: assignment.isPrimary,
    effectiveFrom: windowStart,
    ...(windowEnd === null ? {} : { effectiveTo: windowEnd }),
    ...(assignment.managerEmploymentId === undefined
      ? {}
      : { managerEmploymentId: assignment.managerEmploymentId }),
  };
  await assertAssignmentRefs(exec, {
    orgId,
    employmentId: request.employment_id,
    payload: asAssignment,
  });
  const isPrimary = assignment.isPrimary;
  await assertNoPrimaryConflict(exec, {
    orgId,
    employmentId: request.employment_id,
    slotId: null,
    isPrimary,
    windowStart,
    windowEnd,
  });
  // Lock the target establishment first (when there is one): the revision
  // read here feeds the position-side event, and the row lock serializes
  // against concurrent closes and assignments on the same establishment.
  let target: { id: string; position_code: string; revision: number } | null = null;
  if (assignment.positionId) {
    const found = (
      await exec.execute<{ id: string; position_code: string; revision: number }>(
        sql`
      select id, position_code, revision from positions
       where org_id = ${orgId} and id = ${assignment.positionId} for update
    `,
        "objects",
      )
    )[0];
    if (!found) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "the position is gone — withdraw this request; a proposal about a deleted establishment never applies",
      );
    }
    target = found;
  }
  const slotId = (
    await exec.execute<{ id: string }>(
      sql`
    insert into employment_assignments (org_id, employment_id, assignment_key, created_by, updated_by)
    values (${orgId}, ${request.employment_id}, ${assignment.assignmentKey}, ${actorId}, ${actorId})
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
      (org_id, assignment_id, employment_id, position_id, version_no,
       job_title, department_id, location_id, fte, is_primary,
       effective_from, effective_to, recorded_at, created_by, updated_by)
    values (${orgId}, ${slotId}, ${request.employment_id}, ${assignment.positionId ?? null}, 1,
            ${assignment.jobTitle ?? null}, ${assignment.departmentId ?? null}, ${assignment.locationId ?? null},
            ${assignment.fte ?? "1"}, ${isPrimary},
            ${windowStart}::date, ${windowEnd}::date,
            ${recordedAt}, ${actorId}, ${actorId})
  `);
  const reporting = await planLineManagerChange(exec, {
    orgId,
    employmentId: request.employment_id,
    managerId: assignment.managerEmploymentId,
    windowStart,
    windowEnd,
  });
  const warnings = await positionLinkWarnings(exec, {
    orgId,
    target,
    windowStart,
    asKnown: recordedAtIso,
    assignment: {
      title: assignment.jobTitle ?? null,
      departmentId: assignment.departmentId ?? null,
      locationId: assignment.locationId ?? null,
    },
  });
  const changeId = await insertEmploymentChange(exec, {
    orgId,
    employmentId: request.employment_id,
    assignmentId: slotId,
    revision: newRevision,
    changeKind: "assignment_issued",
    priorSnapshot: {
      slot: assignment.assignmentKey,
      issued: true,
      positionId: assignment.positionId ?? null,
      positionWarnings: warnings,
    },
    closedVersions: reporting.change ? reporting.elements : [],
    reason: request.reason ?? "",
    action: request.action ?? null,
    reasonCode: request.reason_code ?? null,
    actorId,
  });
  await closeLineManagerChange(exec, { orgId, actorId, request, reporting, changeId, recordedAt });
  if (assignment.positionId) {
    await recordPositionAssignmentEvent(exec, {
      orgId,
      actorId,
      positionId: assignment.positionId,
      employmentId: request.employment_id,
      assignmentKey: assignment.assignmentKey,
      priorPositionId: null,
      disagreementWarnings: warnings,
      reason: request.reason ?? "",
      positionRevision: target?.revision ?? 0,
    });
  }
  return changeId;
}

/** Status corrections cannot reinterpret payroll already committed for their window. */
/** Sequence allocation covers the entire recorded chain, including disjoint windows. */
async function nextEmploymentVersionNumber(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<number> {
  const next = (
    await exec.execute<{ next: number }>(
      sql`
    select coalesce(max(version_no),0)+1 as next from worker_employment_versions
    where org_id=${orgId} and employment_id=${employmentId}
  `,
      "objects",
    )
  )[0]?.next;
  if (!next)
    throw new HrmChangeRequestError(
      "REFUSED",
      "The employment version sequence is unavailable; reload the history.",
    );
  return next;
}

export async function applyHistoricalStatusObservation(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    payload: StatusChangePayload;
    newRevision: number;
    recordedAt: DbInstant;
  },
): Promise<void> {
  const { orgId, actorId, request, payload, newRevision, recordedAt } = args;
  // The aggregate is now locked. Repeat the overlap check so another HRM
  // approval cannot insert a version between the initial check and this lock.
  await assertHistoricalStatusWindow(exec, orgId, request.employment_id, payload);
  const sequence = await nextEmploymentVersionNumber(exec, orgId, request.employment_id);
  const changeId = await insertEmploymentChange(exec, {
    orgId,
    employmentId: request.employment_id,
    assignmentId: null,
    revision: newRevision,
    changeKind: "status_changed",
    closedVersions: [],
    priorSnapshot: {
      historicalObservation: payload.historicalObservation,
      observedStatus: payload.status,
      effectiveFrom: payload.effectiveFrom,
      effectiveTo: payload.effectiveTo,
    },
    reason: request.reason ?? "",
    action: request.action ?? null,
    reasonCode: request.reason_code ?? null,
    actorId,
  });
  const inserted = (
    await exec.execute<{ id: string; after: Record<string, unknown> }>(
      sql`
    insert into worker_employment_versions
      (org_id,employment_id,version_no,status,effective_from,effective_to,recorded_at,created_by,updated_by)
    values (${orgId},${request.employment_id},${sequence},${payload.status},${payload.effectiveFrom}::date,
      ${payload.effectiveTo}::date,${recordedAt},${actorId},${actorId})
    returning id,to_jsonb(worker_employment_versions) as after
  `,
      "objects",
    )
  )[0];
  if (!inserted)
    throw new HrmChangeRequestError(
      "REFUSED",
      "The historical status observation was not saved; nothing applied.",
    );
  const audited = await exec.execute<{ id: string }>(
    sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
    values (${orgId},'worker_employment_versions',${inserted.id},'insert',
      ${JSON.stringify({
        before: null,
        after: inserted.after,
        kind: "historical_status_observation",
        sourceReference: payload.historicalObservation!.sourceReference,
        reason: request.reason,
        employmentChangeId: changeId,
        requestId: request.id,
      })}::jsonb,${actorId}) returning id`,
    "objects",
  );
  if (audited.length !== 1)
    throw new HrmChangeRequestError(
      "REFUSED",
      "The historical status audit was not recorded; nothing applied.",
    );
  await linkAppliedEvidence(exec, { orgId, actorId, request, newRevision, changeId });
  await bumpAggregateRevision(exec, {
    orgId,
    actorId,
    request,
    expected: newRevision - 1,
    next: newRevision,
  });
}

/**
 * (b)/(d) Status/dates change and termination: close every live version
 * overlapping the successor window (close-first, per the 0184 write order),
 * preserve the portions outside that window, and evidence every closure
 * with its exact before-image in one aggregate event.
 */
export async function applyEmploymentVersionChange(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    payload: StatusChangePayload | TerminationPayload;
    newRevision: number;
    recordedAt: DbInstant;
  },
): Promise<void> {
  const { orgId, actorId, request, payload, newRevision, recordedAt } = args;
  const successorStatus = payload.kind === "termination" ? "terminated" : payload.status;
  const windowStart =
    payload.kind === "termination" ? payload.effectiveDate : payload.effectiveFrom;
  const windowEnd = payload.kind === "termination" ? null : payload.effectiveTo;
  const live = await liveEmploymentVersions(exec, orgId, request.employment_id);
  const overlapping = live.filter((version) => effectiveOverlaps(version, windowStart, windowEnd));
  if (overlapping.length === 0) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "no live employment version overlaps the change window — reload the employment and file a new request",
    );
  }
  if (
    overlapping.length === 1 &&
    overlapping[0]!.status === successorStatus &&
    overlapping[0]!.effective_from === windowStart &&
    (overlapping[0]!.effective_to ?? null) === windowEnd
  ) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "the proposal changes nothing — file a new request only when status or dates actually change",
    );
  }
  if (
    payload.kind === "termination" &&
    overlapping.every((version) => version.status === "terminated")
  ) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "this employment is already terminated — a second termination is a duplicate, not an update",
    );
  }
  const retainedIntervals = overlapping
    .flatMap((version) => {
      const portions: { status: string; from: string; to: string | null }[] = [];
      if (version.effective_from < windowStart) {
        portions.push({ status: version.status, from: version.effective_from, to: windowStart });
      }
      if (
        windowEnd !== null &&
        (version.effective_to === null || version.effective_to > windowEnd)
      ) {
        portions.push({ status: version.status, from: windowEnd, to: version.effective_to });
      }
      return portions;
    })
    .sort((left, right) => left.from.localeCompare(right.from));
  const successorNo = await nextEmploymentVersionNumber(exec, orgId, request.employment_id);
  const changeId = await insertEmploymentChange(exec, {
    orgId,
    employmentId: request.employment_id,
    assignmentId: null,
    revision: newRevision,
    changeKind: payload.kind === "termination" ? "terminated" : "status_changed",
    priorSnapshot: {
      closed: overlapping.map((version) => ({
        versionNo: version.version_no,
        status: version.status,
        effectiveFrom: version.effective_from,
        effectiveTo: version.effective_to,
      })),
    },
    closedVersions: overlapping.map((version) => ({
      table: "worker_employment_versions",
      identity: request.employment_id,
      version_no: version.version_no,
      row_id: version.id,
      before: version.before,
    })),
    reason: request.reason ?? "",
    action: request.action ?? null,
    reasonCode: request.reason_code ?? null,
    actorId,
  });
  for (const version of overlapping) {
    const closed = await exec.execute(
      sql`
      update worker_employment_versions
         set recorded_until = ${recordedAt}, superseded_by = ${successorNo},
             closed_by_change_id = ${changeId}
       where org_id = ${orgId} and id = ${version.id} and recorded_until is null
      returning id
    `,
      "objects",
    );
    if (closed.length !== 1) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "an employment version changed while the approval was applying — retry the decision",
      );
    }
  }
  const successors = [
    { status: successorStatus, from: windowStart, to: windowEnd },
    ...retainedIntervals,
  ];
  for (const [offset, successor] of successors.entries()) {
    const inserted = await exec.execute(
      sql`
      insert into worker_employment_versions
        (org_id, employment_id, version_no, status, effective_from, effective_to,
         recorded_at, created_by, updated_by)
      values (${orgId}, ${request.employment_id}, ${successorNo + offset}, ${successor.status},
              ${successor.from}::date, ${successor.to}::date,
              ${recordedAt}, ${actorId}, ${actorId})
      returning id
    `,
      "objects",
    );
    if (inserted.length !== 1) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "The employment status interval was not saved; nothing applied.",
      );
    }
  }
  // A termination owes its offboarding checklist in this same transaction
  // (same all-or-nothing contract as the hire above). A status_change rides
  // the hire's onboarding episode — it opens nothing on its own.
  const versionTrigger = processTriggerForApply(
    payload.kind === "termination"
      ? { kind: "termination", effectiveDate: payload.effectiveDate }
      : { kind: "status_change" },
  );
  if (versionTrigger !== null) {
    await autoOpenProcessForChange(exec, {
      orgId,
      actorId,
      employmentId: request.employment_id,
      changeId,
      trigger: versionTrigger,
    });
  }
  // A termination ends every live benefit enrolment in this same
  // transaction (HR-8): coverage cannot outlive the employment, and the
  // ends-or-cancels land atomically with the version successor above — a
  // throw rolls all of it back together.
  if (payload.kind === "termination") {
    await endEnrollmentsForTermination(exec, {
      orgId,
      actorId,
      employmentId: request.employment_id,
      terminatedOn: parseCivilDate(payload.effectiveDate),
    });
    // Payroll bounds its roster and historical cheques by the employee
    // record's termination date; the approved HRM termination is its source.
    await exec.execute(sql`
      update employee_roles r
         set terminated_on = ${payload.effectiveDate}::date, updated_by = ${actorId}, updated_at = now()
        from worker_employments w
       where w.org_id = ${orgId} and w.id = ${request.employment_id}
         and r.org_id = w.org_id and r.party_id = w.worker_party_id
    `);
  }
  await linkAppliedEvidence(exec, { orgId, actorId, request, newRevision, changeId });
  await bumpAggregateRevision(exec, {
    orgId,
    actorId,
    request,
    expected: newRevision - 1,
    next: newRevision,
  });
}

/**
 * (c) Assignment change: department / location / job title / FTE / primary /
 * manager as 0184 models them. A first version on a new slot is evidenced
 * as 'assignment_issued'; closing live versions onto a successor is
 * 'assignment_superseded'. A manager repoint additionally closes the live
 * line reporting row onto its successor in the SAME aggregate event.
 */
