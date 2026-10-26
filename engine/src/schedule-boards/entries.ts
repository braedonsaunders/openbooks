import { scheduleBoardLifecycle } from "./distribution-hooks.ts";
/**
 * Booking commands for people boards. Every command runs in one tenant
 * transaction; each change in a batch is isolated in a savepoint so a paste
 * of fifty cells reports the three that were refused and keeps the rest.
 *
 * Lifecycle: a live board publishes each booking as it is made; a staged
 * board collects drafts until the board is published. A published booking
 * is never rewritten — changing it cancels it and records a successor that
 * names it, so the history of who was sent where is preserved.
 *
 * Every manual publication retains its submitted revisions and tenant Flow
 * policy. Published facts change through a replacement or removal revision;
 * configured native shift requests retain their own Flow decisions.
 *
 * Pattern-generated bookings keep their assignment, date and slot. Editing
 * one marks it as a manual override that regeneration keeps; removing a
 * published one records an omission, so regeneration does not book it again.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "../platform/canonical-json.ts";
import { db, withOrgTransaction, withTransactionSavepoint } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { ScopeNotFoundError, subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { getBoard, boardAuthority, type ScheduleActor, type ScheduleBoard } from "./boards.ts";
import { ScheduleError, scheduleDatabaseRefusal } from "./errors.ts";
import { daySpan, localClock, requireDate, timedSpan, type BookingSpan } from "./spans.ts";
import { resolveTarget, type TargetRef } from "./targets.ts";
import { ENTRY_COLUMNS, ENTRY_JOINS, shapeEntry, type BoardEntry } from "./window.ts";

export type SpanInput =
  | { readonly mode: "day" }
  | {
      readonly mode: "timed";
      readonly starts: string;
      readonly ends: string;
      readonly breakMinutes: number;
    };

export interface BookingFields {
  readonly workerPartyId?: string;
  readonly subject?: { readonly kind: "person" | "equipment" | "location"; readonly id: string };
  readonly onDate: string;
  readonly target: TargetRef | null;
  readonly projectTaskId?: string | null;
  readonly departmentId?: string | null;
  readonly detail?: string | null;
  readonly notes?: string | null;
  readonly span: SpanInput;
  readonly seriesId?: string | null;
}

export type BoardChange =
  | ({ readonly op: "create"; readonly id: string } & BookingFields)
  | {
      readonly op: "update";
      readonly id: string;
      readonly expectedRevision: number;
      readonly fields: Partial<BookingFields>;
    }
  | { readonly op: "cancel"; readonly id: string; readonly expectedRevision: number };

export type ChangeResult =
  | {
      readonly id: string;
      readonly op: BoardChange["op"];
      readonly ok: true;
      readonly entry: BoardEntry | null;
      readonly replacedId: string | null;
    }
  | {
      readonly id: string;
      readonly op: BoardChange["op"];
      readonly ok: false;
      readonly error: string;
      readonly code: string;
      readonly remedy: string | null;
    };

const MAX_CHANGES = 500;

/** A published change a person is told about when their board notifies. */
export interface ScheduleNotice {
  readonly workerPartyId: string;
  readonly onDate: string;
  readonly change: "booked" | "changed" | "removed";
  readonly label: string;
  readonly hours: string | null;
}

export interface BoardChangeOutcome {
  readonly results: ChangeResult[];
  /** Empty unless the board notifies people of published changes. */
  readonly notices: ScheduleNotice[];
  readonly boardName: string;
  readonly distributionRefusals: readonly { message: string; remedy: string }[];
}

function hoursLabel(entry: BoardEntry): string {
  return entry.spanMode === "timed" ? `${entry.startClock}–${entry.endClock}` : "";
}

export function noticeFor(entry: BoardEntry, change: ScheduleNotice["change"]): ScheduleNotice {
  const label =
    [entry.target?.code ?? entry.target?.label ?? "", entry.detail ? `/${entry.detail}` : ""]
      .join("")
      .trim() || "—";
  if (!entry.workerPartyId)
    throw new ScheduleError("Only people bookings send employee notifications.");
  return {
    workerPartyId: entry.workerPartyId,
    onDate: entry.startsOn,
    change,
    label,
    hours: hoursLabel(entry) || null,
  };
}

export type StoredEntry = {
  id: string;
  revision: number;
  boardId: string;
  workerPartyId: string | null;
  subjectId: string;
  subjectKind: "person" | "equipment" | "location";
  status: "draft" | "published" | "cancelled";
  targetKind: TargetRef["kind"] | null;
  targetId: string | null;
  projectTaskId: string | null;
  departmentId: string | null;
  detail: string | null;
  notes: string | null;
  spanMode: "day" | "timed";
  timeZone: string;
  startsOn: string;
  endsOn: string;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  seriesId: string | null;
  supersedesId: string | null;
  employmentId: string | null;
  governed: boolean;
  patternAssignmentId: string | null;
  patternOccursOn: string | null;
  patternSlot: number | null;
  patternOverride: boolean;
  removesPredecessor: boolean;
  closed: boolean;
  requiredQualificationTypeIds: string[];
  started: boolean;
  /** The service visit a dispatch booking serves. */
  serviceVisitId: string | null;
};

