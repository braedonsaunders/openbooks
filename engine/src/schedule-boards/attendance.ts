/**
 * Device attendance for Unified Scheduling: time-clock devices, dated
 * source identities, effective-dated board policies, idempotent check-in
 * batches and attendance observations of published bookings.
 *
 * Integrity rules:
 *  - a device keeps its code, legal entity and source time zone;
 *  - a source worker identifier maps to one person over a half-open window
 *    in the device's local dates, and never to two people at once;
 *  - a batch replay with the same request key and content returns the
 *    original batch; a source event version arrives once with one content;
 *    corrections append the next version and release the earlier version's
 *    attribution;
 *  - completeness is the device's declared watermark, never the latest
 *    check-in, and it never moves backwards;
 *  - an observation is immutable evidence attributed to one booking; a
 *    correction supersedes the latest observation of that booking.
 *
 * Attendance never becomes approved time or pay: timesheets and payroll
 * keep their own lifecycles.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, withTransactionSavepoint } from "../platform/db.ts";
import { addCalendarDays, isIsoCalendarDate } from "../platform/civil-date.ts";
import { canonicalTimeZone } from "../platform/time-zone.ts";
import { isUuid } from "../platform/uuid.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError, subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import {
  boardAuthority,
  getBoard,
  requireBoardCapability,
  type ScheduleActor,
  type ScheduleBoard,
} from "./boards.ts";
import { ScheduleError, scheduleDatabaseRefusal } from "./errors.ts";
import { hash, lockStored, checkRevision } from "./entries.ts";
import {
  attendancePolicy,
  captureWindow,
  observeAttendance,
  requireInstant,
  type AttendancePolicy,
  type CheckIn,
} from "./attendance-math.ts";
import { requireDate } from "./spans.ts";

type AttendancePermission = "hrm.attendance.read" | "hrm.attendance.manage";

const INSTANT = (column: ReturnType<typeof sql>) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function requireId(value: unknown, field: string): string {
  if (!isUuid(value))
    throw new ScheduleError(`${field} is not recognized.`, { code: "schedule_invalid" });
  return value;
}

function text(value: unknown, field: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) {
    throw new ScheduleError(`${field} needs 1 through ${maximum} characters.`, {
      code: "schedule_invalid",
      remedy: `Enter the ${field.toLowerCase()}.`,
    });
  }
  return value.trim();
}

/** Device attendance needs Human Resources and Device attendance switched on. */
export async function attendanceAuthority(
  actor: ScheduleActor,
  permission: AttendancePermission,
  subsidiaryId: string | null,
): Promise<ReadonlySet<string> | null> {
  if (
    !(await lockAndCheckOrgFeature(db, actor.orgId, "hrm")) ||
    !(await lockAndCheckOrgFeature(db, actor.orgId, "hrmAttendance"))
  ) {
    throw new ScheduleError("Device attendance is switched off for this organization.", {
      status: 404,
      code: "schedule_attendance_disabled",
      remedy:
        "Enable Human Resources and Device attendance on Company Settings → Features; existing attendance history is preserved.",
    });
  }
  return lockActorCommandAuthority(db, actor.orgId, actor.actorId, subsidiaryId, permission);
}

export type AttendanceDevice = {
  readonly id: string;
  readonly subsidiaryId: string;
  readonly code: string;
  readonly name: string;
  readonly timeZone: string;
  readonly isActive: boolean;
  readonly revision: number;
};
const DEVICE_COLUMNS = sql`id, subsidiary_id as "subsidiaryId", code, name, time_zone as "timeZone", is_active as "isActive", revision`;

async function lockDevice(
  actor: ScheduleActor,
  id: string,
  permission: AttendancePermission,
  mode: "update" | "share" | "none",
): Promise<AttendanceDevice> {
  const head = (
    await db.execute<{ subsidiaryId: string }>(
      sql`select subsidiary_id as "subsidiaryId" from schedule_attendance_devices where org_id = ${actor.orgId} and id = ${requireId(id, "Device")}`,
      "objects",
    )
  )[0];
  if (!head) throw new ScopeNotFoundError();
  await attendanceAuthority(actor, permission, head.subsidiaryId);
  const row = (
    await db.execute<AttendanceDevice>(
      sql`select ${DEVICE_COLUMNS} from schedule_attendance_devices where org_id = ${actor.orgId} and id = ${id}
    ${mode === "update" ? sql`for update` : mode === "share" ? sql`for share` : sql``}`,
      "objects",
    )
  )[0];
  if (!row) throw new ScopeNotFoundError();
  return row;
}

