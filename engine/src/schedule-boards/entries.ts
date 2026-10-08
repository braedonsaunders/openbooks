/**
 * Booking commands for people boards. Every command runs in one tenant
 * transaction; each change in a batch is isolated in a savepoint so a paste
 * of fifty cells reports the three that were refused and keeps the rest.
 *
 * Lifecycle: a live board publishes each booking as it is made; a staged
 * board collects drafts until the board is published. A published booking
 * is never rewritten — changing it cancels it and records a successor that
 * names it, so the history of who was sent where is preserved.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { canonicalJson } from "../platform/canonical-json.ts";
import { db, withOrgTransaction, withTransactionSavepoint } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { ScopeNotFoundError, subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import { getBoard, peopleBoardAuthority, type ScheduleActor, type ScheduleBoard } from "./boards.ts";
import { ScheduleError, scheduleDatabaseRefusal } from "./errors.ts";
import { daySpan, localClock, requireDate, timedSpan, type BookingSpan } from "./spans.ts";
import { resolveTarget, type TargetRef } from "./targets.ts";
import { ENTRY_COLUMNS, ENTRY_JOINS, shapeEntry, type BoardEntry } from "./window.ts";

export type SpanInput =
  | { readonly mode: "day" }
  | { readonly mode: "timed"; readonly starts: string; readonly ends: string; readonly breakMinutes: number };

export interface BookingFields {
  readonly workerPartyId: string;
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
  | { readonly op: "update"; readonly id: string; readonly expectedRevision: number; readonly fields: Partial<BookingFields> }
  | { readonly op: "cancel"; readonly id: string; readonly expectedRevision: number };

export type ChangeResult =
  | { readonly id: string; readonly op: BoardChange["op"]; readonly ok: true; readonly entry: BoardEntry | null; readonly replacedId: string | null }
  | { readonly id: string; readonly op: BoardChange["op"]; readonly ok: false; readonly error: string; readonly code: string; readonly remedy: string | null };

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
}

function hoursLabel(entry: BoardEntry): string {
  return entry.spanMode === "timed" ? `${entry.startClock}–${entry.endClock}` : "";
}

function noticeFor(entry: BoardEntry, change: ScheduleNotice["change"]): ScheduleNotice {
  const label = [entry.target?.code ?? entry.target?.label ?? "", entry.detail ? `/${entry.detail}` : ""].join("").trim() || "—";
  return { workerPartyId: entry.workerPartyId, onDate: entry.startsOn, change, label, hours: hoursLabel(entry) || null };
}

interface StoredEntry {
  id: string; revision: number; boardId: string; workerPartyId: string; status: "draft" | "published" | "cancelled";
  targetKind: TargetRef["kind"] | null; targetId: string | null; projectTaskId: string | null; departmentId: string | null;
  detail: string | null; notes: string | null; spanMode: "day" | "timed"; timeZone: string; startsOn: string;
  startsAt: string; endsAt: string; breakMinutes: number; seriesId: string | null; supersedesId: string | null;
}

const STORED_COLUMNS = sql`id, revision, board_id as "boardId", worker_party_id as "workerPartyId", status,
  target_kind as "targetKind", coalesce(customer_party_id, project_id, location_id, schedule_code_id) as "targetId",
  project_task_id as "projectTaskId", department_id as "departmentId", detail, notes, span_mode as "spanMode",
  time_zone as "timeZone", starts_on::text as "startsOn",
  to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startsAt",
  to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "endsAt",
  break_minutes as "breakMinutes", series_id as "seriesId", supersedes_id as "supersedesId"`;

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function optionalText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ScheduleError(`${field} must be text.`, { code: "schedule_invalid" });
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > maximum) throw new ScheduleError(`${field} is limited to ${maximum} characters.`, { code: "schedule_invalid" });
  return trimmed;
}

function requireId(value: unknown, field: string): string {
  if (!isUuid(value)) throw new ScheduleError(`${field} is not recognized.`, { code: "schedule_invalid" });
  return value;
}

async function readEntry(orgId: string, id: string): Promise<BoardEntry> {
  const row = (await db.execute<Parameters<typeof shapeEntry>[0]>(sql`select ${ENTRY_COLUMNS} ${ENTRY_JOINS}
    where e.org_id = ${orgId} and e.id = ${id}`)).rows[0];
  if (!row) throw new ScopeNotFoundError();
  return shapeEntry(row);
}

interface Person { partyId: string; name: string; subsidiaryId: string | null }

async function bookablePerson(orgId: string, allowed: ReadonlySet<string> | null, partyId: string): Promise<Person> {
  const row = (await db.execute<Person>(sql`select p.id as "partyId", p.display_name as name, p.subsidiary_id as "subsidiaryId"
    from parties p join employee_roles er on er.org_id = p.org_id and er.party_id = p.id
    where p.org_id = ${orgId} and p.id = ${requireId(partyId, "Person")} and p.is_active and er.is_active
    ${subsidiaryVisibleFilter(sql`p.subsidiary_id`, allowed)} for share of p`)).rows[0];
  if (!row) throw new ScheduleError("This person cannot be booked.", { code: "schedule_person_unavailable", remedy: "Pick an active employee you have access to." });
  return row;
}

async function bookableDepartment(orgId: string, departmentId: string | null): Promise<string | null> {
  if (departmentId === null) return null;
  const row = (await db.execute(sql`select id from departments where org_id = ${orgId} and id = ${requireId(departmentId, "Department")} and is_active for share`)).rows[0];
  if (!row) throw new ScheduleError("The department is not available.", { code: "schedule_invalid", remedy: "Pick an active department." });
  return departmentId;
}

function spanFor(board: ScheduleBoard, onDate: string, span: SpanInput): BookingSpan {
  if (span.mode === "day") return daySpan(board, onDate);
  if (span.mode === "timed") return timedSpan({ onDate, starts: span.starts, ends: span.ends, breakMinutes: span.breakMinutes, timeZone: board.timeZone });
  throw new ScheduleError("Choose a whole-day or timed booking.", { code: "schedule_invalid" });
}

interface Normalized {
  person: Person;
  target: Awaited<ReturnType<typeof resolveTarget>>;
  departmentId: string | null;
  detail: string | null;
  notes: string | null;
  span: BookingSpan;
  seriesId: string | null;
}

async function normalize(board: ScheduleBoard, orgId: string, allowed: ReadonlySet<string> | null, fields: BookingFields): Promise<Normalized> {
  const onDate = requireDate(fields.onDate, "Booking date");
  const person = await bookablePerson(orgId, allowed, fields.workerPartyId);
  const target = await resolveTarget(db, orgId, allowed, fields.target, fields.projectTaskId ?? null);
  return {
    person,
    target,
    departmentId: await bookableDepartment(orgId, fields.departmentId === undefined ? board.departmentId : fields.departmentId),
    detail: optionalText(fields.detail, "Detail", 120),
    notes: optionalText(fields.notes, "Notes", 2000),
    span: spanFor(board, onDate, fields.span),
    seriesId: fields.seriesId ? requireId(fields.seriesId, "Series") : null,
  };
}

function definition(board: ScheduleBoard, booking: Normalized) {
  return {
    boardId: board.id,
    workerPartyId: booking.person.partyId,
    target: booking.target ? { kind: booking.target.kind, customerPartyId: booking.target.customerPartyId, projectId: booking.target.projectId,
      projectTaskId: booking.target.projectTaskId, locationId: booking.target.locationId, scheduleCodeId: booking.target.scheduleCodeId } : null,
    departmentId: booking.departmentId,
    detail: booking.detail,
    notes: booking.notes,
    span: booking.span,
    seriesId: booking.seriesId,
  };
}

async function insertEntry(input: {
  actor: ScheduleActor; board: ScheduleBoard; id: string; booking: Normalized; status: "draft" | "published";
  supersedesId: string | null; reason: string; requestHash: string;
}): Promise<void> {
  const { actor, board, booking } = input;
  const target = booking.target;
  const published = input.status === "published";
  const rows = (await db.execute(sql`insert into schedule_entries
    (id, org_id, board_id, worker_party_id, subsidiary_id, target_kind, customer_party_id, project_id, project_task_id, location_id, schedule_code_id,
     department_id, detail, notes, span_mode, time_zone, starts_on, ends_on, starts_at, ends_at, break_minutes, series_id, supersedes_id,
     status, published_by, published_at, reason, request_hash, created_by, updated_by)
    values (${input.id}, ${actor.orgId}, ${board.id}, ${booking.person.partyId}, ${booking.person.subsidiaryId},
     ${target?.kind ?? null}, ${target?.customerPartyId ?? null}, ${target?.projectId ?? null}, ${target?.projectTaskId ?? null},
     ${target?.locationId ?? null}, ${target?.scheduleCodeId ?? null}, ${booking.departmentId}, ${booking.detail}, ${booking.notes},
     ${booking.span.spanMode}, ${booking.span.timeZone}, ${booking.span.startsOn}, ${booking.span.endsOn}, ${booking.span.startsAt}, ${booking.span.endsAt},
     ${booking.span.breakMinutes}, ${booking.seriesId}, ${input.supersedesId}, ${input.status},
     ${published ? actor.actorId : null}, ${published ? sql`now()` : null}, ${input.reason}, ${input.requestHash}, ${actor.actorId}, ${actor.actorId})
    returning id`)).rows;
  if (rows.length !== 1) throw new ScheduleError("The booking was not saved.", { code: "schedule_not_saved", remedy: "Reload the board and try again." });
}

async function lockStored(orgId: string, boardId: string, id: string): Promise<StoredEntry> {
  const row = (await db.execute<StoredEntry>(sql`select ${STORED_COLUMNS} from schedule_entries
    where org_id = ${orgId} and id = ${requireId(id, "Booking")} for update`)).rows[0];
  if (!row) throw new ScopeNotFoundError();
  if (row.boardId !== boardId) {
    throw new ScheduleError("This booking belongs to another board.", { code: "schedule_other_board", remedy: "Open the board it was booked on to change it." });
  }
  if (row.status === "cancelled") throw new ScheduleError("This booking was already removed.", { status: 409, code: "schedule_stale", remedy: "Reload the board." });
  return row;
}

function checkRevision(row: StoredEntry, expected: unknown): void {
  if (!Number.isSafeInteger(expected) || row.revision !== expected) {
    throw new ScheduleError("Someone changed this booking since the board was loaded.", { status: 409, code: "schedule_stale", remedy: "Reload the board and make the change again." });
  }
}

async function setStatus(actor: ScheduleActor, row: StoredEntry, status: "cancelled", reason: string): Promise<void> {
  const updated = (await db.execute(sql`update schedule_entries set status = ${status}, revision = revision + 1, reason = ${reason},
    updated_at = now(), updated_by = ${actor.actorId}
    where org_id = ${actor.orgId} and id = ${row.id} and revision = ${row.revision} returning id`)).rows;
  if (updated.length !== 1) throw new ScheduleError("Someone changed this booking since the board was loaded.", { status: 409, code: "schedule_stale", remedy: "Reload the board." });
}

function storedFields(row: StoredEntry): BookingFields {
  return {
    workerPartyId: row.workerPartyId,
    onDate: row.startsOn,
    target: row.targetKind && row.targetId ? { kind: row.targetKind, id: row.targetId } : null,
    projectTaskId: row.projectTaskId,
    departmentId: row.departmentId,
    detail: row.detail,
    notes: row.notes,
    span: row.spanMode === "day" ? { mode: "day" } : {
      mode: "timed", starts: localClock(row.startsAt, row.timeZone), ends: localClock(row.endsAt, row.timeZone), breakMinutes: row.breakMinutes,
    },
    seriesId: row.seriesId,
  };
}

async function createOne(actor: ScheduleActor, board: ScheduleBoard, allowed: ReadonlySet<string> | null, change: Extract<BoardChange, { op: "create" }>, reason: string | null): Promise<ChangeResult> {
  const id = requireId(change.id, "Booking key");
  if (!board.isActive) throw new ScheduleError("This board is archived.", { code: "schedule_board_archived", remedy: "Reactivate it in Setup → Schedule boards before booking." });
  const booking = await normalize(board, actor.orgId, allowed, change);
  const requestHash = hash(definition(board, booking));
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`schedule-entry:${actor.orgId}:${id}`}, 0))`);
  const existing = (await db.execute<{ requestHash: string; createdBy: string }>(sql`select request_hash as "requestHash", created_by as "createdBy"
    from schedule_entries where org_id = ${actor.orgId} and id = ${id}`)).rows[0];
  if (existing) {
    if (existing.requestHash !== requestHash || existing.createdBy !== actor.actorId) {
      throw new ScheduleError("This booking key was already used for a different booking.", { status: 409, code: "schedule_key_reused", remedy: "Reload the board; the existing booking is preserved." });
    }
    return { id, op: "create", ok: true, entry: await readEntry(actor.orgId, id), replacedId: null };
  }
  await insertEntry({
    actor, board, id, booking,
    status: board.publishPolicy === "live" ? "published" : "draft",
    supersedesId: null,
    reason: reason ?? `Booked on ${board.name}`,
    requestHash,
  });
  return { id, op: "create", ok: true, entry: await readEntry(actor.orgId, id), replacedId: null };
}

async function updateOne(actor: ScheduleActor, board: ScheduleBoard, allowed: ReadonlySet<string> | null, change: Extract<BoardChange, { op: "update" }>, reason: string | null): Promise<ChangeResult> {
  const row = await lockStored(actor.orgId, board.id, change.id);
  checkRevision(row, change.expectedRevision);
  const current = storedFields(row);
  const patch = change.fields ?? {};
  const merged: BookingFields = {
    ...current,
    ...patch,
    // A new date keeps a timed booking's clock times and a day booking's day.
    span: patch.span ?? current.span,
    projectTaskId: patch.target !== undefined && patch.projectTaskId === undefined ? null : (patch.projectTaskId ?? current.projectTaskId),
  };
  const booking = await normalize(board, actor.orgId, allowed, merged);
  const requestHash = hash(definition(board, booking));
  const notesOnly = Object.keys(patch).every((key) => key === "notes");

  if (row.status === "draft") {
    const target = booking.target;
    const updated = (await db.execute(sql`update schedule_entries set
      worker_party_id = ${booking.person.partyId}, subsidiary_id = ${booking.person.subsidiaryId},
      target_kind = ${target?.kind ?? null}, customer_party_id = ${target?.customerPartyId ?? null}, project_id = ${target?.projectId ?? null},
      project_task_id = ${target?.projectTaskId ?? null}, location_id = ${target?.locationId ?? null}, schedule_code_id = ${target?.scheduleCodeId ?? null},
      department_id = ${booking.departmentId}, detail = ${booking.detail}, notes = ${booking.notes}, span_mode = ${booking.span.spanMode},
      time_zone = ${booking.span.timeZone}, starts_on = ${booking.span.startsOn}, ends_on = ${booking.span.endsOn},
      starts_at = ${booking.span.startsAt}, ends_at = ${booking.span.endsAt}, break_minutes = ${booking.span.breakMinutes},
      series_id = ${booking.seriesId}, reason = ${reason ?? `Changed on ${board.name}`},
      revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${row.id} and revision = ${row.revision} returning id`)).rows;
    if (updated.length !== 1) throw new ScheduleError("Someone changed this booking since the board was loaded.", { status: 409, code: "schedule_stale", remedy: "Reload the board." });
    return { id: row.id, op: "update", ok: true, entry: await readEntry(actor.orgId, row.id), replacedId: null };
  }

  if (notesOnly) {
    const updated = (await db.execute(sql`update schedule_entries set notes = ${booking.notes}, reason = ${reason ?? "Notes changed"},
      revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${row.id} and revision = ${row.revision} returning id`)).rows;
    if (updated.length !== 1) throw new ScheduleError("Someone changed this booking since the board was loaded.", { status: 409, code: "schedule_stale", remedy: "Reload the board." });
    return { id: row.id, op: "update", ok: true, entry: await readEntry(actor.orgId, row.id), replacedId: null };
  }

  const pending = (await db.execute(sql`select id from schedule_entries where org_id = ${actor.orgId} and supersedes_id = ${row.id} and status = 'draft'`)).rows[0];
  if (pending) {
    throw new ScheduleError("This booking already has an unpublished change.", { status: 409, code: "schedule_pending_change", remedy: "Edit the pending change shown on the board, or discard it first." });
  }
  const successorId = crypto.randomUUID();
  const changeReason = reason ?? `Changed on ${board.name}`;
  if (board.publishPolicy === "live") {
    await setStatus(actor, row, "cancelled", changeReason);
    await insertEntry({ actor, board, id: successorId, booking, status: "published", supersedesId: row.id, reason: changeReason, requestHash });
  } else {
    await insertEntry({ actor, board, id: successorId, booking, status: "draft", supersedesId: row.id, reason: changeReason, requestHash });
  }
  return { id: row.id, op: "update", ok: true, entry: await readEntry(actor.orgId, successorId), replacedId: row.id };
}

async function cancelOne(actor: ScheduleActor, board: ScheduleBoard, change: Extract<BoardChange, { op: "cancel" }>, reason: string | null): Promise<ChangeResult> {
  const row = await lockStored(actor.orgId, board.id, change.id);
  checkRevision(row, change.expectedRevision);
  const cancelReason = reason ?? `Removed from ${board.name}`;
  // Removing a published booking also discards a change still waiting for publication.
  const pending = (await db.execute<StoredEntry>(sql`select ${STORED_COLUMNS} from schedule_entries
    where org_id = ${actor.orgId} and supersedes_id = ${row.id} and status = 'draft' for update`)).rows;
  for (const draft of pending) await setStatus(actor, draft, "cancelled", cancelReason);
  await setStatus(actor, row, "cancelled", cancelReason);
  return { id: row.id, op: "cancel", ok: true, entry: null, replacedId: null };
}

async function personName(orgId: string, change: BoardChange): Promise<string | undefined> {
  const partyId = change.op === "create" ? change.workerPartyId : change.op === "update" ? change.fields?.workerPartyId : undefined;
  if (!isUuid(partyId)) return undefined;
  return (await db.execute<{ name: string }>(sql`select display_name as name from parties where org_id = ${orgId} and id = ${partyId}`)).rows[0]?.name;
}

/** Apply a batch of board edits. Refused changes are reported individually; accepted ones commit together. */
export async function applyBoardChanges(actor: ScheduleActor & { boardId: string; changes: readonly BoardChange[]; reason?: string | null }): Promise<BoardChangeOutcome> {
  if (!Array.isArray(actor.changes) || actor.changes.length === 0) throw new ScheduleError("There is nothing to save.", { code: "schedule_invalid" });
  if (actor.changes.length > MAX_CHANGES) throw new ScheduleError(`A single save is limited to ${MAX_CHANGES} changes.`, { code: "schedule_invalid", remedy: "Save the changes in smaller groups." });
  const reason = optionalText(actor.reason, "Reason", 2000);
  return withOrgTransaction(actor.orgId, async () => {
    const board = await getBoard(actor, actor.boardId);
    if (board.rowKind !== "people") throw new ScheduleError("This board schedules project tasks.", { code: "schedule_wrong_board" });
    const allowed = await peopleBoardAuthority(actor, "hrm.shifts.manage", board.subsidiaryId);
    const results: ChangeResult[] = [];
    const notices: ScheduleNotice[] = [];
    const notify = board.notifyAssignees;
    for (const change of actor.changes) {
      const before = notify && change.op !== "create" && isUuid(change.id) ? await readEntry(actor.orgId, change.id).catch(() => null) : null;
      try {
        results.push(await withTransactionSavepoint(db, () => {
          if (change.op === "create") return createOne(actor, board, allowed, change, reason);
          if (change.op === "update") return updateOne(actor, board, allowed, change, reason);
          if (change.op === "cancel") return cancelOne(actor, board, change, reason);
          throw new ScheduleError("The change type is not recognized.", { code: "schedule_invalid" });
        }));
        const result = results.at(-1)!;
        if (notify && result.ok) {
          if (change.op === "cancel" && before?.status === "published") notices.push(noticeFor(before, "removed"));
          else if (result.entry?.status === "published") {
            notices.push(noticeFor(result.entry, change.op === "create" ? "booked" : "changed"));
            if (before && before.status === "published" && before.workerPartyId !== result.entry.workerPartyId) notices.push(noticeFor(before, "removed"));
          }
        }
      } catch (error) {
        const refusal = scheduleDatabaseRefusal(error, { personName: await personName(actor.orgId, change).catch(() => undefined) });
        if (refusal instanceof ScheduleError) {
          results.push({ id: String(change.id), op: change.op, ok: false, error: refusal.message, code: refusal.code, remedy: refusal.remedy ?? null });
          continue;
        }
        if (refusal instanceof ScopeNotFoundError) {
          results.push({ id: String(change.id), op: change.op, ok: false, error: "This booking is not available.", code: "not_found", remedy: "Reload the board." });
          continue;
        }
        throw refusal;
      }
    }
    return { results, notices, boardName: board.name };
  });
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
export async function publishBoard(actor: ScheduleActor & { boardId: string; from: string; through: string; reason?: string | null }): Promise<{ published: number; notices: ScheduleNotice[]; boardName: string }> {
  const from = requireDate(actor.from, "Publish from");
  const through = requireDate(actor.through, "Publish through");
  const reason = optionalText(actor.reason, "Reason", 2000);
  return withOrgTransaction(actor.orgId, async () => {
    const board = await getBoard(actor, actor.boardId);
    if (board.rowKind !== "people") throw new ScheduleError("This board schedules project tasks.", { code: "schedule_wrong_board" });
    if (board.publishPolicy !== "staged") throw new ScheduleError("This board publishes each booking as it is made.", { code: "schedule_live_board" });
    await peopleBoardAuthority(actor, "hrm.shifts.approve", board.subsidiaryId);
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`schedule-publish:${actor.orgId}:${board.id}`}, 0))`);
    const drafts = (await db.execute<StoredEntry & { personName: string }>(sql`select ${STORED_COLUMNS},
        (select display_name from parties p where p.org_id = schedule_entries.org_id and p.id = schedule_entries.worker_party_id) as "personName"
      from schedule_entries where org_id = ${actor.orgId} and board_id = ${board.id} and status = 'draft'
        and starts_on between ${from} and ${through}
      order by starts_at, id for update`)).rows;
    if (drafts.length === 0) throw new ScheduleError("There are no unpublished changes in these dates.", { code: "schedule_nothing_to_publish" });
    const failures: PublishFailure[] = [];
    const publishReason = reason ?? `Published ${board.name}`;
    for (const draft of drafts) {
      try {
        await withTransactionSavepoint(db, async () => {
          if (draft.supersedesId) {
            const prior = (await db.execute<StoredEntry>(sql`select ${STORED_COLUMNS} from schedule_entries
              where org_id = ${actor.orgId} and id = ${draft.supersedesId} for update`)).rows[0];
            if (prior?.status === "published") await setStatus(actor, prior, "cancelled", publishReason);
          }
          const updated = (await db.execute(sql`update schedule_entries set status = 'published', published_by = ${actor.actorId}, published_at = now(),
            reason = ${publishReason}, revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
            where org_id = ${actor.orgId} and id = ${draft.id} and revision = ${draft.revision} returning id`)).rows;
          if (updated.length !== 1) throw new ScheduleError("A booking changed during publication.", { status: 409, code: "schedule_stale" });
        });
      } catch (error) {
        const refusal = scheduleDatabaseRefusal(error, { personName: draft.personName });
        if (!(refusal instanceof ScheduleError)) throw refusal;
        failures.push({ entryId: draft.id, personName: draft.personName, date: draft.startsOn, error: refusal.message });
      }
    }
    if (failures.length) {
      const listed = failures.slice(0, 5).map((failure) => `${failure.personName} on ${failure.date}: ${failure.error}`).join(" ");
      throw Object.assign(new ScheduleError(`${failures.length} of ${drafts.length} changes cannot be published. ${listed}`, {
        code: "schedule_publish_blocked",
        remedy: "Resolve the listed bookings, then publish again. Nothing was published.",
      }), { failures });
    }
    const notices: ScheduleNotice[] = [];
    if (board.notifyAssignees) {
      for (const draft of drafts) {
        const entry = await readEntry(actor.orgId, draft.id);
        notices.push(noticeFor(entry, draft.supersedesId ? "changed" : "booked"));
        if (draft.supersedesId) {
          const prior = await readEntry(actor.orgId, draft.supersedesId);
          if (prior.workerPartyId !== entry.workerPartyId) notices.push(noticeFor(prior, "removed"));
        }
      }
    }
    return { published: drafts.length, notices, boardName: board.name };
  });
}