export const STORED_COLUMNS = sql`id, revision, board_id as "boardId", worker_party_id as "workerPartyId", coalesce(worker_party_id,equipment_unit_id,resource_location_id) as "subjectId",
  case when worker_party_id is not null then 'person' when equipment_unit_id is not null then 'equipment' else 'location' end as "subjectKind", status,
  target_kind as "targetKind", coalesce(customer_party_id, project_id, location_id, schedule_code_id) as "targetId",
  project_task_id as "projectTaskId", department_id as "departmentId", detail, notes, span_mode as "spanMode",
  time_zone as "timeZone", starts_on::text as "startsOn", ends_on::text as "endsOn",
  to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startsAt",
  to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "endsAt",
  break_minutes as "breakMinutes", series_id as "seriesId", supersedes_id as "supersedesId",
  employment_id as "employmentId", governed, pattern_assignment_id as "patternAssignmentId", pattern_occurs_on::text as "patternOccursOn",
  pattern_slot as "patternSlot", pattern_override as "patternOverride", removes_predecessor as "removesPredecessor",
  closed_at is not null as closed, required_qualification_type_ids::text[] as "requiredQualificationTypeIds", starts_at <= now() as started,
  service_visit_id as "serviceVisitId"`;

export function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string")
    throw new ScheduleError(`${field} must be text.`, { code: "schedule_invalid" });
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maximum)
    throw new ScheduleError(`${field} is limited to ${maximum} characters.`, {
      code: "schedule_invalid",
    });
  return trimmed;
}

function requireId(value: unknown, field: string): string {
  if (!isUuid(value))
    throw new ScheduleError(`${field} is not recognized.`, { code: "schedule_invalid" });
  return value;
}

export async function readEntry(orgId: string, id: string): Promise<BoardEntry> {
  const row = (
    await db.execute<Parameters<typeof shapeEntry>[0]>(
      sql`select ${ENTRY_COLUMNS} ${ENTRY_JOINS}
    where e.org_id = ${orgId} and e.id = ${id}`,
      "objects",
    )
  )[0];
  if (!row) throw new ScopeNotFoundError();
  return shapeEntry(row);
}

type Person = { partyId: string; name: string; subsidiaryId: string | null };

export async function bookablePerson(
  orgId: string,
  allowed: ReadonlySet<string> | null,
  partyId: string,
): Promise<Person> {
  const row = (
    await db.execute<Person>(
      sql`select p.id as "partyId", p.display_name as name, p.subsidiary_id as "subsidiaryId"
    from parties p join employee_roles er on er.org_id = p.org_id and er.party_id = p.id
    where p.org_id = ${orgId} and p.id = ${requireId(partyId, "Person")} and p.is_active and er.is_active
    ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowed)} for share of p`,
      "objects",
    )
  )[0];
  if (!row)
    throw new ScheduleError("This person cannot be booked.", {
      code: "schedule_person_unavailable",
      remedy: "Pick an active employee you have access to.",
    });
  return row;
}

interface Subject {
  id: string;
  kind: "person" | "equipment" | "location";
  subsidiaryId: string | null;
}
async function bookableSubject(
  board: ScheduleBoard,
  orgId: string,
  allowed: ReadonlySet<string> | null,
  fields: BookingFields,
  onDate: string,
): Promise<Subject> {
  if (fields.subject && fields.workerPartyId)
    throw new ScheduleError("Name one booking subject.", { code: "schedule_invalid" });
  const subject =
    fields.subject ??
    (fields.workerPartyId ? { kind: "person" as const, id: fields.workerPartyId } : null);
  if (!subject || !isUuid(subject.id))
    throw new ScheduleError("Choose a person or native resource from this board.", {
      code: "schedule_invalid",
    });
  if (board.rowKind === "people") {
    if (subject.kind !== "person")
      throw new ScheduleError("People boards book active employees.", {
        code: "schedule_wrong_subject",
      });
    const person = await bookablePerson(orgId, allowed, subject.id);
    return { id: person.partyId, kind: "person", subsidiaryId: person.subsidiaryId };
  }
  if (board.rowKind !== "resources" || subject.kind !== board.resourceKind)
    throw new ScheduleError("Choose a resource of this board's configured kind.", {
      code: "schedule_wrong_subject",
    });
  const resource =
    subject.kind === "equipment"
      ? (
          await db.execute<{ id: string; subsidiaryId: string | null }>(
            sql`select id, subsidiary_id as "subsidiaryId" from equipment_units
        where org_id = ${orgId} and id = ${subject.id} and status = 'active' and (in_service_on is null or in_service_on <= ${onDate})
        ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed)} for share`,
            "objects",
          )
        )[0]
      : (
          await db.execute<{ id: string; subsidiaryId: string | null }>(
            sql`select id, subsidiary_id as "subsidiaryId" from locations
        where org_id = ${orgId} and id = ${subject.id} and is_active ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed, { orgWideNull: true })} for share`,
            "objects",
          )
        )[0];
  if (!resource)
    throw new ScheduleError(
      "This resource is inactive, outside your access or not yet in service.",
      {
        code: "schedule_resource_unavailable",
        remedy: "Choose an active native equipment unit or location covering the booking date.",
      },
    );
  return { ...resource, kind: subject.kind };
}

async function bookableDepartment(
  orgId: string,
  departmentId: string | null,
): Promise<string | null> {
  if (departmentId === null) return null;
  const row = (
    await db.execute(
      sql`select id from departments where org_id = ${orgId} and id = ${requireId(departmentId, "Department")} and is_active for share`,
      "objects",
    )
  )[0];
  if (!row)
    throw new ScheduleError("The department is not available.", {
      code: "schedule_invalid",
      remedy: "Pick an active department.",
    });
  return departmentId;
}

function spanFor(board: ScheduleBoard, onDate: string, span: SpanInput): BookingSpan {
  if (span.mode === "day") return daySpan(board, onDate);
  if (span.mode === "timed")
    return timedSpan({
      onDate,
      starts: span.starts,
      ends: span.ends,
      breakMinutes: span.breakMinutes,
      timeZone: board.timeZone,
    });
  throw new ScheduleError("Choose a whole-day or timed booking.", { code: "schedule_invalid" });
}

