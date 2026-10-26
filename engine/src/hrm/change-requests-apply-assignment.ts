import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { recordPositionAssignmentEvent } from "./positions.ts";
import { makeEffectiveInterval } from "./temporal.ts";
import { autoOpenProcessForChange, processTriggerForApply } from "./processes.ts";
import {
  HrmChangeRequestError,
  type AssignmentChangePayload,
  type PositionAssignmentPayload,
} from "./change-requests-payload.ts";
import { type RequestRow, type ClosureElement, effectiveOverlaps } from "./change-requests-core.ts";
import {
  insertEmploymentChange,
  linkAppliedEvidence,
  bumpAggregateRevision,
} from "./change-requests-evidence.ts";
import {
  type DbInstant,
  positionLinkWarnings,
  issueAssignmentSlot,
  liveAssignmentVersions,
  insertRetainedAssignmentPortions,
  assertAssignmentRefs,
  assertNoPrimaryConflict,
  planLineManagerChange,
  closeLineManagerChange,
} from "./change-requests-apply-helpers.ts";

export async function applyAssignmentChange(
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
  await assertAssignmentRefs(exec, { orgId, employmentId: request.employment_id, payload });

  const slotRows = await exec.execute<{ id: string }>(
    sql`
    select id from employment_assignments
     where org_id = ${orgId} and employment_id = ${request.employment_id}
       and assignment_key = ${payload.assignmentKey}
  `,
    "objects",
  );
  const slotId = slotRows[0]?.id ?? null;

  if (slotId === null) {
    await issueAssignmentSlot(exec, { orgId, actorId, request, payload, newRevision, recordedAt });
    return;
  }

  const live = await liveAssignmentVersions(exec, orgId, slotId);
  // Successor window: explicit when given, otherwise carried from the single
  // live slice. Several live slices with no explicit window is ambiguous —
  // the proposal must name the window it changes.
  let windowStart: string;
  let windowEnd: string | null;
  if (payload.effectiveFrom !== undefined || payload.effectiveTo !== undefined) {
    if (live.length === 0) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "this assignment has no live version to re-date — withdraw this request and file for the recorded slot state",
      );
    }
    const base = live.reduce((a, b) => (a.version_no > b.version_no ? a : b));
    windowStart = payload.effectiveFrom ?? base.effective_from;
    windowEnd = payload.effectiveTo ?? base.effective_to;
    makeEffectiveInterval(windowStart, windowEnd);
  } else {
    if (live.length !== 1) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "this assignment holds several live slices and the proposal names no effective window — name effectiveFrom/effectiveTo explicitly",
      );
    }
    windowStart = live[0]!.effective_from;
    windowEnd = live[0]!.effective_to;
  }
  const overlapping = live.filter((version) => effectiveOverlaps(version, windowStart, windowEnd));
  if (overlapping.length === 0) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "no live assignment version overlaps the change window — reload the assignment and file a new request",
    );
  }
  // Content carry-over comes from the newest overlapping slice — including
  // the position link (0192): an assignment change never moves the holder
  // off its establishment; only a position_assignment request does that.
  const base = overlapping.reduce((a, b) => (a.version_no > b.version_no ? a : b));
  const successor = {
    positionId: base.position_id,
    jobTitle: payload.jobTitle !== undefined ? payload.jobTitle : base.job_title,
    departmentId: payload.departmentId !== undefined ? payload.departmentId : base.department_id,
    locationId: payload.locationId !== undefined ? payload.locationId : base.location_id,
    fte: payload.fte ?? base.fte,
    isPrimary: payload.isPrimary ?? base.is_primary,
  };
  if (
    overlapping.length === 1 &&
    overlapping[0]!.job_title === successor.jobTitle &&
    overlapping[0]!.department_id === successor.departmentId &&
    overlapping[0]!.location_id === successor.locationId &&
    overlapping[0]!.fte === successor.fte &&
    overlapping[0]!.is_primary === successor.isPrimary &&
    overlapping[0]!.effective_from === windowStart &&
    (overlapping[0]!.effective_to ?? null) === windowEnd &&
    payload.managerEmploymentId === undefined
  ) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "the proposal changes nothing — file a new request only when assignment content, dates, or manager actually change",
    );
  }
  await assertNoPrimaryConflict(exec, {
    orgId,
    employmentId: request.employment_id,
    slotId,
    isPrimary: successor.isPrimary,
    windowStart,
    windowEnd,
  });
  const successorNo = Math.max(...live.map((version) => version.version_no)) + 1;

  // Two-phase reporting: plan the closure evidence first (the event must
  // name it), then close and insert after the event exists.
  const reporting = await planLineManagerChange(exec, {
    orgId,
    employmentId: request.employment_id,
    managerId: payload.managerEmploymentId,
    windowStart,
    windowEnd,
  });
  const reportingElements = reporting.change ? reporting.elements : [];
  const closedVersions: ClosureElement[] = [
    ...overlapping.map((version) => ({
      table: "employment_assignment_versions",
      identity: slotId,
      version_no: version.version_no,
      row_id: version.id,
      before: version.before,
    })),
    ...reportingElements,
  ];
  const changeId = await insertEmploymentChange(exec, {
    orgId,
    employmentId: request.employment_id,
    assignmentId: slotId,
    revision: newRevision,
    changeKind: "assignment_superseded",
    priorSnapshot: {
      slot: payload.assignmentKey,
      closed: overlapping.map((version) => ({
        versionNo: version.version_no,
        jobTitle: version.job_title,
        departmentId: version.department_id,
        locationId: version.location_id,
        fte: version.fte,
        isPrimary: version.is_primary,
        effectiveFrom: version.effective_from,
        effectiveTo: version.effective_to,
      })),
    },
    closedVersions,
    reason: request.reason ?? "",
    action: request.action ?? null,
    reasonCode: request.reason_code ?? null,
    actorId,
  });
  for (const version of overlapping) {
    const closed = await exec.execute(
      sql`
      update employment_assignment_versions
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
        "an assignment version changed while the approval was applying — retry the decision",
      );
    }
  }
  await exec.execute(sql`
    insert into employment_assignment_versions
      (org_id, assignment_id, employment_id, position_id, version_no, job_title, department_id,
       location_id, fte, is_primary, effective_from, effective_to,
       recorded_at, created_by, updated_by)
    values (${orgId}, ${slotId}, ${request.employment_id}, ${successor.positionId}, ${successorNo},
            ${successor.jobTitle}, ${successor.departmentId}, ${successor.locationId},
            ${successor.fte}, ${successor.isPrimary},
            ${windowStart}::date, ${windowEnd}::date,
            ${recordedAt}, ${actorId}, ${actorId})
  `);
  await insertRetainedAssignmentPortions(exec, {
    orgId,
    actorId,
    slotId,
    employmentId: request.employment_id,
    overlapping,
    windowStart,
    windowEnd,
    firstVersionNo: successorNo + 1,
    recordedAt,
  });
  await closeLineManagerChange(exec, { orgId, actorId, request, reporting, changeId, recordedAt });
  // A real department move owes its transfer checklist in this same
  // transaction. A new slot ('assignment_issued' below) is not a move, and
  // neither is a repoint that carries the department over unchanged.
  const assignmentTrigger = processTriggerForApply({
    kind: "assignment_change",
    departmentChanged:
      payload.departmentId !== undefined &&
      (successor.departmentId ?? null) !== (base.department_id ?? null),
    windowStart,
  });
  if (assignmentTrigger !== null) {
    await autoOpenProcessForChange(exec, {
      orgId,
      actorId,
      employmentId: request.employment_id,
      changeId,
      trigger: assignmentTrigger,
    });
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
 * (e) Position assignment (0192): move an assignment slot onto a funded
 * position (or off it, when positionId is null). Only the position link
 * moves — title, department, location, FTE and primary carry over from the
 * newest overlapping slice, and disagreement with the position version is
 * recorded as a warning in BOTH ledgers' evidence (employment_changes
 * prior_snapshot and the position_changes 'assigned' event), never applied
 * as a rewrite.
 *
 * Evidenced as 'assignment_superseded' ('assignment_issued' on a new slot):
 * the employment_changes change_kind vocabulary is unchanged. The position
 * side is evidenced by recordPositionAssignmentEvent in the same
 * transaction. The target position row locks BEFORE any assignment write
 * (and closePosition locks the same row before its held-check), so a close
 * racing this application cannot miss the new holder.
 */
export async function applyPositionAssignment(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    request: RequestRow;
    payload: PositionAssignmentPayload;
    newRevision: number;
    recordedAt: DbInstant;
    /** The same clock as recordedAt, as a UTC ISO instant for as-of reads. */
    recordedAtIso: string;
  },
): Promise<void> {
  const { orgId, actorId, request, payload, newRevision, recordedAt, recordedAtIso } = args;
  // Lock the target position first (when there is one): the revision read
  // here feeds the position-side event, and the row lock serializes against
  // concurrent closes and assignments on the same establishment.
  let target: { id: string; position_code: string; revision: number } | null = null;
  if (payload.positionId !== null) {
    const found = (
      await exec.execute<{ id: string; position_code: string; revision: number }>(
        sql`
      select id, position_code, revision from positions
       where org_id = ${orgId} and id = ${payload.positionId} for update
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

  const slotRows = await exec.execute<{ id: string }>(
    sql`
    select id from employment_assignments
     where org_id = ${orgId} and employment_id = ${request.employment_id}
       and assignment_key = ${payload.assignmentKey}
  `,
    "objects",
  );
  const slotId = slotRows[0]?.id ?? null;

  if (slotId === null) {
    if (payload.effectiveFrom === undefined) {
      throw new HrmChangeRequestError(
        "INVALID_PAYLOAD",
        "a new assignment needs effectiveFrom — name the date the slot takes effect",
      );
    }
    const windowStart = payload.effectiveFrom;
    const windowEnd = payload.effectiveTo ?? null;
    makeEffectiveInterval(windowStart, windowEnd);
    await assertNoPrimaryConflict(exec, {
      orgId,
      employmentId: request.employment_id,
      slotId: null,
      isPrimary: false,
      windowStart,
      windowEnd,
    });
    const issuedId = (
      await exec.execute<{ id: string }>(
        sql`
      insert into employment_assignments (org_id, employment_id, assignment_key, created_by, updated_by)
      values (${orgId}, ${request.employment_id}, ${payload.assignmentKey}, ${actorId}, ${actorId})
      returning id
    `,
        "objects",
      )
    )[0]?.id;
    if (!issuedId) {
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
      values (${orgId}, ${issuedId}, ${request.employment_id}, ${payload.positionId}, 1,
              null, null, null, '1', false,
              ${windowStart}::date, ${windowEnd}::date,
              ${recordedAt}, ${actorId}, ${actorId})
    `);
    const warnings = await positionLinkWarnings(exec, {
      orgId,
      target,
      windowStart,
      asKnown: recordedAtIso,
      assignment: { title: null, departmentId: null, locationId: null },
    });
    const changeId = await insertEmploymentChange(exec, {
      orgId,
      employmentId: request.employment_id,
      assignmentId: issuedId,
      revision: newRevision,
      changeKind: "assignment_issued",
      priorSnapshot: {
        slot: payload.assignmentKey,
        issued: true,
        positionId: payload.positionId,
        positionWarnings: warnings,
      },
      closedVersions: [],
      reason: request.reason ?? "",
      action: request.action ?? null,
      reasonCode: request.reason_code ?? null,
      actorId,
    });
    await recordPositionAssignmentEvent(exec, {
      orgId,
      actorId,
      positionId: payload.positionId,
      employmentId: request.employment_id,
      assignmentKey: payload.assignmentKey,
      priorPositionId: null,
      disagreementWarnings: warnings,
      reason: request.reason ?? "",
      positionRevision: target?.revision ?? 0,
    });
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

  const live = await liveAssignmentVersions(exec, orgId, slotId);
  let windowStart: string;
  let windowEnd: string | null;
  if (payload.effectiveFrom !== undefined || payload.effectiveTo !== undefined) {
    if (live.length === 0) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "this assignment has no live version to re-date — withdraw this request and file for the recorded slot state",
      );
    }
    const base = live.reduce((a, b) => (a.version_no > b.version_no ? a : b));
    windowStart = payload.effectiveFrom ?? base.effective_from;
    windowEnd = payload.effectiveTo ?? base.effective_to;
    makeEffectiveInterval(windowStart, windowEnd);
  } else {
    if (live.length !== 1) {
      throw new HrmChangeRequestError(
        "REFUSED",
        "this assignment holds several live slices and the proposal names no effective window — name effectiveFrom/effectiveTo explicitly",
      );
    }
    windowStart = live[0]!.effective_from;
    windowEnd = live[0]!.effective_to;
  }
  const overlapping = live.filter((version) => effectiveOverlaps(version, windowStart, windowEnd));
  if (overlapping.length === 0) {
    throw new HrmChangeRequestError(
      "REFUSED",
      "no live assignment version overlaps the change window — reload the assignment and file a new request",
    );
  }
  const base = overlapping.reduce((a, b) => (a.version_no > b.version_no ? a : b));
  if (payload.positionId === null && base.position_id === null) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "this assignment names no position — an unassignment changes nothing; file a new request only when the position link actually changes",
    );
  }
  if (
    overlapping.length === 1 &&
    (overlapping[0]!.position_id ?? null) === payload.positionId &&
    overlapping[0]!.effective_from === windowStart &&
    (overlapping[0]!.effective_to ?? null) === windowEnd
  ) {
    throw new HrmChangeRequestError(
      "BAD_STATE",
      "the proposal changes nothing — file a new request only when the position link or dates actually change",
    );
  }
  await assertNoPrimaryConflict(exec, {
    orgId,
    employmentId: request.employment_id,
    slotId,
    isPrimary: base.is_primary,
    windowStart,
    windowEnd,
  });
  const successorNo = Math.max(...live.map((version) => version.version_no)) + 1;
  const warnings = await positionLinkWarnings(exec, {
    orgId,
    target,
    windowStart,
    asKnown: recordedAtIso,
    assignment: {
      title: base.job_title,
      departmentId: base.department_id,
      locationId: base.location_id,
    },
  });
  const changeId = await insertEmploymentChange(exec, {
    orgId,
    employmentId: request.employment_id,
    assignmentId: slotId,
    revision: newRevision,
    changeKind: "assignment_superseded",
    priorSnapshot: {
      slot: payload.assignmentKey,
      priorPositionId: base.position_id,
      positionId: payload.positionId,
      positionWarnings: warnings,
      closed: overlapping.map((version) => ({
        versionNo: version.version_no,
        positionId: version.position_id,
        effectiveFrom: version.effective_from,
        effectiveTo: version.effective_to,
      })),
    },
    closedVersions: overlapping.map((version) => ({
      table: "employment_assignment_versions",
      identity: slotId,
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
      update employment_assignment_versions
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
        "an assignment version changed while the approval was applying — retry the decision",
      );
    }
  }
  await exec.execute(sql`
    insert into employment_assignment_versions
      (org_id, assignment_id, employment_id, position_id, version_no,
       job_title, department_id, location_id, fte, is_primary,
       effective_from, effective_to, recorded_at, created_by, updated_by)
    values (${orgId}, ${slotId}, ${request.employment_id}, ${payload.positionId}, ${successorNo},
            ${base.job_title}, ${base.department_id}, ${base.location_id},
            ${base.fte}, ${base.is_primary},
            ${windowStart}::date, ${windowEnd}::date,
            ${recordedAt}, ${actorId}, ${actorId})
  `);
  await insertRetainedAssignmentPortions(exec, {
    orgId,
    actorId,
    slotId,
    employmentId: request.employment_id,
    overlapping,
    windowStart,
    windowEnd,
    firstVersionNo: successorNo + 1,
    recordedAt,
  });
  await recordPositionAssignmentEvent(exec, {
    orgId,
    actorId,
    positionId: payload.positionId,
    employmentId: request.employment_id,
    assignmentKey: payload.assignmentKey,
    priorPositionId: base.position_id,
    disagreementWarnings: warnings,
    reason: request.reason ?? "",
    positionRevision: target?.revision ?? 0,
  });
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
 * No-silent-inheritance preflight for a position link: compare the carried
 * assignment content against the target position's version as of the
 * successor window start. A position covering no version at that date
 * warns (the link still applies); an ambiguous position chain propagates
 * and fails the whole application. Position-side errors arrive as
 * HrmPositionError and are rehomed here so the change-request boundary
 * speaks one error type with the message intact.
 */
/**
 * The database clock as the driver hands it back: timestamptz arrives as
 * TEXT in this codebase, not a Date. It is bound straight back into SQL for
 * every recorded_at / recorded_until write (one clock, one value) and never
 * has Date methods called on it; a caller that needs an ISO instant takes
 * the to_char text selected beside it (recordedAtIso). Typing this as Date
 * once let `.toISOString()` reach runtime on an approval and fail with a
 * remedy that said "retry".
 */