/** The active devices whose check-ins the actor may import, in code order. */
export async function listAttendanceDevices(actor: ScheduleActor): Promise<AttendanceDevice[]> {
  return withOrgTransaction(actor.orgId, async () => {
    const allowed = await attendanceAuthority(actor, "hrm.attendance.manage", null);
    return await db.execute<AttendanceDevice>(
      sql`select ${DEVICE_COLUMNS} from schedule_attendance_devices
      where org_id = ${actor.orgId} and is_active ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed)} order by code, id`,
      "objects",
    );
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

/** Register a device, or rename and (de)activate an existing one. */
export async function saveAttendanceDevice(
  actor: ScheduleActor,
  input: {
    id?: string;
    expectedRevision?: number;
    subsidiaryId: string;
    code: string;
    name: string;
    timeZone: string;
    isActive: boolean;
    reason: string;
  },
): Promise<{ id: string; record: AttendanceDevice }> {
  const name = text(input.name, "Device name", 160),
    reason = text(input.reason, "Reason", 2000);
  if (typeof input.isActive !== "boolean")
    throw new ScheduleError("Choose whether the device is active.", { code: "schedule_invalid" });
  return withOrgTransaction(actor.orgId, async () => {
    if (input.expectedRevision !== undefined) {
      const device = await lockDevice(
        actor,
        requireId(input.id, "Device"),
        "hrm.attendance.manage",
        "update",
      );
      if (
        device.code !== input.code ||
        device.subsidiaryId !== input.subsidiaryId ||
        device.timeZone !== input.timeZone
      ) {
        throw new ScheduleError("A device keeps its code, legal entity and time zone.", {
          code: "schedule_invalid",
          remedy: "Register a new device for a changed source.",
        });
      }
      if (device.revision !== input.expectedRevision)
        throw new ScheduleError("Someone changed this device since it was loaded.", {
          status: 409,
          code: "schedule_stale",
          remedy: "Reload the device.",
        });
      const updated = await db.execute<AttendanceDevice>(
        sql`update schedule_attendance_devices set name = ${name}, is_active = ${input.isActive}, reason = ${reason},
        revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
        where org_id = ${actor.orgId} and id = ${device.id} and revision = ${input.expectedRevision} returning ${DEVICE_COLUMNS}`,
        "objects",
      );
      if (updated.length !== 1)
        throw new ScheduleError("Someone changed this device since it was loaded.", {
          status: 409,
          code: "schedule_stale",
          remedy: "Reload the device.",
        });
      return { id: device.id, record: updated[0]! };
    }
    const subsidiaryId = requireId(input.subsidiaryId, "Legal entity");
    const code = text(input.code, "Device code", 64);
    const timeZone = canonicalTimeZone(input.timeZone);
    if (!timeZone || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)*$/.test(input.timeZone)) {
      throw new ScheduleError("The device time zone is unknown.", {
        code: "schedule_invalid_time_zone",
        remedy: "Choose the device's named source time zone, such as America/Toronto.",
      });
    }
    await attendanceAuthority(actor, "hrm.attendance.manage", subsidiaryId);
    if (
      !(
        await db.execute(
          sql`select id from subsidiaries where org_id = ${actor.orgId} and id = ${subsidiaryId} and is_active for share`,
          "objects",
        )
      ).length
    )
      throw new ScopeNotFoundError();
    const id = input.id === undefined ? crypto.randomUUID() : requireId(input.id, "Device key");
    const saved = await db.execute<AttendanceDevice>(
      sql`insert into schedule_attendance_devices (id, org_id, subsidiary_id, code, name, time_zone, is_active, reason, request_hash, created_by, updated_by)
      values (${id}, ${actor.orgId}, ${subsidiaryId}, ${code}, ${name}, ${timeZone}, ${input.isActive}, ${reason}, ${hash({ subsidiaryId, code, name, timeZone, reason })}, ${actor.actorId}, ${actor.actorId})
      returning ${DEVICE_COLUMNS}`,
      "objects",
    );
    if (saved.length !== 1)
      throw new ScheduleError("The device was not saved.", {
        code: "schedule_not_saved",
        remedy: "Reload Setup and try again.",
      });
    return { id, record: saved[0]! };
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

export type AttendanceIdentity = {
  readonly id: string;
  readonly deviceId: string;
  readonly sourceWorkerId: string;
  readonly workerPartyId: string;
  readonly employmentId: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly revision: number;
};
const IDENTITY_COLUMNS = sql`id, device_id as "deviceId", source_worker_id as "sourceWorkerId", worker_party_id as "workerPartyId", employment_id as "employmentId",
  effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo", revision, subsidiary_id as "subsidiaryId"`;

/** Map a device's source worker identifier to a person from a date; or end an existing mapping. */
export async function saveAttendanceIdentity(
  actor: ScheduleActor,
  input: {
    id?: string;
    expectedRevision?: number;
    deviceId: string;
    sourceWorkerId: string;
    workerPartyId: string;
    employmentId?: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
    reason: string;
  },
): Promise<{ id: string; record: AttendanceIdentity }> {
  const reason = text(input.reason, "Reason", 2000);
  return withOrgTransaction(actor.orgId, async () => {
    const device = await lockDevice(actor, input.deviceId, "hrm.attendance.manage", "update");
    if (input.expectedRevision !== undefined) {
      const row = (
        await db.execute<AttendanceIdentity>(
          sql`select ${IDENTITY_COLUMNS} from schedule_attendance_identities where org_id = ${actor.orgId}
        and id = ${requireId(input.id, "Mapping")} and device_id = ${device.id} for update`,
          "objects",
        )
      )[0];
      if (!row) throw new ScopeNotFoundError();
      if (
        row.sourceWorkerId !== input.sourceWorkerId ||
        row.workerPartyId !== input.workerPartyId ||
        row.effectiveFrom !== input.effectiveFrom ||
        (input.employmentId !== undefined && row.employmentId !== input.employmentId)
      ) {
        throw new ScheduleError("A device mapping keeps its identifier, person and start.", {
          code: "schedule_invalid",
          remedy: "End this mapping and create a new one.",
        });
      }
      if (row.revision !== input.expectedRevision)
        throw new ScheduleError("Someone changed this mapping since it was loaded.", {
          status: 409,
          code: "schedule_stale",
          remedy: "Reload the device.",
        });
      const effectiveTo = requireDate(input.effectiveTo, "End date");
      if (
        effectiveTo <= row.effectiveFrom ||
        (row.effectiveTo !== null && effectiveTo > row.effectiveTo)
      ) {
        throw new ScheduleError(
          "The mapping can end after its start and no later than its current end.",
          {
            code: "schedule_invalid_range",
            remedy: "Choose the first local date the identifier no longer belongs to this person.",
          },
        );
      }
      const updated = await db.execute<AttendanceIdentity>(
        sql`update schedule_attendance_identities set effective_to = ${effectiveTo}, reason = ${reason},
        revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
        where org_id = ${actor.orgId} and id = ${row.id} and revision = ${input.expectedRevision} returning ${IDENTITY_COLUMNS}`,
        "objects",
      );
      if (updated.length !== 1)
        throw new ScheduleError("Someone changed this mapping since it was loaded.", {
          status: 409,
          code: "schedule_stale",
          remedy: "Reload the device.",
        });
      return { id: row.id, record: updated[0]! };
    }
    const sourceWorkerId = text(input.sourceWorkerId, "Source worker identifier", 160);
    const effectiveFrom = requireDate(input.effectiveFrom, "Start date");
    const effectiveTo =
      input.effectiveTo === null ? null : requireDate(input.effectiveTo, "End date");
    if (effectiveTo !== null && effectiveTo <= effectiveFrom)
      throw new ScheduleError("The mapping must end after it starts.", {
        code: "schedule_invalid_range",
        remedy: "Choose a later end date or leave it open.",
      });
    const person = (
      await db.execute<{ id: string; subsidiary_id: string | null }>(
        sql`select p.id, p.subsidiary_id from parties p join employee_roles er on er.org_id = p.org_id and er.party_id = p.id
      where p.org_id = ${actor.orgId} and p.id = ${requireId(input.workerPartyId, "Person")} and p.is_active and er.is_active for share of p`,
        "objects",
      )
    )[0];
    if (!person)
      throw new ScheduleError("This person cannot be mapped.", {
        code: "schedule_person_unavailable",
        remedy: "Pick an active employee.",
      });
    const root = (
      await db.execute<{ id: string }>(
        sql`select id from subsidiaries where org_id = ${actor.orgId} and parent_id is null for share`,
        "objects",
      )
    )[0];
    if (!root)
      throw new ScheduleError("This organization has no root legal entity.", {
        code: "schedule_entity_missing",
        remedy: "Complete organization legal-entity setup before mapping attendance identities.",
      });
    const personSubsidiaryId = person.subsidiary_id ?? root.id;
    if (personSubsidiaryId !== device.subsidiaryId) {
      throw new ScheduleError("This person is not available for the device's legal entity.", {
        status: 404,
        code: "schedule_person_unavailable",
        remedy: "Choose an active employee assigned to the device's legal entity.",
      });
    }
    let employmentId: string | null = input.employmentId ?? null;
    if (input.employmentId === undefined) {
      const employments = await db.execute<{ id: string }>(
        sql`select id from worker_employments where org_id = ${actor.orgId} and worker_party_id = ${person.id}
        and employer_subsidiary_id = ${device.subsidiaryId} order by id for share`,
        "objects",
      );
      if (employments.length > 1)
        throw new ScheduleError(
          "This person has more than one employment with the device's legal entity.",
          {
            code: "schedule_employment_ambiguous",
            remedy: "Choose the employment the identifier belongs to.",
          },
        );
      employmentId = employments[0]?.id ?? null;
    } else if (input.employmentId !== null) {
      const requestedEmploymentId = requireId(input.employmentId, "Employment");
      const employment = (
        await db.execute<{ id: string }>(
          sql`select id from worker_employments
        where org_id = ${actor.orgId} and id = ${requestedEmploymentId} and worker_party_id = ${person.id}
          and employer_subsidiary_id = ${device.subsidiaryId} for share`,
          "objects",
        )
      )[0];
      if (!employment) {
        throw new ScheduleError(
          "The employment is not available for this person and device's legal entity.",
          {
            status: 404,
            code: "schedule_employment_unavailable",
            remedy: "Choose an employment belonging to this employee in the device's legal entity.",
          },
        );
      }
      employmentId = employment.id;
    }
    const id = crypto.randomUUID();
    const saved = await db.execute<AttendanceIdentity>(
      sql`insert into schedule_attendance_identities (id, org_id, device_id, source_worker_id, subsidiary_id, worker_party_id, employment_id,
      effective_from, effective_to, reason, request_hash, created_by, updated_by)
      values (${id}, ${actor.orgId}, ${device.id}, ${sourceWorkerId}, ${device.subsidiaryId}, ${person.id}, ${employmentId}, ${effectiveFrom}, ${effectiveTo}, ${reason},
      ${hash({ deviceId: device.id, sourceWorkerId, workerPartyId: person.id, employmentId, effectiveFrom, effectiveTo, reason })}, ${actor.actorId}, ${actor.actorId}) returning ${IDENTITY_COLUMNS}`,
      "objects",
    );
    if (saved.length !== 1)
      throw new ScheduleError("The mapping was not saved.", {
        code: "schedule_not_saved",
        remedy: "Reload the device and try again.",
      });
    return { id, record: saved[0]! };
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

export type AttendancePolicyVersion = AttendancePolicy & {
  readonly id: string;
  readonly boardId: string;
  readonly effectiveFrom: string;
};
const POLICY_COLUMNS = sql`id, board_id as "boardId", effective_from::text as "effectiveFrom", capture_before_minutes as "captureBeforeMinutes",
  capture_after_minutes as "captureAfterMinutes", late_grace_minutes as "lateGraceMinutes", early_grace_minutes as "earlyGraceMinutes", break_grace_minutes as "breakGraceMinutes"`;

/** Add a board attendance policy version effective from a date. Versions are immutable. */
export async function addAttendancePolicy(
  actor: ScheduleActor,
  input: AttendancePolicy & { boardId: string; effectiveFrom: string; reason: string },
): Promise<{ id: string; record: AttendancePolicyVersion }> {
  const policy = attendancePolicy(input),
    effectiveFrom = requireDate(input.effectiveFrom, "Effective date"),
    reason = text(input.reason, "Reason", 2000);
  return withOrgTransaction(actor.orgId, async () => {
    const board = await peopleBoard(actor, input.boardId);
    await boardAuthority(actor, board, "read");
    const allowed = await attendanceAuthority(actor, "hrm.attendance.manage", board.subsidiaryId);
    if (board.subsidiaryId === null && allowed !== null) {
      throw new ScheduleError(
        "Organization-wide attendance policies are managed by people with access to every legal entity.",
        {
          status: 403,
          code: "schedule_scope",
          remedy: "Choose a people board assigned to a legal entity you are authorized to manage.",
        },
      );
    }
    await db.execute(
      sql`select id from schedule_boards where org_id = ${actor.orgId} and id = ${board.id} for update`,
    );
    const id = crypto.randomUUID();
    const saved = await db.execute<AttendancePolicyVersion>(
      sql`insert into schedule_attendance_policies (id, org_id, board_id, effective_from, capture_before_minutes, capture_after_minutes,
      late_grace_minutes, early_grace_minutes, break_grace_minutes, reason, created_by)
      values (${id}, ${actor.orgId}, ${board.id}, ${effectiveFrom}, ${policy.captureBeforeMinutes}, ${policy.captureAfterMinutes}, ${policy.lateGraceMinutes},
      ${policy.earlyGraceMinutes}, ${policy.breakGraceMinutes}, ${reason}, ${actor.actorId}) returning ${POLICY_COLUMNS}`,
      "objects",
    );
    if (saved.length !== 1)
      throw new ScheduleError("The policy was not saved.", {
        code: "schedule_not_saved",
        remedy: "Reload the board settings and try again.",
      });
    return { id, record: saved[0]! };
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

export interface SourceCheckIn {
  readonly id: string;
  readonly sourceEventId: string;
  readonly sourceVersion: number;
  readonly sourceWorkerId: string;
  readonly kind: CheckIn["kind"] | "void";
  readonly occurredAt: string;
  readonly sourcePayload: Readonly<Record<string, unknown>>;
  readonly supersedesId: string | null;
}

export type AttendanceBatch = {
  readonly id: string;
  readonly deviceId: string;
  readonly completeThrough: string | null;
  readonly eventCount: number;
  readonly replayedEventIds: readonly string[];
  readonly workerPartyIds: readonly string[];
  readonly from: string | null;
  readonly through: string | null;
};

function sourceHash(event: SourceCheckIn): string {
  const { id: _requestId, ...source } = event;
  return hash(source);
}

/**
 * Admit a batch of device check-ins with the device's declared completeness.
 * Replaying the same request key with the same content returns the batch;
 * a source event version already admitted with the same content is
 * recorded as replayed, never duplicated.
 */
export async function admitAttendanceBatch(
  actor: ScheduleActor & {
    id: string;
    deviceId: string;
    completeThrough: string | null;
    correction?: boolean;
    sourceEvidence: Readonly<Record<string, unknown>>;
    events: readonly SourceCheckIn[];
    reason: string;
  },
): Promise<AttendanceBatch> {
  const id = requireId(actor.id, "Batch key"),
    deviceId = requireId(actor.deviceId, "Device"),
    reason = text(actor.reason, "Reason", 2000);
  if (actor.completeThrough !== null) requireInstant(actor.completeThrough, "Device completeness");
  if (!Array.isArray(actor.events) || actor.events.length > 10000)
    throw new ScheduleError("A batch admits at most 10000 check-ins.", {
      code: "schedule_invalid",
      remedy: "Import a shorter source window.",
    });
  const evidence = actor.sourceEvidence;
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    typeof evidence.source !== "string" ||
    !evidence.source.trim()
  ) {
    throw new ScheduleError("Check-in batches need source evidence.", {
      code: "schedule_invalid",
      remedy: "Identify the source connection or import file.",
    });
  }
  const events = actor.events
    .map((event) => {
      requireInstant(event.occurredAt, "Check-in time");
      if (!["clock_in", "clock_out", "break_start", "break_end", "void"].includes(event.kind)) {
        throw new ScheduleError("A check-in kind is undeclared.", {
          code: "schedule_invalid",
          remedy: "Use clock-in, clock-out, break start, break end or a void correction.",
        });
      }
      if (
        !event.sourcePayload ||
        typeof event.sourcePayload !== "object" ||
        Array.isArray(event.sourcePayload)
      ) {
        throw new ScheduleError("A check-in is missing its source fields.", {
          code: "schedule_invalid",
          remedy: "Keep the device's source record with each check-in.",
        });
      }
      if (!Number.isSafeInteger(event.sourceVersion) || event.sourceVersion < 1)
        throw new ScheduleError("A check-in source version must be a whole number from 1.", {
          code: "schedule_invalid",
        });
      return {
        id: requireId(event.id, "Check-in key"),
        sourceEventId: text(event.sourceEventId, "Source event identifier", 160),
        sourceVersion: event.sourceVersion,
        sourceWorkerId: text(event.sourceWorkerId, "Source worker identifier", 160),
        kind: event.kind,
        occurredAt: event.occurredAt,
        sourcePayload: event.sourcePayload,
        supersedesId:
          event.supersedesId === null ? null : requireId(event.supersedesId, "Corrected check-in"),
      };
    })
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  if (
    new Set(events.map((event) => event.id.toLowerCase())).size !== events.length ||
    new Set(events.map((event) => `${event.sourceEventId}:${event.sourceVersion}`)).size !==
      events.length
  ) {
    throw new ScheduleError("A batch repeats a check-in key or source version.", {
      code: "schedule_invalid",
      remedy: "Keep one record for each source event version.",
    });
  }
  const correction = actor.correction === true;
  const requestHash = hash({
    deviceId,
    completeThrough: actor.completeThrough,
    correction,
    sourceEvidence: evidence,
    events,
    reason,
  });
  return withOrgTransaction(actor.orgId, async () => {
    const device = await lockDevice(actor, deviceId, "hrm.attendance.manage", "none");
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`schedule-attendance-batch:${actor.orgId}:${id}`}, 0))`,
    );
    const prior = (
      await db.execute<{ requestHash: string; createdBy: string }>(
        sql`select request_hash as "requestHash", created_by as "createdBy"
      from schedule_attendance_batches where org_id = ${actor.orgId} and id = ${id}`,
        "objects",
      )
    )[0];
    if (prior) {
      if (prior.requestHash !== requestHash || prior.createdBy !== actor.actorId) {
        throw new ScheduleError("This batch key was already used for different check-ins.", {
          status: 409,
          code: "schedule_key_reused",
          remedy: "Import the check-ins under a new batch key; the existing batch is preserved.",
        });
      }
      return readBatch(actor.orgId, id);
    }
    const mappings: {
      id: string;
      workerPartyId: string;
      employmentId: string | null;
      subsidiaryId: string;
      localDate: string;
    }[] = [];
    for (const event of events) {
      const found = await db.execute<{
        id: string;
        workerPartyId: string;
        employmentId: string | null;
        subsidiaryId: string;
        localDate: string;
      }>(
        sql`
        select id, worker_party_id as "workerPartyId", employment_id as "employmentId", subsidiary_id as "subsidiaryId",
          (${event.occurredAt}::timestamptz at time zone ${device.timeZone})::date::text as "localDate"
        from schedule_attendance_identities where org_id = ${actor.orgId} and device_id = ${device.id} and source_worker_id = ${event.sourceWorkerId}
          and effective_from <= (${event.occurredAt}::timestamptz at time zone ${device.timeZone})::date
          and (effective_to is null or effective_to > (${event.occurredAt}::timestamptz at time zone ${device.timeZone})::date)`,
        "objects",
      );
      if (found.length !== 1) {
        throw new ScheduleError(
          `Device worker ${event.sourceWorkerId} has no mapping for ${event.occurredAt.slice(0, 10)}.`,
          {
            code: "schedule_attendance_unmapped",
            remedy:
              "Map the device's worker identifier to the person for that date in Setup → Attendance devices, then import again.",
          },
        );
      }
      mappings.push(found[0]!);
    }
    await db.execute(
      sql`select id from schedule_attendance_devices where org_id = ${actor.orgId} and id = ${device.id} for update`,
    );
    for (const identityId of [...new Set(mappings.map((mapping) => mapping.id))].sort()) {
      await db.execute(
        sql`select id from schedule_attendance_identities where org_id = ${actor.orgId} and id = ${identityId} for share`,
      );
    }
    const novel: number[] = [],
      replayed: string[] = [];
    for (const [index, event] of events.entries()) {
      const stored = (
        await db.execute<{ id: string; requestHash: string }>(
          sql`select id, request_hash as "requestHash" from schedule_attendance_events
        where org_id = ${actor.orgId} and device_id = ${device.id} and source_event_id = ${event.sourceEventId} and source_version = ${event.sourceVersion} for share`,
          "objects",
        )
      )[0];
      if (!stored) novel.push(index);
      else if (stored.requestHash === sourceHash(event)) replayed.push(stored.id);
      else
        throw new ScheduleError(
          `Source event ${event.sourceEventId} version ${event.sourceVersion} was already admitted with different content.`,
          {
            code: "schedule_attendance_conflict",
            remedy:
              "Keep the admitted version and send the next source version as a correction naming it.",
          },
        );
    }
    const sourceEvidence = {
      ...evidence,
      receivedCount: events.length,
      replayedEventIds: replayed,
    };
    const inserted = await db.execute(
      sql`insert into schedule_attendance_batches (id, org_id, device_id, complete_through, is_correction, source_evidence, event_count, reason, request_hash, created_by)
      values (${id}, ${actor.orgId}, ${device.id}, ${actor.completeThrough}, ${correction}, ${JSON.stringify(sourceEvidence)}::jsonb, ${novel.length}, ${reason}, ${requestHash}, ${actor.actorId}) returning id`,
      "objects",
    );
    if (inserted.length !== 1)
      throw new ScheduleError("The batch was not saved.", {
        code: "schedule_not_saved",
        remedy: "Import the check-ins again.",
      });
    for (const index of novel) {
      const event = events[index]!,
        mapping = mappings[index]!;
      if (event.supersedesId) {
        const released = await db.execute(
          sql`update schedule_attendance_event_claims set released_at = now(), released_by = ${actor.actorId}, release_reason = ${reason}
          where org_id = ${actor.orgId} and event_id = ${event.supersedesId} and released_at is null returning id`,
          "objects",
        );
        void released;
      }
      const saved = await db.execute(
        sql`insert into schedule_attendance_events (id, org_id, device_id, batch_id, identity_id, subsidiary_id, worker_party_id, employment_id,
        source_event_id, source_version, kind, occurred_at, source_local_date, source_payload, supersedes_id, reason, request_hash, created_by)
        values (${event.id}, ${actor.orgId}, ${device.id}, ${id}, ${mapping.id}, ${mapping.subsidiaryId}, ${mapping.workerPartyId}, ${mapping.employmentId},
        ${event.sourceEventId}, ${event.sourceVersion}, ${event.kind}, ${event.occurredAt}, ${mapping.localDate}, ${JSON.stringify(event.sourcePayload)}::jsonb,
        ${event.supersedesId}, ${reason}, ${sourceHash(event)}, ${actor.actorId}) returning id`,
        "objects",
      );
      if (saved.length !== 1)
        throw new ScheduleError("A check-in was not saved.", {
          code: "schedule_not_saved",
          remedy: "Import the batch again.",
        });
    }
    if (actor.completeThrough !== null) {
      const watermark = (
        await db.execute<{ id: string; revision: number }>(
          sql`select id, revision from schedule_attendance_watermarks where org_id = ${actor.orgId} and device_id = ${device.id} for update`,
          "objects",
        )
      )[0];
      const written = watermark
        ? await db.execute(
            sql`update schedule_attendance_watermarks set batch_id = ${id}, complete_through = ${actor.completeThrough}, reason = ${reason},
            revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId} where org_id = ${actor.orgId} and id = ${watermark.id} and revision = ${watermark.revision} returning id`,
            "objects",
          )
        : await db.execute(
            sql`insert into schedule_attendance_watermarks (org_id, device_id, batch_id, complete_through, reason, created_by, updated_by)
            values (${actor.orgId}, ${device.id}, ${id}, ${actor.completeThrough}, ${reason}, ${actor.actorId}, ${actor.actorId}) returning id`,
            "objects",
          );
      if (written.length !== 1)
        throw new ScheduleError("The device completeness was not recorded.", {
          status: 409,
          code: "schedule_stale",
          remedy: "Import the batch again.",
        });
    }
    return readBatch(actor.orgId, id);
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

async function readBatch(orgId: string, id: string): Promise<AttendanceBatch> {
  const row = (
    await db.execute<{
      id: string;
      deviceId: string;
      completeThrough: string | null;
      eventCount: number;
      replayed: string[] | null;
    }>(
      sql`
    select id, device_id as "deviceId", ${INSTANT(sql`complete_through`)} as "completeThrough", event_count as "eventCount",
      array(select jsonb_array_elements_text(source_evidence->'replayedEventIds')) as replayed
    from schedule_attendance_batches where org_id = ${orgId} and id = ${id}`,
      "objects",
    )
  )[0];
  if (!row) throw new ScopeNotFoundError();
  const scope = (
    await db.execute<{ workers: string[]; from: string | null; through: string | null }>(
      sql`
    select coalesce(array_agg(distinct e.worker_party_id::text), '{}') as workers, ${INSTANT(sql`min(e.occurred_at)`)} as "from", ${INSTANT(sql`max(e.occurred_at)`)} as through
    from schedule_attendance_events e where e.org_id = ${orgId} and (e.batch_id = ${id} or e.id = any(${`{${(row.replayed ?? []).join(",")}}`}::uuid[]))`,
      "objects",
    )
  )[0]!;
  return {
    id: row.id,
    deviceId: row.deviceId,
    completeThrough: row.completeThrough,
    eventCount: row.eventCount,
    replayedEventIds: row.replayed ?? [],
    workerPartyIds: scope.workers,
    from: scope.from,
    through: scope.through,
  };
}

export type AttendanceOutcome =
  | {
      readonly entryId: string;
      readonly ok: true;
      readonly status: "waiting_for_sync" | "absent" | "present" | "voided";
      readonly observationId: string;
      readonly unchanged: boolean;
    }
  | {
      readonly entryId: string;
      readonly ok: false;
      readonly message: string;
      readonly remedy: string | null;
    };

type EntryForAttendance = {
  id: string;
  revision: number;
  boardId: string;
  status: "published" | "cancelled";
  workerPartyId: string;
  employmentId: string | null;
  subsidiaryId: string | null;
  startsOn: string;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  closed: boolean;
};
const ENTRY_COLUMNS = sql`e.id, e.revision, e.board_id as "boardId", e.status, e.worker_party_id as "workerPartyId", e.employment_id as "employmentId",
  e.subsidiary_id as "subsidiaryId", e.starts_on::text as "startsOn", ${INSTANT(sql`e.starts_at`)} as "startsAt", ${INSTANT(sql`e.ends_at`)} as "endsAt",
  e.break_minutes as "breakMinutes", e.closed_at is not null as closed`;

/** Observe one booking's attendance from its current device evidence. */
async function observeEntry(
  actor: ScheduleActor,
  entryId: string,
  reason: string,
): Promise<AttendanceOutcome> {
  const entry = (
    await db.execute<EntryForAttendance>(
      sql`select ${ENTRY_COLUMNS} from schedule_entries e
    where e.org_id = ${actor.orgId} and e.id = ${entryId} and e.worker_party_id is not null and e.status in ('published', 'cancelled')`,
      "objects",
    )
  )[0];
  if (!entry) throw new ScopeNotFoundError();
  if (entry.closed)
    throw new ScheduleError("This shift is closed.", {
      code: "schedule_closed",
      remedy: "A closed shift keeps its attendance.",
    });
  // Devices, then the booking: the same order as check-in admission.
  await db.execute(sql`select d.id from schedule_attendance_devices d where d.org_id = ${actor.orgId}
    and exists (select 1 from schedule_attendance_identities i where i.org_id = d.org_id and i.device_id = d.id and i.worker_party_id = ${entry.workerPartyId}) order by d.id for update`);
  await db.execute(
    sql`select id from schedule_entries where org_id = ${actor.orgId} and id = ${entry.id} for update`,
  );
  const previous =
    (
      await db.execute<{ id: string; evidenceHash: string; status: string }>(
        sql`select id, evidence_hash as "evidenceHash", status from schedule_attendance_observations o
    where o.org_id = ${actor.orgId} and o.entry_id = ${entry.id} and not exists (select 1 from schedule_attendance_observations n where n.org_id = o.org_id and n.supersedes_id = o.id) for update`,
        "objects",
      )
    )[0] ?? null;
  const id = crypto.randomUUID();
  if (entry.status === "cancelled") {
    if (!previous || previous.status === "voided") {
      return previous
        ? { entryId, ok: true, status: "voided", observationId: previous.id, unchanged: true }
        : {
            entryId,
            ok: false,
            message: "The booking was cancelled before any attendance was observed.",
            remedy: null,
          };
    }
    const evidenceHash = hash({
      entryId: entry.id,
      revision: entry.revision,
      status: entry.status,
    });
    await insertObservation(
      actor,
      id,
      entry,
      null,
      {
        status: "voided",
        completeThrough: null,
        firstIn: null,
        lastOut: null,
        presenceMilliseconds: null,
        breakMilliseconds: null,
        late: null,
        leftEarly: null,
        overBreak: null,
      },
      { entryRevision: entry.revision, cancelled: true },
      evidenceHash,
      previous.id,
      reason,
    );
    const released =
      await db.execute(sql`update schedule_attendance_event_claims set released_at = now(), released_by = ${actor.actorId}, release_reason = ${reason}
      where org_id = ${actor.orgId} and entry_id = ${entry.id} and released_at is null returning id`);
    void released;
    return { entryId, ok: true, status: "voided", observationId: id, unchanged: false };
  }
  const policy = (
    await db.execute<AttendancePolicyVersion>(
      sql`select ${POLICY_COLUMNS} from schedule_attendance_policies where org_id = ${actor.orgId}
    and board_id = ${entry.boardId} and effective_from <= ${entry.startsOn} order by effective_from desc limit 1`,
      "objects",
    )
  )[0];
  if (!policy) {
    throw new ScheduleError(`The board has no attendance policy for ${entry.startsOn}.`, {
      code: "schedule_attendance_policy_missing",
      remedy:
        "Add an attendance policy for the board effective on or before the booking date in Board settings → Attendance policies.",
    });
  }
  const window = captureWindow(entry, policy);
  const sources = await db.execute<{
    identityId: string;
    deviceId: string;
    completeThrough: string | null;
    covered: boolean;
  }>(
    sql`
    select i.id as "identityId", i.device_id as "deviceId", ${INSTANT(sql`w.complete_through`)} as "completeThrough",
      daterange(i.effective_from, i.effective_to, '[)') @> daterange((${window.from}::timestamptz at time zone d.time_zone)::date, (${window.through}::timestamptz at time zone d.time_zone)::date, '[]') as covered
    from schedule_attendance_identities i join schedule_attendance_devices d on d.org_id = i.org_id and d.id = i.device_id
    left join schedule_attendance_watermarks w on w.org_id = i.org_id and w.device_id = i.device_id
    where i.org_id = ${actor.orgId} and i.worker_party_id = ${entry.workerPartyId}
      and daterange(i.effective_from, i.effective_to, '[)') && daterange((${window.from}::timestamptz at time zone d.time_zone)::date, (${window.through}::timestamptz at time zone d.time_zone)::date, '[]')
    order by i.device_id, i.id`,
    "objects",
  );
  if (!sources.length || sources.some((source) => !source.covered)) {
    throw new ScheduleError("No device mapping covers this booking's whole capture window.", {
      code: "schedule_attendance_unmapped",
      remedy:
        "Map the person's device identifier for the booking's dates in Setup → Attendance devices.",
    });
  }
  const events = await db.execute<CheckIn>(
    sql`select e.id, e.kind, ${INSTANT(sql`e.occurred_at`)} as "occurredAt" from schedule_attendance_events e
    where e.org_id = ${actor.orgId} and e.worker_party_id = ${entry.workerPartyId} and e.occurred_at between ${window.from} and ${window.through} and e.kind <> 'void'
      and not exists (select 1 from schedule_attendance_events n where n.org_id = e.org_id and n.supersedes_id = e.id) order by e.occurred_at, e.id for update`,
    "objects",
  );
  const completeThrough = sources.some((source) => source.completeThrough === null)
    ? null
    : sources.map((source) => source.completeThrough!).sort()[0]!;
  const observed = observeAttendance({ booking: entry, policy, completeThrough, events });
  const evidence = {
    entryRevision: entry.revision,
    policyId: policy.id,
    sources,
    eventIds: observed.eventIds,
    decisionHash: observed.evidenceHash,
  };
  const evidenceHash = hash(evidence);
  if (previous?.evidenceHash === evidenceHash)
    return {
      entryId,
      ok: true,
      status: observed.status,
      observationId: previous.id,
      unchanged: true,
    };
  await insertObservation(
    actor,
    id,
    entry,
    policy.id,
    observed,
    evidence,
    evidenceHash,
    previous?.id ?? null,
    reason,
  );
  for (const eventId of observed.eventIds) {
    let claim = (
      await db.execute<{ id: string; entryId: string }>(
        sql`select id, entry_id as "entryId" from schedule_attendance_event_claims
      where org_id = ${actor.orgId} and event_id = ${eventId} and released_at is null for update`,
        "objects",
      )
    )[0];
    if (claim && claim.entryId !== entry.id) {
      throw new ScheduleError(`Check-in ${eventId} is already attributed to another booking.`, {
        code: "schedule_attendance_conflict",
        remedy:
          "Bookings with overlapping capture windows share check-ins; shorten the attendance policy's capture window or correct the bookings, then process again.",
      });
    }
    claim ??= (
      await db.execute<{ id: string; entryId: string }>(
        sql`insert into schedule_attendance_event_claims (org_id, event_id, entry_id, reason, request_hash, created_by)
      values (${actor.orgId}, ${eventId}, ${entry.id}, ${reason}, ${hash({ observationId: id, eventId })}, ${actor.actorId}) returning id, entry_id as "entryId"`,
        "objects",
      )
    )[0];
    if (!claim)
      throw new ScheduleError("A check-in attribution was not saved.", {
        code: "schedule_not_saved",
        remedy: "Process attendance again.",
      });
    const linked = await db.execute(
      sql`insert into schedule_attendance_observation_events (org_id, observation_id, event_claim_id, reason, request_hash, created_by)
      values (${actor.orgId}, ${id}, ${claim.id}, ${reason}, ${hash({ observationId: id, claimId: claim.id })}, ${actor.actorId}) returning id`,
      "objects",
    );
    if (linked.length !== 1)
      throw new ScheduleError("Observation evidence was not saved.", {
        code: "schedule_not_saved",
        remedy: "Process attendance again.",
      });
  }
  return { entryId, ok: true, status: observed.status, observationId: id, unchanged: false };
}

async function insertObservation(
  actor: ScheduleActor,
  id: string,
  entry: EntryForAttendance,
  policyId: string | null,
  observed: {
    status: string;
    completeThrough: string | null;
    firstIn: string | null;
    lastOut: string | null;
    presenceMilliseconds: number | null;
    breakMilliseconds: number | null;
    late: boolean | null;
    leftEarly: boolean | null;
    overBreak: boolean | null;
  },
  evidence: Record<string, unknown>,
  evidenceHash: string,
  supersedesId: string | null,
  reason: string,
): Promise<void> {
  const saved = await db.execute(
    sql`insert into schedule_attendance_observations (id, org_id, entry_id, board_id, policy_id, subsidiary_id, worker_party_id, employment_id, status,
    complete_through, first_in, last_out, presence_milliseconds, break_milliseconds, late, left_early, over_break, source_evidence, evidence_hash, supersedes_id, reason, request_hash, created_by)
    values (${id}, ${actor.orgId}, ${entry.id}, ${entry.boardId}, ${policyId}, ${entry.subsidiaryId}, ${entry.workerPartyId}, ${entry.employmentId}, ${observed.status},
    ${observed.completeThrough}, ${observed.firstIn}, ${observed.lastOut}, ${observed.presenceMilliseconds}, ${observed.breakMilliseconds}, ${observed.late}, ${observed.leftEarly},
    ${observed.overBreak}, ${JSON.stringify(evidence)}::jsonb, ${evidenceHash}, ${supersedesId}, ${reason}, ${hash({ entryId: entry.id, evidenceHash, supersedesId })}, ${actor.actorId}) returning id`,
    "objects",
  );
  if (saved.length !== 1)
    throw new ScheduleError("The attendance observation was not saved.", {
      code: "schedule_not_saved",
      remedy: "Process attendance again.",
    });
}

/**
 * Observe attendance for a board's started bookings in a date window, or
 * for the bookings of the people a batch named. Each booking is isolated so
 * one refusal is reported without discarding the others.
 */
export async function processBoardAttendance(
  actor: ScheduleActor & {
    boardId: string;
    from: string;
    through: string;
    workerPartyIds?: readonly string[];
    reason?: string | null;
  },
): Promise<AttendanceOutcome[]> {
  const from = requireDate(actor.from, "From"),
    through = requireDate(actor.through, "Through");
  if (through < from || addCalendarDays(from, 62) < through)
    throw new ScheduleError("Process attendance for at most 63 days at a time.", {
      code: "schedule_invalid_range",
      remedy: "Choose a shorter window.",
    });
  return withOrgTransaction(actor.orgId, async () => {
    const board = await peopleBoard(actor, actor.boardId);
    const allowed = await boardAuthority(actor, board, "read");
    await attendanceAuthority(actor, "hrm.attendance.manage", board.subsidiaryId);
    const workers = actor.workerPartyIds?.filter(isUuid) ?? null;
    const entries = await db.execute<{ id: string }>(
      sql`select e.id from schedule_entries e
      where e.org_id = ${actor.orgId} and e.board_id = ${board.id} and e.worker_party_id is not null and e.starts_on between ${from} and ${through}
        and e.starts_at <= now() and e.closed_at is null and not e.removes_predecessor
        and (e.status = 'published' or (e.status = 'cancelled' and exists (select 1 from schedule_attendance_observations o where o.org_id = e.org_id and o.entry_id = e.id)))
        ${workers ? sql`and e.worker_party_id = any(${`{${workers.join(",")}}`}::uuid[])` : sql``}
        ${subsidiaryVisibleFilter(sql`e.subsidiary_id`, allowed)}
      order by e.starts_at, e.id limit 2000`,
      "objects",
    );
    const reason = actor.reason?.trim() || `Attendance processed on ${board.name}`;
    const outcomes: AttendanceOutcome[] = [];
    for (const { id } of entries) {
      try {
        outcomes.push(await withTransactionSavepoint(db, () => observeEntry(actor, id, reason)));
      } catch (error) {
        const refusal = scheduleDatabaseRefusal(error);
        if (!(refusal instanceof ScheduleError)) throw refusal;
        outcomes.push({
          entryId: id,
          ok: false,
          message: refusal.message,
          remedy: refusal.remedy ?? null,
        });
      }
    }
    return outcomes;
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

/** After a batch: observe every board's affected bookings for the people and dates it named. */
export async function processBatchAttendance(
  actor: ScheduleActor & { batch: AttendanceBatch },
): Promise<AttendanceOutcome[]> {
  if (!actor.batch.from || !actor.batch.through || !actor.batch.workerPartyIds.length) return [];
  const boards = await withOrgTransaction(actor.orgId, () =>
    db.execute<{ boardId: string; from: string; through: string }>(
      sql`
    select e.board_id as "boardId", min(e.starts_on)::text as "from", max(e.starts_on)::text as through from schedule_entries e
    where e.org_id = ${actor.orgId} and e.worker_party_id = any(${`{${actor.batch.workerPartyIds.join(",")}}`}::uuid[]) and e.status in ('published', 'cancelled')
      and e.starts_at <= ${actor.batch.through}::timestamptz + interval '12 hours' and e.ends_at >= ${actor.batch.from}::timestamptz - interval '12 hours'
      and exists (select 1 from schedule_attendance_policies p where p.org_id = e.org_id and p.board_id = e.board_id)
    group by e.board_id order by e.board_id`,
      "objects",
    ),
  );
  const outcomes: AttendanceOutcome[] = [];
  for (const board of boards) {
    outcomes.push(
      ...(await processBoardAttendance({
        ...actor,
        boardId: board.boardId,
        from: board.from,
        through: board.through,
        workerPartyIds: actor.batch.workerPartyIds,
        reason: "Attendance processed after a check-in import",
      }).catch((error: unknown) => {
        if (error instanceof ScheduleError || error instanceof ScopeNotFoundError) return [];
        throw error;
      })),
    );
  }
  return outcomes;
}

async function peopleBoard(
  actor: ScheduleActor,
  boardId: string,
  capability: "attendance" | "closing" = "attendance",
): Promise<ScheduleBoard> {
  const board = await getBoard(actor, requireId(boardId, "Board"));
  await requireBoardCapability(actor, board, capability);
  return board;
}

/** Formally close an ended shift whose attendance is current and complete. */
export async function closeShift(
  actor: ScheduleActor & {
    boardId: string;
    entryId: string;
    expectedRevision: number;
    reason: string;
  },
): Promise<void> {
  const reason = text(actor.reason, "Reason", 2000);
  await withOrgTransaction(actor.orgId, async () => {
    if (!(await lockAndCheckOrgFeature(db, actor.orgId, "hrmShiftClosing"))) {
      throw new ScheduleError("Formal shift closing is switched off.", {
        status: 404,
        code: "schedule_closing_disabled",
        remedy:
          "Enable Formal shift closing on Company Settings → Features; published shifts do not need closing.",
      });
    }
    const board = await peopleBoard(actor, actor.boardId, "closing");
    await boardAuthority(actor, board, "manage");
    await attendanceAuthority(actor, "hrm.attendance.read", board.subsidiaryId);
    const row = await lockStored(actor.orgId, board.id, actor.entryId);
    checkRevision(row, actor.expectedRevision);
    if (row.status !== "published" || !row.workerPartyId)
      throw new ScheduleError("Only a person's published shift can be closed.", {
        code: "schedule_invalid",
      });
    const updated = await db.execute(
      sql`update schedule_entries set closed_at = now(), closed_by = ${actor.actorId}, close_reason = ${reason}, reason = ${reason},
      revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${row.id} and revision = ${row.revision} returning id`,
      "objects",
    );
    if (updated.length !== 1)
      throw new ScheduleError("Someone changed this shift since it was loaded.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Reload the board.",
      });
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

export type AttendanceExceptionRow = {
  readonly observationId: string;
  readonly entryId: string;
  readonly boardId: string;
  readonly boardName: string;
  readonly subsidiaryId: string | null;
  readonly workerPartyId: string;
  readonly workerName: string;
  readonly onDate: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly breakMinutes: number;
  readonly status: "waiting_for_sync" | "absent" | "present";
  readonly firstIn: string | null;
  readonly lastOut: string | null;
  readonly presenceMilliseconds: string | null;
  readonly breakMilliseconds: string | null;
  readonly late: boolean;
  readonly leftEarly: boolean;
  readonly overBreak: boolean;
  readonly closed: boolean;
};

export type AttendanceExceptionKind =
  "absent" | "late" | "left_early" | "over_break" | "waiting_for_sync";

/**
 * Current observations of ended bookings that need attention: absences,
 * late arrivals, early leaves, breaks over the planned break and grace, and
 * bookings still waiting for device synchronization.
 */
export async function attendanceExceptions(
  actor: ScheduleActor & {
    from: string;
    through: string;
    subsidiaryId?: string | null;
    boardId?: string | null;
    workerPartyId?: string | null;
    kinds?: readonly AttendanceExceptionKind[];
    search?: string | null;
  },
): Promise<AttendanceExceptionRow[]> {
  const from = requireDate(actor.from, "From"),
    through = requireDate(actor.through, "Through");
  if (through < from)
    throw new ScheduleError("The period ends before it starts.", {
      code: "schedule_invalid_range",
    });
  if (!isIsoCalendarDate(from))
    throw new ScheduleError("The period needs real dates.", { code: "schedule_invalid_date" });
  return withOrgTransaction(actor.orgId, async () => {
    const allowed = await attendanceAuthority(
      actor,
      "hrm.attendance.read",
      actor.subsidiaryId ?? null,
    );
    if (!(await lockAndCheckOrgFeature(db, actor.orgId, "hrmShiftPlanning")))
      throw new ScopeNotFoundError();
    const kinds = new Set<AttendanceExceptionKind>(
      actor.kinds?.length
        ? actor.kinds
        : ["absent", "late", "left_early", "over_break", "waiting_for_sync"],
    );
    const search = actor.search?.trim()
      ? `%${actor.search.trim().replace(/[\\%_]/g, (character) => `\\${character}`)}%`
      : null;
    return await db.execute<AttendanceExceptionRow>(
      sql`
      select o.id as "observationId", e.id as "entryId", e.board_id as "boardId", b.name as "boardName", e.subsidiary_id as "subsidiaryId",
        e.worker_party_id as "workerPartyId", w.display_name as "workerName", e.starts_on::text as "onDate",
        ${INSTANT(sql`e.starts_at`)} as "startsAt", ${INSTANT(sql`e.ends_at`)} as "endsAt", e.time_zone as "timeZone", e.break_minutes as "breakMinutes",
        o.status, ${INSTANT(sql`o.first_in`)} as "firstIn", ${INSTANT(sql`o.last_out`)} as "lastOut",
        o.presence_milliseconds::text as "presenceMilliseconds", o.break_milliseconds::text as "breakMilliseconds",
        coalesce(o.late, false) as late, coalesce(o.left_early, false) as "leftEarly", coalesce(o.over_break, false) as "overBreak", e.closed_at is not null as closed
      from schedule_attendance_observations o
      join schedule_entries e on e.org_id = o.org_id and e.id = o.entry_id
      join schedule_boards b on b.org_id = e.org_id and b.id = e.board_id
      join parties w on w.org_id = e.org_id and w.id = e.worker_party_id
      where o.org_id = ${actor.orgId} and e.status = 'published' and e.ends_at <= now() and e.starts_on between ${from} and ${through}
        and not exists (select 1 from schedule_attendance_observations n where n.org_id = o.org_id and n.supersedes_id = o.id)
        and ((o.status = 'absent' and ${kinds.has("absent")}) or (o.status = 'waiting_for_sync' and ${kinds.has("waiting_for_sync")})
          or (o.status = 'present' and ((o.late and ${kinds.has("late")}) or (o.left_early and ${kinds.has("left_early")}) or (o.over_break and ${kinds.has("over_break")}))))
        ${actor.subsidiaryId ? sql`and e.subsidiary_id = ${actor.subsidiaryId}` : sql``}
        ${actor.boardId ? sql`and e.board_id = ${actor.boardId}` : sql``}
        ${actor.workerPartyId ? sql`and e.worker_party_id = ${actor.workerPartyId}` : sql``}
        ${search ? sql`and (w.display_name ilike ${search} or b.name ilike ${search})` : sql``}
        ${subsidiaryVisibleFilter(sql`e.subsidiary_id`, allowed)}
      order by e.starts_on, w.display_name, e.starts_at, e.id limit 5000`,
      "objects",
    );
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}