export interface Normalized {
  subject: Subject;
  target: Awaited<ReturnType<typeof resolveTarget>>;
  departmentId: string | null;
  detail: string | null;
  notes: string | null;
  span: BookingSpan;
  seriesId: string | null;
}

export async function normalize(
  board: ScheduleBoard,
  orgId: string,
  allowed: ReadonlySet<string> | null,
  fields: BookingFields,
): Promise<Normalized> {
  const onDate = requireDate(fields.onDate, "Booking date");
  const subject = await bookableSubject(board, orgId, allowed, fields, onDate);
  const target = await resolveTarget(
    db,
    orgId,
    allowed,
    fields.target,
    fields.projectTaskId ?? null,
  );
  return {
    subject,
    target,
    departmentId: await bookableDepartment(
      orgId,
      fields.departmentId === undefined ? board.departmentId : fields.departmentId,
    ),
    detail: optionalText(fields.detail, "Detail", 120),
    notes: optionalText(fields.notes, "Notes", 2000),
    span: spanFor(board, onDate, fields.span),
    seriesId: fields.seriesId ? requireId(fields.seriesId, "Series") : null,
  };
}

function definition(board: ScheduleBoard, booking: Normalized) {
  return {
    boardId: board.id,
    ...(booking.subject.kind === "person"
      ? { workerPartyId: booking.subject.id }
      : { subject: booking.subject }),
    target: booking.target
      ? {
          kind: booking.target.kind,
          customerPartyId: booking.target.customerPartyId,
          projectId: booking.target.projectId,
          projectTaskId: booking.target.projectTaskId,
          locationId: booking.target.locationId,
          scheduleCodeId: booking.target.scheduleCodeId,
        }
      : null,
    departmentId: booking.departmentId,
    detail: booking.detail,
    notes: booking.notes,
    span: booking.span,
    seriesId: booking.seriesId,
  };
}

/** Provenance a booking keeps for its life: its pattern occurrence, request outcome or removal of a predecessor. */
export interface EntryOrigin {
  readonly pattern?: {
    readonly assignmentId: string;
    readonly occursOn: string;
    readonly slot: number;
    readonly override: boolean;
  } | null;
  readonly requestId?: string | null;
  readonly removesPredecessor?: boolean;
}

export async function insertEntry(input: {
  actor: ScheduleActor;
  board: ScheduleBoard;
  id: string;
  booking: Normalized;
  status: "draft" | "published";
  supersedesId: string | null;
  reason: string;
  requestHash: string;
  employmentId?: string | null;
  requiredQualificationTypeIds?: readonly string[];
  origin?: EntryOrigin;
  /** The service visit a dispatch booking serves; only dispatch boards accept one. */
  serviceVisitId?: string | null;
}): Promise<void> {
  const { actor, board, booking } = input;
  const target = booking.target;
  const published = input.status === "published";
  const pattern = input.origin?.pattern ?? null;
  const qualifications = `{${(input.requiredQualificationTypeIds ?? []).join(",")}}`;
  const rows = await db.execute(
    sql`insert into schedule_entries
    (id, org_id, board_id, worker_party_id, equipment_unit_id, resource_location_id, employment_id, subsidiary_id, target_kind, customer_party_id, project_id, project_task_id, location_id, schedule_code_id,
     department_id, detail, notes, span_mode, time_zone, starts_on, ends_on, starts_at, ends_at, break_minutes, series_id, supersedes_id,
     status, published_by, published_at, reason, request_hash, created_by, updated_by,
     pattern_assignment_id, pattern_occurs_on, pattern_slot, pattern_override, origin_request_id, removes_predecessor, required_qualification_type_ids, service_visit_id)
    values (${input.id}, ${actor.orgId}, ${board.id}, ${booking.subject.kind === "person" ? booking.subject.id : null}, ${booking.subject.kind === "equipment" ? booking.subject.id : null}, ${booking.subject.kind === "location" ? booking.subject.id : null},
     ${input.employmentId ?? null}, ${booking.subject.subsidiaryId},
     ${target?.kind ?? null}, ${target?.customerPartyId ?? null}, ${target?.projectId ?? null}, ${target?.projectTaskId ?? null},
     ${target?.locationId ?? null}, ${target?.scheduleCodeId ?? null}, ${booking.departmentId}, ${booking.detail}, ${booking.notes},
     ${booking.span.spanMode}, ${booking.span.timeZone}, ${booking.span.startsOn}, ${booking.span.endsOn}, ${booking.span.startsAt}, ${booking.span.endsAt},
     ${booking.span.breakMinutes}, ${booking.seriesId}, ${input.supersedesId}, ${input.status},
     ${published ? actor.actorId : null}, ${published ? sql`now()` : null}, ${input.reason}, ${input.requestHash}, ${actor.actorId}, ${actor.actorId},
     ${pattern?.assignmentId ?? null}, ${pattern?.occursOn ?? null}, ${pattern?.slot ?? null}, ${pattern?.override ?? false},
     ${input.origin?.requestId ?? null}, ${input.origin?.removesPredecessor ?? false}, ${qualifications}::uuid[], ${input.serviceVisitId ?? null})
    returning id`,
    "objects",
  );
  if (rows.length !== 1)
    throw new ScheduleError("The booking was not saved.", {
      code: "schedule_not_saved",
      remedy: "Reload the board and try again.",
    });
}

/**
 * When a published pattern booking leaves its occurrence — removed, or
 * replaced by a booking that no longer belongs to the pattern — record an
 * omission so regeneration does not book the occurrence again.
 */
export async function recordPatternOmission(
  actor: ScheduleActor,
  row: Pick<StoredEntry, "patternAssignmentId" | "patternOccursOn" | "patternSlot">,
  reason: string,
): Promise<void> {
  if (!row.patternAssignmentId || !row.patternOccursOn || row.patternSlot === null) return;
  await db.execute(sql`insert into schedule_pattern_exceptions (org_id, assignment_id, occurs_on, slot_index, kind, reason, created_by)
    select ${actor.orgId}, ${row.patternAssignmentId}, ${row.patternOccursOn}, ${row.patternSlot}, 'omit', ${reason}, ${actor.actorId}
    where not exists (select 1 from schedule_pattern_exceptions x where x.org_id = ${actor.orgId} and x.assignment_id = ${row.patternAssignmentId}
      and x.occurs_on = ${row.patternOccursOn} and x.slot_index = ${row.patternSlot} and x.revoked_at is null)`);
}

/** Cancel the unpublished revisions waiting on a published booking. */
export async function cancelPendingRevisions(
  actor: ScheduleActor,
  rowId: string,
  reason: string,
): Promise<void> {
  const pending = await db.execute<StoredEntry>(
    sql`select ${STORED_COLUMNS} from schedule_entries
    where org_id = ${actor.orgId} and supersedes_id = ${rowId} and status = 'draft' for update`,
    "objects",
  );
  for (const draft of pending) await setStatus(actor, draft, "cancelled", reason);
}

/**
 * Record a removal revision for the native publication command.
 * The published predecessor remains effective until its tenant policy releases it.
 */
export async function removePublished(
  actor: ScheduleActor,
  board: ScheduleBoard,
  row: StoredEntry,
  reason: string,
): Promise<string | null> {
  await cancelPendingRevisions(actor, row.id, reason);
  const booking = await exactStoredBooking(actor.orgId, row);
  const removalId = crypto.randomUUID();
  await insertEntry({
    actor,
    board,
    id: removalId,
    booking,
    status: "draft",
    supersedesId: row.id,
    reason,
    requestHash: hash({ removes: row.id, revision: row.revision }),
    employmentId: row.employmentId,
    requiredQualificationTypeIds: row.requiredQualificationTypeIds,
    origin: { removesPredecessor: true },
  });
  return removalId;
}

/**
 * A removal revision copies the booking it removes exactly, even when its
 * person, target or code has since become unavailable for new bookings.
 */
export async function exactStoredBooking(orgId: string, row: StoredEntry): Promise<Normalized> {
  const stored = (
    await db.execute<{
      subsidiaryId: string | null;
      customerPartyId: string | null;
      projectId: string | null;
      locationId: string | null;
      scheduleCodeId: string | null;
    }>(
      sql`
    select subsidiary_id as "subsidiaryId", customer_party_id as "customerPartyId", project_id as "projectId", location_id as "locationId", schedule_code_id as "scheduleCodeId"
      from schedule_entries where org_id = ${orgId} and id = ${row.id}`,
      "objects",
    )
  )[0]!;
  return {
    subject: { id: row.subjectId, kind: row.subjectKind, subsidiaryId: stored.subsidiaryId },
    target: row.targetKind
      ? {
          kind: row.targetKind,
          customerPartyId: stored.customerPartyId,
          projectId: stored.projectId,
          projectTaskId: row.projectTaskId,
          locationId: stored.locationId,
          scheduleCodeId: stored.scheduleCodeId,
          label: "",
        }
      : null,
    departmentId: row.departmentId,
    detail: row.detail,
    notes: row.notes,
    span: {
      spanMode: row.spanMode,
      timeZone: row.timeZone,
      startsOn: row.startsOn,
      endsOn: row.endsOn,
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      breakMinutes: row.breakMinutes,
    },
    seriesId: row.seriesId,
  };
}

export async function lockStored(orgId: string, boardId: string, id: string): Promise<StoredEntry> {
  const row = (
    await db.execute<StoredEntry>(
      sql`select ${STORED_COLUMNS} from schedule_entries
    where org_id = ${orgId} and id = ${requireId(id, "Booking")} for update`,
      "objects",
    )
  )[0];
  if (!row) throw new ScopeNotFoundError();
  if (row.boardId !== boardId) {
    throw new ScheduleError("This booking belongs to another board.", {
      code: "schedule_other_board",
      remedy: "Open the board it was booked on to change it.",
    });
  }
  if (row.status === "cancelled")
    throw new ScheduleError("This booking was already removed.", {
      status: 409,
      code: "schedule_stale",
      remedy: "Reload the board.",
    });
  if (row.closed)
    throw new ScheduleError("This shift is closed.", {
      status: 409,
      code: "schedule_closed",
      remedy: "A closed shift is final history; book a new shift instead.",
    });
  return row;
}

/** Visit bookings move only through the dispatch commands, which keep the visit in step. */
export function refuseVisitBooking(row: Pick<StoredEntry, "serviceVisitId">): void {
  if (row.serviceVisitId) {
    throw new ScheduleError("This booking serves a service visit.", {
      code: "schedule_visit_booking",
      remedy:
        "Reschedule, reassign or remove it on the dispatch view, which keeps the visit, its arrival window and its customer notices in step.",
    });
  }
}

export function checkRevision(row: StoredEntry, expected: unknown): void {
  if (!Number.isSafeInteger(expected) || row.revision !== expected) {
    throw new ScheduleError("Someone changed this booking since the board was loaded.", {
      status: 409,
      code: "schedule_stale",
      remedy: "Reload the board and make the change again.",
    });
  }
}

export async function setStatus(
  actor: ScheduleActor,
  row: Pick<StoredEntry, "id" | "revision">,
  status: "cancelled",
  reason: string,
): Promise<void> {
  const updated = await db.execute(
    sql`update schedule_entries set status = ${status}, revision = revision + 1, reason = ${reason},
    updated_at = now(), updated_by = ${actor.actorId}
    where org_id = ${actor.orgId} and id = ${row.id} and revision = ${row.revision} returning id`,
    "objects",
  );
  if (updated.length !== 1)
    throw new ScheduleError("Someone changed this booking since the board was loaded.", {
      status: 409,
      code: "schedule_stale",
      remedy: "Reload the board.",
    });
}

export function storedFields(row: StoredEntry): BookingFields {
  return {
    ...(row.workerPartyId
      ? { workerPartyId: row.workerPartyId }
      : { subject: { kind: row.subjectKind, id: row.subjectId } }),
    onDate: row.startsOn,
    target: row.targetKind && row.targetId ? { kind: row.targetKind, id: row.targetId } : null,
    projectTaskId: row.projectTaskId,
    departmentId: row.departmentId,
    detail: row.detail,
    notes: row.notes,
    span:
      row.spanMode === "day"
        ? { mode: "day" }
        : {
            mode: "timed",
            starts: localClock(row.startsAt, row.timeZone),
            ends: localClock(row.endsAt, row.timeZone),
            breakMinutes: row.breakMinutes,
          },
    seriesId: row.seriesId,
  };
}

async function createOne(
  actor: ScheduleActor,
  board: ScheduleBoard,
  allowed: ReadonlySet<string> | null,
  change: Extract<BoardChange, { op: "create" }>,
  reason: string | null,
): Promise<ChangeResult> {
  const id = requireId(change.id, "Booking key");
  if (!board.isActive)
    throw new ScheduleError("This board is archived.", {
      code: "schedule_board_archived",
      remedy: "Restore the board from Scheduling → Manage boards before booking.",
    });
  const booking = await normalize(board, actor.orgId, allowed, change);
  const requestHash = hash(definition(board, booking));
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`schedule-entry:${actor.orgId}:${id}`}, 0))`,
  );
  const existing = (
    await db.execute<{ requestHash: string; createdBy: string }>(
      sql`select request_hash as "requestHash", created_by as "createdBy"
    from schedule_entries where org_id = ${actor.orgId} and id = ${id}`,
      "objects",
    )
  )[0];
  if (existing) {
    if (existing.requestHash !== requestHash || existing.createdBy !== actor.actorId) {
      throw new ScheduleError("This booking key was already used for a different booking.", {
        status: 409,
        code: "schedule_key_reused",
        remedy: "Reload the board; the existing booking is preserved.",
      });
    }
    return {
      id,
      op: "create",
      ok: true,
      entry: await readEntry(actor.orgId, id),
      replacedId: null,
    };
  }
  await insertEntry({
    actor,
    board,
    id,
    booking,
    status: "draft",
    supersedesId: null,
    reason: reason ?? `Booked on ${board.name}`,
    requestHash,
  });
  return { id, op: "create", ok: true, entry: await readEntry(actor.orgId, id), replacedId: null };
}

async function updateOne(
  actor: ScheduleActor,
  board: ScheduleBoard,
  allowed: ReadonlySet<string> | null,
  change: Extract<BoardChange, { op: "update" }>,
  reason: string | null,
): Promise<ChangeResult> {
  if (change.fields.subject && change.fields.workerPartyId)
    throw new ScheduleError("Name one booking subject.", { code: "schedule_invalid" });
  const row = await lockStored(actor.orgId, board.id, change.id);
  refuseVisitBooking(row);
  checkRevision(row, change.expectedRevision);
  if (row.removesPredecessor) {
    throw new ScheduleError("This removal is waiting for approval.", {
      status: 409,
      code: "schedule_pending_change",
      remedy: "Discard the removal to keep the booking, then change it.",
    });
  }
  const current = storedFields(row);
  const patch = change.fields ?? {};
  const merged: BookingFields = {
    ...current,
    ...patch,
    ...(patch.subject
      ? { workerPartyId: undefined }
      : patch.workerPartyId
        ? { subject: undefined }
        : {}),
    // A new date keeps a timed booking's clock times and a day booking's day.
    span: patch.span ?? current.span,
    projectTaskId:
      patch.target !== undefined && patch.projectTaskId === undefined
        ? null
        : (patch.projectTaskId ?? current.projectTaskId),
  };
  const booking = await normalize(board, actor.orgId, allowed, merged);
  const requestHash = hash(definition(board, booking));
  const samePerson = booking.subject.kind === "person" && booking.subject.id === row.workerPartyId;
  const employmentId = samePerson ? row.employmentId : null;
  const pattern =
    row.patternAssignmentId && samePerson
      ? {
          assignmentId: row.patternAssignmentId,
          occursOn: row.patternOccursOn!,
          slot: row.patternSlot!,
          override: true,
        }
      : null;

  if (row.status === "draft") {
    const target = booking.target;
    // A draft keeps its pattern occurrence only while it books the pattern's person.
    if (row.patternAssignmentId && !samePerson) {
      throw new ScheduleError("A pattern booking keeps its person.", {
        code: "schedule_pattern_person",
        remedy:
          "Remove this booking and book the other person, or change the person's pattern assignment.",
      });
    }
    const updated = await db.execute(
      sql`update schedule_entries set
      worker_party_id = ${booking.subject.kind === "person" ? booking.subject.id : null},
      equipment_unit_id = ${booking.subject.kind === "equipment" ? booking.subject.id : null}, resource_location_id = ${booking.subject.kind === "location" ? booking.subject.id : null}, subsidiary_id = ${booking.subject.subsidiaryId},
      employment_id = ${employmentId},
      target_kind = ${target?.kind ?? null}, customer_party_id = ${target?.customerPartyId ?? null}, project_id = ${target?.projectId ?? null},
      project_task_id = ${target?.projectTaskId ?? null}, location_id = ${target?.locationId ?? null}, schedule_code_id = ${target?.scheduleCodeId ?? null},
      department_id = ${booking.departmentId}, detail = ${booking.detail}, notes = ${booking.notes}, span_mode = ${booking.span.spanMode},
      time_zone = ${booking.span.timeZone}, starts_on = ${booking.span.startsOn}, ends_on = ${booking.span.endsOn},
      starts_at = ${booking.span.startsAt}, ends_at = ${booking.span.endsAt}, break_minutes = ${booking.span.breakMinutes},
      series_id = ${booking.seriesId}, pattern_override = ${row.patternAssignmentId !== null}, reason = ${reason ?? `Changed on ${board.name}`},
      revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${row.id} and revision = ${row.revision} returning id`,
      "objects",
    );
    if (updated.length !== 1)
      throw new ScheduleError("Someone changed this booking since the board was loaded.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Reload the board.",
      });
    return {
      id: row.id,
      op: "update",
      ok: true,
      entry: await readEntry(actor.orgId, row.id),
      replacedId: null,
    };
  }

  const pending = (
    await db.execute(
      sql`select id from schedule_entries where org_id = ${actor.orgId} and supersedes_id = ${row.id} and status = 'draft'`,
      "objects",
    )
  )[0];
  if (pending) {
    throw new ScheduleError("This booking already has an unpublished change.", {
      status: 409,
      code: "schedule_pending_change",
      remedy: "Edit the pending change shown on the board, or discard it first.",
    });
  }
  const successorId = crypto.randomUUID();
  const changeReason = reason ?? `Changed on ${board.name}`;
  const successor = {
    actor,
    board,
    id: successorId,
    booking,
    supersedesId: row.id,
    reason: changeReason,
    requestHash,
    employmentId,
    requiredQualificationTypeIds: samePerson ? row.requiredQualificationTypeIds : [],
    origin: { pattern },
  };
  await insertEntry({ ...successor, status: "draft" });
  return {
    id: row.id,
    op: "update",
    ok: true,
    entry: await readEntry(actor.orgId, successorId),
    replacedId: row.id,
  };
}

async function cancelOne(
  actor: ScheduleActor,
  board: ScheduleBoard,
  change: Extract<BoardChange, { op: "cancel" }>,
  reason: string | null,
): Promise<ChangeResult> {
  const row = await lockStored(actor.orgId, board.id, change.id);
  refuseVisitBooking(row);
  checkRevision(row, change.expectedRevision);
  const cancelReason = reason ?? `Removed from ${board.name}`;
  if (row.status === "draft") {
    await setStatus(actor, row, "cancelled", cancelReason);
    return { id: row.id, op: "cancel", ok: true, entry: null, replacedId: null };
  }
  // Removing a published booking also discards a change still waiting for publication.
  const removalId = await removePublished(actor, board, row, cancelReason);
  return {
    id: row.id,
    op: "cancel",
    ok: true,
    entry: removalId ? await readEntry(actor.orgId, removalId) : null,
    replacedId: removalId ? row.id : null,
  };
}

async function personName(orgId: string, change: BoardChange): Promise<string | undefined> {
  const partyId =
    change.op === "create"
      ? change.workerPartyId
      : change.op === "update"
        ? change.fields?.workerPartyId
        : undefined;
  if (!isUuid(partyId)) return undefined;
  return (
    await db.execute<{ name: string }>(
      sql`select display_name as name from parties where org_id = ${orgId} and id = ${partyId}`,
      "objects",
    )
  )[0]?.name;
}

/** Apply a batch of board edits. Refused changes are reported individually; accepted ones commit together. */
export async function applyBoardChanges(
  actor: ScheduleActor & {
    boardId: string;
    changes: readonly BoardChange[];
    reason?: string | null;
  },
): Promise<BoardChangeOutcome> {
  if (!Array.isArray(actor.changes) || actor.changes.length === 0)
    throw new ScheduleError("There is nothing to save.", { code: "schedule_invalid" });
  if (actor.changes.length > MAX_CHANGES)
    throw new ScheduleError(`A single save is limited to ${MAX_CHANGES} changes.`, {
      code: "schedule_invalid",
      remedy: "Save the changes in smaller groups.",
    });
  const reason = optionalText(actor.reason, "Reason", 2000);
  return withOrgTransaction(actor.orgId, async () => {
    const board = await getBoard(actor, actor.boardId);
    if (board.rowKind === "tasks")
      throw new ScheduleError("This board schedules project tasks.", {
        code: "schedule_wrong_board",
      });
    const allowed = await boardAuthority(actor, board, "manage");
    const results: ChangeResult[] = [];
    const notices: ScheduleNotice[] = [];
    const notify = board.notifyAssignees;
    const changedDates = new Set<string>(),
      changedSubjects = new Set<string>();
    for (const change of actor.changes) {
      const before =
        change.op !== "create" && isUuid(change.id)
          ? await readEntry(actor.orgId, change.id).catch((error: unknown) => {
              if (error instanceof ScopeNotFoundError) return null;
              throw error;
            })
          : null;
      try {
        results.push(
          await withTransactionSavepoint(db, async () => {
            const result =
              change.op === "create"
                ? await createOne(actor, board, allowed, change, reason)
                : change.op === "update"
                  ? await updateOne(actor, board, allowed, change, reason)
                  : change.op === "cancel"
                    ? await cancelOne(actor, board, change, reason)
                    : null;
            if (!result)
              throw new ScheduleError("The change type is not recognized.", {
                code: "schedule_invalid",
              });
            if (
              board.publishPolicy === "live" &&
              result.ok &&
              result.entry?.status === "draft" &&
              !result.entry.removesPredecessor
            ) {
              const accepted = results.flatMap((row) =>
                row.ok && row.entry ? [row.entry.id] : [],
              );
              const collision = (
                await db.execute(
                  sql`select x.id from schedule_entries d join schedule_entries x on x.org_id=d.org_id
              and (x.worker_party_id=d.worker_party_id or x.equipment_unit_id=d.equipment_unit_id or x.resource_location_id=d.resource_location_id)
              and tstzrange(x.starts_at,x.ends_at,'[)') && tstzrange(d.starts_at,d.ends_at,'[)')
              and x.id<>d.id and x.id is distinct from d.supersedes_id
              and (x.status='published' or x.status='draft' and x.id=any(${`{${accepted.join(",")}}`}::uuid[]))
              where d.org_id=${actor.orgId} and d.id=${result.entry.id} limit 1`,
                  "objects",
                )
              )[0];
              if (collision)
                throw new ScheduleError("This person or resource is already booked at that time.", {
                  status: 409,
                  code: "schedule_double_booked",
                  remedy: "Choose a free time or change the existing booking.",
                });
            }
            return result;
          }),
        );
        const result = results.at(-1)!;
        if (result.ok) {
          if (before?.status === "published") {
            changedDates.add(before.startsOn);
            changedDates.add(before.endsOn);
            changedSubjects.add(before.subjectId);
          }
          if (result.entry?.status === "published") {
            changedDates.add(result.entry.startsOn);
            changedDates.add(result.entry.endsOn);
            changedSubjects.add(result.entry.subjectId);
          }
        }
        if (notify && result.ok) {
          if (change.op === "cancel" && before?.status === "published" && !result.entry)
            notices.push(noticeFor(before, "removed"));
          else if (result.entry?.status === "published") {
            notices.push(noticeFor(result.entry, change.op === "create" ? "booked" : "changed"));
            if (
              before &&
              before.status === "published" &&
              before.workerPartyId !== result.entry.workerPartyId
            )
              notices.push(noticeFor(before, "removed"));
          }
        }
      } catch (error) {
        const refusal = scheduleDatabaseRefusal(error, {
          personName: await personName(actor.orgId, change).catch(() => undefined),
        });
        if (refusal instanceof ScheduleError) {
          results.push({
            id: String(change.id),
            op: change.op,
            ok: false,
            error: refusal.message,
            code: refusal.code,
            remedy: refusal.remedy ?? null,
          });
          continue;
        }
        if (refusal instanceof ScopeNotFoundError) {
          results.push({
            id: String(change.id),
            op: change.op,
            ok: false,
            error: "This booking is not available.",
            code: "not_found",
            remedy: "Reload the board.",
          });
          continue;
        }
        throw refusal;
      }
    }
    if (board.publishPolicy === "live") {
      const drafts = results.flatMap((result) =>
        result.ok && result.entry?.status === "draft" ? [result.entry] : [],
      );
      if (drafts.length) {
        const { publishScheduleBoard } = await import("./publications.ts");
        const dates = drafts.flatMap((entry) => [entry.startsOn, entry.endsOn]).sort();
        const publication = await publishScheduleBoard({
          ...actor,
          boardId: board.id,
          from: dates[0]!,
          through: dates.at(-1)!,
          entryIds: drafts.map((entry) => entry.id),
          reason,
        });
        notices.push(...publication.notices);
        for (let index = 0; index < results.length; index++) {
          const result = results[index]!;
          if (result.ok && result.entry?.status === "draft") {
            results[index] = {
              ...result,
              entry:
                !publication.pending && result.entry.removesPredecessor
                  ? null
                  : await readEntry(actor.orgId, result.entry.id),
            };
          }
        }
        return {
          results,
          notices,
          boardName: board.name,
          distributionRefusals: publication.distributionRefusals,
        };
      }
    }
    const dates = [...changedDates].sort(),
      distributionRefusals: { message: string; remedy: string }[] = [];
    for (let index = 0; index < dates.length;) {
      const from = dates[index]!,
        through = new Date(`${from}T00:00:00Z`);
      through.setUTCDate(through.getUTCDate() + 41);
      const upper = through.toISOString().slice(0, 10);
      let end = index;
      while (end + 1 < dates.length && dates[end + 1]! <= upper) end++;
      const refusal = await scheduleBoardLifecycle({
        actor,
        boardId: board.id,
        from,
        through: dates[end]!,
        subjectIds: [...changedSubjects],
        event: "on_update",
        occurrence:
          results
            .filter((r) => r.ok)
            .map((r) => `${r.id}:${r.entry?.revision ?? "cancel"}`)
            .sort()
            .join(",") + `:${from}:${dates[end]}`,
      });
      if (refusal) distributionRefusals.push(refusal);
      index = end + 1;
    }
    return { results, notices, boardName: board.name, distributionRefusals };
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

export interface PublishFailure {
  readonly entryId: string;
  readonly personName: string;
  readonly date: string;
  readonly error: string;
}

export interface PublishFailure {
  readonly entryId: string;
  readonly personName: string;
  readonly date: string;
  readonly error: string;
}

/**
 * Publish a staged board's drafts in a window. Publication is all or
 * nothing: if any booking cannot publish (leave, a double booking), nothing
 * is published and every blocking booking is listed with its reason.
 */
export type PublishableDraft = StoredEntry & { personName: string };

/** The board's unpublished changes in a window (or the named drafts), locked for publication. */
export async function lockPublishableDrafts(
  actor: ScheduleActor,
  board: ScheduleBoard,
  scope: { from: string; through: string } | { ids: readonly string[] },
): Promise<PublishableDraft[]> {
  const filter =
    "ids" in scope
      ? sql`id = any(${`{${scope.ids.join(",")}}`}::uuid[])`
      : sql`starts_on between ${scope.from} and ${scope.through}`;
  return await db.execute<PublishableDraft>(
    sql`select ${STORED_COLUMNS},
      coalesce((select display_name from parties p where p.org_id = schedule_entries.org_id and p.id = schedule_entries.worker_party_id),
      (select name from equipment_units u where u.org_id = schedule_entries.org_id and u.id = schedule_entries.equipment_unit_id),
      (select name from locations l where l.org_id = schedule_entries.org_id and l.id = schedule_entries.resource_location_id)) as "personName"
    from schedule_entries where org_id = ${actor.orgId} and board_id = ${board.id} and status = 'draft' and ${filter}
    order by starts_at, id for update`,
    "objects",
  );
}

/**
 * Publish locked drafts, all or nothing: if any draft cannot publish (leave,
 * a double booking, a missing qualification), nothing is published and every
 * blocking draft is listed with its reason. Replacements cancel the booking
 * they replace; removal revisions cancel the booking they remove.
 */
export async function publishDrafts(
  actor: ScheduleActor,
  board: ScheduleBoard,
  drafts: readonly PublishableDraft[],
  publishReason: string,
  window: { from: string; through: string },
): Promise<{
  published: number;
  notices: ScheduleNotice[];
  distributionRefusals: { message: string; remedy: string }[];
}> {
  const failures: PublishFailure[] = [];
  for (const draft of drafts) {
    try {
      await withTransactionSavepoint(db, async () => {
        if (draft.supersedesId) {
          const prior = (
            await db.execute<StoredEntry>(
              sql`select ${STORED_COLUMNS} from schedule_entries
            where org_id = ${actor.orgId} and id = ${draft.supersedesId} for update`,
              "objects",
            )
          )[0];
          if (prior?.status === "published") {
            await setStatus(actor, prior, "cancelled", publishReason);
            if (
              prior.patternAssignmentId &&
              (draft.removesPredecessor || draft.patternAssignmentId !== prior.patternAssignmentId)
            ) {
              await recordPatternOmission(actor, prior, publishReason);
            }
          }
        }
        // A removal revision is applied by the cancellation above; it is
        // closed as history rather than published as a booking.
        const updated = draft.removesPredecessor
          ? await db.execute(
              sql`update schedule_entries set status = 'cancelled', reason = ${publishReason}, revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
              where org_id = ${actor.orgId} and id = ${draft.id} and revision = ${draft.revision} returning id`,
              "objects",
            )
          : await db.execute(
              sql`update schedule_entries set status = 'published', published_by = ${actor.actorId}, published_at = now(),
              reason = ${publishReason}, revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
              where org_id = ${actor.orgId} and id = ${draft.id} and revision = ${draft.revision} returning id`,
              "objects",
            );
        if (updated.length !== 1)
          throw new ScheduleError("A booking changed during publication.", {
            status: 409,
            code: "schedule_stale",
          });
      });
    } catch (error) {
      const refusal = scheduleDatabaseRefusal(error, { personName: draft.personName });
      if (!(refusal instanceof ScheduleError)) throw refusal;
      failures.push({
        entryId: draft.id,
        personName: draft.personName,
        date: draft.startsOn,
        error: refusal.message,
      });
    }
  }
  if (failures.length) {
    const listed = failures
      .slice(0, 5)
      .map((failure) => `${failure.personName} on ${failure.date}: ${failure.error}`)
      .join(" ");
    throw Object.assign(
      new ScheduleError(
        `${failures.length} of ${drafts.length} changes cannot be published. ${listed}`,
        {
          code: "schedule_publish_blocked",
          remedy: "Resolve the listed bookings, then publish again. Nothing was published.",
        },
      ),
      { failures },
    );
  }
  const notices: ScheduleNotice[] = [];
  if (board.notifyAssignees) {
    for (const draft of drafts) {
      if (draft.removesPredecessor) {
        const prior = await readEntry(actor.orgId, draft.supersedesId!);
        if (prior.workerPartyId) notices.push(noticeFor(prior, "removed"));
        continue;
      }
      const entry = await readEntry(actor.orgId, draft.id);
      if (!entry.workerPartyId) continue;
      notices.push(noticeFor(entry, draft.supersedesId ? "changed" : "booked"));
      if (draft.supersedesId) {
        const prior = await readEntry(actor.orgId, draft.supersedesId);
        if (prior.workerPartyId && prior.workerPartyId !== entry.workerPartyId)
          notices.push(noticeFor(prior, "removed"));
      }
    }
  }
  const refusal = await scheduleBoardLifecycle({
    actor,
    boardId: board.id,
    from: window.from,
    through: window.through,
    subjectIds: drafts.map((d) => d.subjectId),
    event: "after_post",
    occurrence: drafts
      .map((d) => `${d.id}:${d.revision + 1}`)
      .sort()
      .join(","),
  });
  return { published: drafts.length, notices, distributionRefusals: refusal ? [refusal] : [] };
}
