/**
 * The dispatch board: one column per technician for a day, the queue of
 * unscheduled visits, and the commands that assign, move and remove visit
 * bookings. Bookings are schedule entries on a dispatch board, published at
 * once, so the booking ledger's double-booking, leave and qualification
 * guards hold across every board. Each command locks the visit and checks
 * its revision, so two dispatchers moving the same visit cannot both win.
 */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { addCalendarDays } from "../platform/civil-date.ts";
import { localTimeFields, resolveLocalTime } from "../platform/time-zone.ts";
import { ScopeNotFoundError } from "../organization/subsidiary-scope.ts";
import { resolveWorkSchedule, scheduledHoursOn, isScheduledOn } from "../payroll/work-schedules.ts";
import {
  boardAuthority,
  getBoard,
  requireBoardCapability,
  type ScheduleBoard,
} from "../schedule-boards/boards.ts";
import {
  bookablePerson,
  checkRevision,
  hash,
  insertEntry,
  lockStored,
  setStatus,
  type Normalized,
} from "../schedule-boards/entries.ts";
import { scheduleDatabaseRefusal } from "../schedule-boards/errors.ts";
import { loadBoardWindow, type BoardWindow } from "../schedule-boards/window.ts";
import {
  auditService,
  optionalText,
  requireDate,
  requireInstant,
  requireMinutes,
  requireUuid,
  type ServiceActor,
} from "./common.ts";
import {
  assignmentDecision,
  evaluateAssignment,
  type AssignmentConflict,
  type TechnicianDayFacts,
} from "./dispatch-rules.ts";
import { ServiceError, serviceDatabaseRefusal } from "./errors.ts";
import type { CustomerNoticeRequest } from "./notices.ts";
import { requirePolicy } from "./policy.ts";
import {
  SERVICE_PRIORITIES,
  priorityRank,
  visitIsReschedulable,
  type ServicePriority,
  type VisitStatus,
} from "./status.ts";
import {
  checkVisitRevision,
  lockVisit,
  moveVisitStatus,
  STORED_VISIT_COLUMNS,
  STORED_VISIT_JOINS,
  touchVisit,
  visitTechnicians,
  type StoredVisit,
} from "./visits.ts";

const INSTANT = (column: ReturnType<typeof sql>) =>
  sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export type DispatchVisitCard = {
  readonly visitId: string;
  readonly revision: number;
  readonly kind: "assessment" | "service";
  readonly status: VisitStatus;
  readonly number: string;
  readonly sequence: number;
  readonly title: string;
  readonly customerName: string;
  readonly priority: ServicePriority;
  readonly estimatedMinutes: number;
  readonly preferredOn: string | null;
  readonly windowStartsAt: string | null;
  readonly windowEndsAt: string | null;
  readonly slaDueAt: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly requiredQualifications: readonly { readonly id: string; readonly name: string }[];
  readonly jobId: string | null;
  readonly requestId: string | null;
};

export type DispatchTechnician = {
  readonly partyId: string;
  readonly name: string;
  readonly shortCode: string | null;
  readonly jobTitle: string | null;
  readonly inScope: boolean;
  readonly qualificationTypeIds: readonly string[];
  readonly scheduledDay: boolean | null;
  readonly scheduledHours: string | null;
  readonly absences: readonly {
    readonly onDate: string;
    readonly leaveTypeName: string;
    readonly hours: string;
  }[];
};

export type DispatchBooking = {
  readonly entryId: string;
  readonly revision: number;
  readonly workerPartyId: string;
  readonly boardId: string;
  readonly boardName: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly label: string;
  /** Visit bookings carry their visit; other bookings (other boards, codes) are shown read-only. */
  readonly visit: DispatchVisitCard | null;
};

export interface DispatchQueueFilters {
  readonly priorities?: readonly ServicePriority[];
  readonly qualificationTypeId?: string | null;
  readonly area?: string | null;
  readonly sla?: "any" | "breached" | "due_today" | "due_soon";
  readonly search?: string | null;
}

export interface DispatchDay {
  readonly board: ScheduleBoard;
  readonly date: string;
  readonly timeZone: string;
  readonly workingWindow: { readonly startsAt: string; readonly endsAt: string } | null;
  /** The span the board draws: the working day, or 06:00–20:00 local when the day has no single working window. */
  readonly displayWindow: { readonly startsAt: string; readonly endsAt: string };
  readonly technicians: readonly DispatchTechnician[];
  readonly bookings: readonly DispatchBooking[];
  readonly queue: readonly DispatchVisitCard[];
  readonly areas: readonly string[];
  readonly qualifications: readonly { readonly id: string; readonly name: string }[];
  readonly canDispatch: boolean;
  /** When this read was taken, so the board can show how fresh it is. */
  readonly readAt: string;
}

const CARD_COLUMNS = sql`v.id as "visitId", v.revision, v.kind, v.status, coalesce(j.job_number, r.request_number) as number, v.sequence,
  coalesce(j.title, r.title) as title, p.display_name as "customerName", v.priority, v.estimated_minutes as "estimatedMinutes",
  v.preferred_on::text as "preferredOn", ${INSTANT(sql`v.window_starts_at`)} as "windowStartsAt", ${INSTANT(sql`v.window_ends_at`)} as "windowEndsAt",
  ${INSTANT(sql`v.sla_due_at`)} as "slaDueAt",
  nullif(concat_ws(', ', a.line1, a.city, a.region, a.postal_code), '') as address, a.city, a.region,
  coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name) from hrm_qualification_types t
    where t.org_id = v.org_id and t.id = any(v.required_qualification_type_ids)), '[]'::jsonb) as "requiredQualifications",
  v.job_id as "jobId", v.request_id as "requestId"`;

const CARD_JOINS = sql`from service_visits v
  left join service_jobs j on j.org_id = v.org_id and j.id = v.job_id
  left join service_requests r on r.org_id = v.org_id and r.id = v.request_id
  join parties p on p.org_id = v.org_id and p.id = coalesce(j.customer_party_id, r.customer_party_id)
  left join addresses a on a.org_id = v.org_id and a.id = coalesce(j.service_address_id, r.service_address_id)`;

function subsidiaryFilter(allowed: ReadonlySet<string> | null): ReturnType<typeof sql> {
  if (allowed === null) return sql``;
  const ids = [...allowed];
  return ids.length
    ? sql` and v.subsidiary_id = any(${`{${ids.join(",")}}`}::uuid[])`
    : sql` and false`;
}

function boardSubsidiaryFilter(orgId: string, board: ScheduleBoard): ReturnType<typeof sql> {
  if (!board.subsidiaryId) return sql``;
  return sql` and v.subsidiary_id in (with recursive tree as (select id from subsidiaries where org_id = ${orgId} and id = ${board.subsidiaryId}
    union all select s.id from subsidiaries s join tree on s.parent_id = tree.id where s.org_id = ${orgId}) select id from tree)`;
}

/** 06:00–20:00 local on the date, taking the earlier instant of an ambiguous clock time. */
function fallbackDisplayWindow(
  timeZone: string,
  date: string,
): { startsAt: string; endsAt: string } {
  const at = (time: string) => {
    const resolved = resolveLocalTime({ date, time }, timeZone);
    if (resolved.kind === "ready" && resolved.choices.length) return resolved.choices[0]!.instant;
    // A clock time skipped by a change still draws: an hour later always exists.
    const later = resolveLocalTime(
      { date, time: `${String(Number(time.slice(0, 2)) + 1).padStart(2, "0")}:00` },
      timeZone,
    );
    if (later.kind === "ready" && later.choices.length) return later.choices[0]!.instant;
    throw new ServiceError("The board's time zone cannot place this day.", {
      code: "service_invalid_time",
      remedy: "Check the board's time zone in its settings.",
    });
  };
  return { startsAt: at("06:00"), endsAt: at("20:00") };
}

/** The board's working day as instants in its time zone, or null when the day has no single instant (a clock change). */
export function boardWorkingWindow(
  board: Pick<ScheduleBoard, "timeZone" | "dayStarts" | "dayEnds" | "dayPolicyKnown">,
  date: string,
): { startsAt: string; endsAt: string } | null {
  if (board.dayPolicyKnown === false) return null;
  const start = resolveLocalTime({ date, time: board.dayStarts.slice(0, 5) }, board.timeZone);
  const end = resolveLocalTime({ date, time: board.dayEnds.slice(0, 5) }, board.timeZone);
  if (
    start.kind !== "ready" ||
    end.kind !== "ready" ||
    start.choices.length !== 1 ||
    end.choices.length !== 1
  )
    return null;
  return { startsAt: start.choices[0]!.instant, endsAt: end.choices[0]!.instant };
}

async function cardsFor(
  orgId: string,
  visitIds: readonly string[],
): Promise<Map<string, DispatchVisitCard>> {
  if (!visitIds.length) return new Map();
  const rows = await db.execute<DispatchVisitCard>(
    sql`select ${CARD_COLUMNS} ${CARD_JOINS}
    where v.org_id = ${orgId} and v.id = any(${`{${visitIds.join(",")}}`}::uuid[])`,
    "objects",
  );
  return new Map(rows.map((row) => [row.visitId, row]));
}

/** Qualification types each person holds, verified and valid over [fromDate, throughDate]. */
async function heldQualifications(
  orgId: string,
  partyIds: readonly string[],
  fromDate: string,
  throughDate: string,
): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!partyIds.length) return out;
  const rows = await db.execute<{ partyId: string; typeId: string }>(
    sql`select distinct e.worker_party_id as "partyId", q.type_id as "typeId"
    from hrm_worker_qualifications q join worker_employments e on e.org_id = q.org_id and e.id = q.employment_id
    join hrm_qualification_types t on t.org_id = q.org_id and t.id = q.type_id and t.is_active
    where q.org_id = ${orgId} and e.worker_party_id = any(${`{${partyIds.join(",")}}`}::uuid[])
      and q.status = 'valid' and q.verified_by is not null and q.verified_at is not null
      and q.issued_on <= ${fromDate} and (q.expires_on is null or q.expires_on >= ${throughDate})`,
    "objects",
  );
  for (const row of rows) {
    if (!out.has(row.partyId)) out.set(row.partyId, new Set());
    out.get(row.partyId)!.add(row.typeId);
  }
  return out;
}

async function workDay(
  orgId: string,
  partyId: string,
  date: string,
): Promise<{ scheduledDay: boolean | null; scheduledHours: string | null }> {
  const schedule = await resolveWorkSchedule(db, orgId, partyId, date);
  if (!schedule) return { scheduledDay: null, scheduledHours: null };
  return {
    scheduledDay: isScheduledOn(schedule, date),
    scheduledHours: scheduledHoursOn(schedule, date),
  };
}

function queueFilters(orgId: string, filters: DispatchQueueFilters): ReturnType<typeof sql> {
  const parts: ReturnType<typeof sql>[] = [];
  const priorities = (filters.priorities ?? []).filter((priority) =>
    (SERVICE_PRIORITIES as readonly string[]).includes(priority),
  );
  if (priorities.length)
    parts.push(sql` and v.priority = any(${`{${priorities.join(",")}}`}::text[])`);
  if (filters.qualificationTypeId)
    parts.push(
      sql` and ${requireUuid(filters.qualificationTypeId, "Skill")}::uuid = any(v.required_qualification_type_ids)`,
    );
  const area = filters.area?.trim();
  if (area)
    parts.push(
      sql` and (lower(coalesce(a.city, '')) = ${area.toLowerCase()} or lower(coalesce(a.region, '')) = ${area.toLowerCase()} or lower(coalesce(a.postal_code, '')) like ${`${area.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%`})`,
    );
  if (filters.sla === "breached")
    parts.push(sql` and v.sla_due_at is not null and v.sla_due_at < now()`);
  else if (filters.sla === "due_today")
    parts.push(
      sql` and v.sla_due_at is not null and v.sla_due_at >= now() and v.sla_due_at < now() + interval '24 hours'`,
    );
  else if (filters.sla === "due_soon")
    parts.push(sql` and v.sla_due_at is not null and v.sla_due_at < now() + interval '72 hours'`);
  const search = filters.search?.trim().toLowerCase().slice(0, 80);
  if (search) {
    const pattern = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    parts.push(
      sql` and (lower(coalesce(j.title, r.title)) like ${pattern} or lower(coalesce(j.job_number, r.request_number)) like ${pattern} or lower(p.display_name) like ${pattern})`,
    );
  }
  void orgId;
  return parts.length ? sql.join(parts, sql``) : sql``;
}

/** The dispatch board for one day: technicians, every booking they hold, and the unscheduled queue. */
export async function loadDispatchDay(
  actor: ServiceActor & { boardId: string; date: string; filters?: DispatchQueueFilters },
): Promise<DispatchDay> {
  const date = requireDate(actor.date, "Day");
  return withOrgTransaction(actor.orgId, async () => {
    const board = await getBoard(actor, actor.boardId);
    await requireBoardCapability(actor, board, "dispatch");
    const allowed = await boardAuthority(actor, board, "read");
    const window: BoardWindow = await loadBoardWindow({
      ...actor,
      boardId: board.id,
      from: date,
      through: date,
    });
    const canDispatch = await boardAuthority(actor, board, "manage").then(
      () => true,
      () => false,
    );
    const partyIds = window.rows.map((row) => row.subjectId);
    const qualifications = await heldQualifications(actor.orgId, partyIds, date, date);
    const technicians: DispatchTechnician[] = [];
    for (const row of window.rows) {
      const day = await workDay(actor.orgId, row.subjectId, date);
      technicians.push({
        partyId: row.subjectId,
        name: row.name,
        shortCode: row.shortCode,
        jobTitle: row.jobTitle,
        inScope: row.inScope,
        qualificationTypeIds: [...(qualifications.get(row.subjectId) ?? [])].sort(),
        scheduledDay: day.scheduledDay,
        scheduledHours: day.scheduledHours,
        absences: window.absences
          .filter((absence) => absence.workerPartyId === row.subjectId)
          .map((absence) => ({
            onDate: absence.onDate,
            leaveTypeName: absence.leaveTypeName,
            hours: absence.hours,
          })),
      });
    }
    const live = window.entries.filter(
      (entry) => entry.status === "published" && entry.workerPartyId,
    );
    const cards = await cardsFor(actor.orgId, [
      ...new Set(
        live.map((entry) => entry.serviceVisitId).filter((id): id is string => Boolean(id)),
      ),
    ]);
    const bookings: DispatchBooking[] = live.map((entry) => ({
      entryId: entry.id,
      revision: entry.revision,
      workerPartyId: entry.workerPartyId!,
      boardId: entry.boardId,
      boardName: entry.boardName,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      label: entry.target?.code ?? entry.target?.label ?? entry.detail ?? entry.boardName,
      visit: entry.serviceVisitId ? (cards.get(entry.serviceVisitId) ?? null) : null,
    }));
    const filters = actor.filters ?? {};
    const queue = await db.execute<DispatchVisitCard>(
      sql`select ${CARD_COLUMNS} ${CARD_JOINS}
      where v.org_id = ${actor.orgId} and v.status = 'unscheduled' ${subsidiaryFilter(allowed)} ${boardSubsidiaryFilter(actor.orgId, board)}
        and (v.job_id is null or j.status = 'open') and (v.request_id is null or r.status not in ('converted','declined','cancelled'))
        ${queueFilters(actor.orgId, filters)}
      order by case v.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
        v.sla_due_at nulls last, v.preferred_on nulls last, v.created_at, v.id
      limit 200`,
      "objects",
    );
    const areas = (
      await db.execute<{ area: string }>(
        sql`select distinct coalesce(nullif(a.city, ''), nullif(a.region, '')) as area ${CARD_JOINS}
      where v.org_id = ${actor.orgId} and v.status = 'unscheduled' ${subsidiaryFilter(allowed)} and coalesce(nullif(a.city, ''), nullif(a.region, '')) is not null
      order by 1 limit 100`,
        "objects",
      )
    ).map((row) => row.area);
    const workingWindow = boardWorkingWindow(board, date);
    const qualificationTypes = await db.execute<{ id: string; name: string }>(
      sql`select id, name from hrm_qualification_types
      where org_id = ${actor.orgId} and is_active order by name limit 300`,
      "objects",
    );
    return {
      board,
      date,
      timeZone: board.timeZone,
      workingWindow,
      displayWindow: workingWindow ?? fallbackDisplayWindow(board.timeZone, date),
      technicians,
      bookings,
      queue: [...queue].sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority)),
      areas,
      qualifications: qualificationTypes,
      canDispatch,
      readAt: new Date().toISOString(),
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(scheduleDatabaseRefusal(error));
  });
}

interface ProposedSpan {
  startsAt: string;
  endsAt: string;
  startsOn: string;
  endsOn: string;
  lastDate: string;
}

function proposedSpan(board: ScheduleBoard, startsAtInput: unknown, minutes: number): ProposedSpan {
  const startsAt = requireInstant(startsAtInput, "Start");
  const endsAt = new Date(Date.parse(startsAt) + minutes * 60_000).toISOString();
  const startsOn = localTimeFields(startsAt, board.timeZone)?.date;
  const endsOn = localTimeFields(endsAt, board.timeZone)?.date;
  const lastDate = localTimeFields(
    new Date(Date.parse(endsAt) - 1).toISOString(),
    board.timeZone,
  )?.date;
  if (!startsOn || !endsOn || !lastDate)
    throw new ServiceError("The visit time cannot be placed in the board's time zone.", {
      code: "service_invalid_time",
      remedy: "Choose the time again.",
    });
  return { startsAt, endsAt, startsOn, endsOn, lastDate };
}

/** Everything the conflict rules need about one technician's day. */
export async function technicianFacts(
  orgId: string,
  board: ScheduleBoard,
  partyId: string,
  span: ProposedSpan,
  ignoreEntryIds: readonly string[],
): Promise<TechnicianDayFacts> {
  const ignore = ignoreEntryIds.length
    ? sql` and e.id <> all(${`{${ignoreEntryIds.join(",")}}`}::uuid[])`
    : sql``;
  const bookings = await db.execute<{
    id: string;
    startsAt: string;
    endsAt: string;
    label: string;
  }>(
    sql`select e.id,
      ${INSTANT(sql`e.starts_at`)} as "startsAt", ${INSTANT(sql`e.ends_at`)} as "endsAt",
      coalesce(sj.job_number, sr.request_number, cp.display_name, pr.name, sc.label, b.name) as label
    from schedule_entries e
    join schedule_boards b on b.org_id = e.org_id and b.id = e.board_id
    left join service_visits sv on sv.org_id = e.org_id and sv.id = e.service_visit_id
    left join service_jobs sj on sj.org_id = sv.org_id and sj.id = sv.job_id
    left join service_requests sr on sr.org_id = sv.org_id and sr.id = sv.request_id
    left join parties cp on cp.org_id = e.org_id and cp.id = e.customer_party_id
    left join projects pr on pr.org_id = e.org_id and pr.id = e.project_id
    left join schedule_codes sc on sc.org_id = e.org_id and sc.id = e.schedule_code_id
    where e.org_id = ${orgId} and e.worker_party_id = ${partyId} and e.status = 'published'
      and e.starts_on <= ${span.endsOn} and e.ends_on >= ${addCalendarDays(span.startsOn, -1)} ${ignore}
    order by e.starts_at`,
    "objects",
  );
  const absences = await db.execute<{ onDate: string; leaveTypeName: string }>(
    sql`select a.on_date::text as "onDate", t.name as "leaveTypeName"
    from hrm_absences a join worker_employments we on we.org_id = a.org_id and we.id = a.employment_id
    join hrm_leave_types t on t.org_id = a.org_id and t.id = a.leave_type_id
    where a.org_id = ${orgId} and we.worker_party_id = ${partyId} and a.on_date between ${span.startsOn} and ${span.lastDate}
    group by a.on_date, t.name having sum(a.hours) <> 0 order by 1`,
    "objects",
  );
  const held =
    (await heldQualifications(orgId, [partyId], span.startsOn, span.lastDate)).get(partyId) ??
    new Set<string>();
  const day = await workDay(orgId, partyId, span.startsOn);
  return {
    bookings,
    absences,
    qualificationTypeIds: held,
    scheduledDay: day.scheduledDay,
    scheduledHours: day.scheduledHours,
    workingWindow: boardWorkingWindow(board, span.startsOn),
  };
}

async function qualificationNames(
  orgId: string,
  ids: readonly string[],
): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const rows = await db.execute<{ id: string; name: string }>(
    sql`select id, name from hrm_qualification_types
    where org_id = ${orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`,
    "objects",
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.name]));
}

async function conflictsFor(
  orgId: string,
  board: ScheduleBoard,
  visit: StoredVisit,
  partyId: string,
  span: ProposedSpan,
  ignore: readonly string[],
): Promise<AssignmentConflict[]> {
  const facts = await technicianFacts(orgId, board, partyId, span, ignore);
  return evaluateAssignment(
    {
      startsAt: span.startsAt,
      endsAt: span.endsAt,
      requiredQualificationTypeIds: visit.requiredQualificationTypeIds,
      qualificationNames: await qualificationNames(orgId, visit.requiredQualificationTypeIds),
      arrivalWindow:
        visit.windowStartsAt && visit.windowEndsAt
          ? { startsAt: visit.windowStartsAt, endsAt: visit.windowEndsAt }
          : null,
      responseDueAt: visit.slaDueAt,
    },
    facts,
  );
}

function refuseConflicts(
  conflicts: readonly AssignmentConflict[],
  overrideReason: string | null,
): AssignmentConflict[] {
  const decision = assignmentDecision(conflicts, overrideReason);
  if (decision.ok) return decision.warnings;
  if (decision.blocking) {
    const first = decision.conflicts.find((conflict) => conflict.severity === "block")!;
    throw new ServiceError(first.message, {
      status: 409,
      code: "service_assignment_blocked",
      remedy: "Choose another technician or time.",
      conflicts: decision.conflicts,
    });
  }
  throw new ServiceError(decision.conflicts.map((conflict) => conflict.message).join(" "), {
    status: 409,
    code: "service_assignment_needs_override",
    remedy: "Choose another technician or time, or confirm the assignment with a reason.",
    conflicts: decision.conflicts,
  });
}

async function dispatchAuthority(
  actor: ServiceActor,
  boardId: string,
): Promise<{ board: ScheduleBoard; allowed: ReadonlySet<string> | null }> {
  const board = await getBoard(actor, boardId);
  await requireBoardCapability(actor, board, "dispatch");
  const allowed = await boardAuthority(actor, board, "manage");
  if (!board.isActive)
    throw new ServiceError("This dispatch board is archived.", {
      code: "service_board_archived",
      remedy: "Restore the board from Scheduling → Manage boards first.",
    });
  return { board, allowed };
}

function visibleVisit(visit: StoredVisit, allowed: ReadonlySet<string> | null): void {
  if (allowed !== null && !allowed.has(visit.subsidiaryId)) throw new ScopeNotFoundError();
}

function visitBooking(
  board: ScheduleBoard,
  visit: StoredVisit,
  person: { partyId: string; subsidiaryId: string | null },
  span: ProposedSpan,
  label: string,
): Normalized {
  return {
    subject: { id: person.partyId, kind: "person", subsidiaryId: person.subsidiaryId },
    target: {
      kind: "customer",
      customerPartyId: visit.customerPartyId,
      projectId: null,
      projectTaskId: null,
      locationId: null,
      scheduleCodeId: null,
      label: "",
    },
    departmentId: board.departmentId,
    detail: label.slice(0, 120),
    notes: null,
    span: {
      spanMode: "timed",
      timeZone: board.timeZone,
      startsOn: span.startsOn,
      endsOn: span.endsOn,
      startsAt: span.startsAt,
      endsAt: span.endsAt,
      breakMinutes: 0,
    },
    seriesId: null,
  };
}

async function visitLabel(orgId: string, visit: StoredVisit): Promise<string> {
  const row = (
    await db.execute<{ label: string }>(
      sql`select coalesce(j.job_number, r.request_number) || ' · ' || coalesce(j.title, r.title) as label
    from service_visits v left join service_jobs j on j.org_id = v.org_id and j.id = v.job_id left join service_requests r on r.org_id = v.org_id and r.id = v.request_id
    where v.org_id = ${orgId} and v.id = ${visit.id}`,
      "objects",
    )
  )[0];
  return row?.label ?? "Service visit";
}

/** The arrival window a newly booked visit promises: its own, else the policy's window from the booked start. */
async function arrivalWindowFor(
  orgId: string,
  visit: StoredVisit,
  span: ProposedSpan,
): Promise<{ startsAt: string; endsAt: string; set: boolean }> {
  if (visit.windowStartsAt && visit.windowEndsAt)
    return { startsAt: visit.windowStartsAt, endsAt: visit.windowEndsAt, set: false };
  const policy = await requirePolicy(orgId, span.startsOn);
  return {
    startsAt: span.startsAt,
    endsAt: new Date(
      Date.parse(span.startsAt) + policy.arrivalWindowMinutes * 60_000,
    ).toISOString(),
    set: true,
  };
}

export interface DispatchResult {
  readonly visitId: string;
  readonly visitRevision: number;
  readonly visitStatus: VisitStatus;
  readonly entryId: string | null;
  readonly entryRevision: number | null;
  /** Warnings the dispatcher overrode, recorded with the change. */
  readonly warnings: readonly AssignmentConflict[];
  readonly notices: readonly CustomerNoticeRequest[];
}

async function firstStart(orgId: string, visitId: string): Promise<string | null> {
  return (await visitTechnicians(orgId, visitId))[0]?.startsAt ?? null;
}

/** Preview the conflicts an assignment would meet, without writing. */
export async function previewAssignment(
  actor: ServiceActor & {
    boardId: string;
    visitId: string;
    workerPartyId: string;
    startsAt: string;
    minutes?: number;
    movingEntryId?: string | null;
  },
): Promise<AssignmentConflict[]> {
  return withOrgTransaction(actor.orgId, async () => {
    const { board, allowed } = await dispatchAuthority(actor, actor.boardId);
    const stored = (
      await db.execute<StoredVisit>(
        sql`select ${STORED_VISIT_COLUMNS} ${STORED_VISIT_JOINS}
      where v.org_id = ${actor.orgId} and v.id = ${requireUuid(actor.visitId, "Visit")}`,
        "objects",
      )
    )[0];
    if (!stored) throw new ScopeNotFoundError();
    visibleVisit(stored, allowed);
    await bookablePerson(actor.orgId, allowed, requireUuid(actor.workerPartyId, "Technician"));
    const span = proposedSpan(
      board,
      actor.startsAt,
      actor.minutes === undefined
        ? stored.estimatedMinutes
        : requireMinutes(actor.minutes, "Visit length"),
    );
    return conflictsFor(
      actor.orgId,
      board,
      stored,
      actor.workerPartyId,
      span,
      actor.movingEntryId ? [requireUuid(actor.movingEntryId, "Booking")] : [],
    );
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(scheduleDatabaseRefusal(error));
  });
}

/** Book a technician for a visit at a time on a dispatch board. */
export async function assignVisit(
  actor: ServiceActor & {
    boardId: string;
    visitId: string;
    expectedRevision: number;
    workerPartyId: string;
    startsAt: string;
    minutes?: number;
    overrideReason?: string | null;
  },
): Promise<DispatchResult> {
  const overrideReason = optionalText(actor.overrideReason, "Override reason", 2000);
  return withOrgTransaction(actor.orgId, async () => {
    const { board, allowed } = await dispatchAuthority(actor, actor.boardId);
    const visit = await lockVisit(actor.orgId, actor.visitId);
    visibleVisit(visit, allowed);
    checkVisitRevision(visit, actor.expectedRevision);
    if (!visitIsReschedulable(visit.status)) {
      throw new ServiceError("A visit in progress or finished cannot be assigned again.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Add a new visit to the job for further work.",
      });
    }
    const workerPartyId = requireUuid(actor.workerPartyId, "Technician");
    const current = await visitTechnicians(actor.orgId, visit.id);
    if (current.some((booking) => booking.workerPartyId === workerPartyId)) {
      throw new ServiceError("This technician is already assigned to the visit.", {
        status: 409,
        code: "service_conflict",
        remedy: "Move the existing booking instead.",
      });
    }
    const person = await bookablePerson(actor.orgId, allowed, workerPartyId);
    const minutes =
      actor.minutes === undefined
        ? visit.estimatedMinutes
        : requireMinutes(actor.minutes, "Visit length");
    const span = proposedSpan(board, actor.startsAt, minutes);
    const warnings = refuseConflicts(
      await conflictsFor(actor.orgId, board, visit, workerPartyId, span, []),
      overrideReason,
    );
    const label = await visitLabel(actor.orgId, visit);
    const entryId = randomUUID();
    const reason = overrideReason
      ? `Dispatched ${label}; override: ${overrideReason}`
      : `Dispatched ${label}`;
    await insertEntry({
      actor,
      board,
      id: entryId,
      booking: visitBooking(board, visit, person, span, label),
      status: "published",
      supersedesId: null,
      reason,
      requestHash: hash({
        visitId: visit.id,
        workerPartyId,
        startsAt: span.startsAt,
        endsAt: span.endsAt,
      }),
      requiredQualificationTypeIds: visit.requiredQualificationTypeIds,
      serviceVisitId: visit.id,
    });
    const window = await arrivalWindowFor(actor.orgId, visit, span);
    const windowSet = window.set
      ? sql`window_starts_at = ${window.startsAt}, window_ends_at = ${window.endsAt}`
      : undefined;
    const revision =
      visit.status === "unscheduled"
        ? await moveVisitStatus(actor, visit, {
            to: "scheduled",
            reason,
            workerPartyId,
            set: windowSet,
          })
        : await touchVisit(actor, visit, reason, windowSet);
    await auditService({
      orgId: actor.orgId,
      table: "schedule_entries",
      rowId: entryId,
      action: "insert",
      actorId: actor.actorId,
      after: {
        serviceVisitId: visit.id,
        workerPartyId,
        startsAt: span.startsAt,
        endsAt: span.endsAt,
        warnings: warnings.map((w) => w.code),
      },
      reason,
    });
    const starts = await firstStart(actor.orgId, visit.id);
    const notices: CustomerNoticeRequest[] =
      current.length === 0 || (starts && starts !== current[0]?.startsAt)
        ? [
            {
              visitId: visit.id,
              kind: "arrival_window",
              occurrenceKey: `booked:${starts ?? span.startsAt}`,
            },
          ]
        : [];
    return {
      visitId: visit.id,
      visitRevision: revision,
      visitStatus: visit.status === "unscheduled" ? "scheduled" : visit.status,
      entryId,
      entryRevision: 1,
      warnings,
      notices,
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(scheduleDatabaseRefusal(error));
  });
}

/**
 * Move a visit booking to another technician or time. The booking is
 * replaced by a successor that names it, so the history of who was sent
 * where is kept. A dispatched visit returns to scheduled: the move needs
 * dispatching again.
 */
export async function moveVisitBooking(
  actor: ServiceActor & {
    boardId: string;
    entryId: string;
    expectedEntryRevision: number;
    expectedVisitRevision: number;
    workerPartyId: string;
    startsAt: string;
    minutes?: number;
    overrideReason?: string | null;
  },
): Promise<DispatchResult> {
  const overrideReason = optionalText(actor.overrideReason, "Override reason", 2000);
  return withOrgTransaction(actor.orgId, async () => {
    const { board, allowed } = await dispatchAuthority(actor, actor.boardId);
    const entry = await lockStored(actor.orgId, board.id, requireUuid(actor.entryId, "Booking"));
    if (!entry.serviceVisitId)
      throw new ServiceError("This booking is not a visit booking.", {
        code: "service_invalid",
        remedy: "Change it on the timeline or grid view.",
      });
    checkRevision(entry, actor.expectedEntryRevision);
    const visit = await lockVisit(actor.orgId, entry.serviceVisitId);
    visibleVisit(visit, allowed);
    checkVisitRevision(visit, actor.expectedVisitRevision);
    if (!visitIsReschedulable(visit.status)) {
      throw new ServiceError("The technician has already left for this visit.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Record the visit as unable to complete and add another visit instead.",
      });
    }
    const workerPartyId = requireUuid(actor.workerPartyId, "Technician");
    const others = (await visitTechnicians(actor.orgId, visit.id)).filter(
      (booking) => booking.entryId !== entry.id,
    );
    if (others.some((booking) => booking.workerPartyId === workerPartyId)) {
      throw new ServiceError("This technician is already assigned to the visit.", {
        status: 409,
        code: "service_conflict",
        remedy: "Remove one of the bookings instead.",
      });
    }
    const person = await bookablePerson(actor.orgId, allowed, workerPartyId);
    const minutes =
      actor.minutes === undefined
        ? Math.round((Date.parse(entry.endsAt) - Date.parse(entry.startsAt)) / 60000)
        : requireMinutes(actor.minutes, "Visit length");
    const span = proposedSpan(board, actor.startsAt, minutes);
    const warnings = refuseConflicts(
      await conflictsFor(actor.orgId, board, visit, workerPartyId, span, [entry.id]),
      overrideReason,
    );
    const label = await visitLabel(actor.orgId, visit);
    const reason = overrideReason
      ? `Rescheduled ${label}; override: ${overrideReason}`
      : `Rescheduled ${label}`;
    const firstBefore = await firstStart(actor.orgId, visit.id);
    await setStatus(actor, entry, "cancelled", reason);
    const successorId = randomUUID();
    await insertEntry({
      actor,
      board,
      id: successorId,
      booking: visitBooking(board, visit, person, span, label),
      status: "published",
      supersedesId: entry.id,
      reason,
      requestHash: hash({
        visitId: visit.id,
        workerPartyId,
        startsAt: span.startsAt,
        endsAt: span.endsAt,
        replaces: entry.id,
      }),
      requiredQualificationTypeIds: visit.requiredQualificationTypeIds,
      serviceVisitId: visit.id,
    });
    const revision =
      visit.status === "dispatched"
        ? await moveVisitStatus(actor, visit, { to: "scheduled", reason, workerPartyId })
        : await touchVisit(actor, visit, reason);
    await auditService({
      orgId: actor.orgId,
      table: "schedule_entries",
      rowId: successorId,
      action: "insert",
      actorId: actor.actorId,
      before: {
        entryId: entry.id,
        workerPartyId: entry.workerPartyId,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
      },
      after: {
        serviceVisitId: visit.id,
        workerPartyId,
        startsAt: span.startsAt,
        endsAt: span.endsAt,
        warnings: warnings.map((w) => w.code),
      },
      reason,
    });
    const firstAfter = await firstStart(actor.orgId, visit.id);
    const notices: CustomerNoticeRequest[] =
      firstAfter && firstAfter !== firstBefore
        ? [{ visitId: visit.id, kind: "arrival_window", occurrenceKey: `booked:${firstAfter}` }]
        : [];
    return {
      visitId: visit.id,
      visitRevision: revision,
      visitStatus: visit.status === "dispatched" ? "scheduled" : visit.status,
      entryId: successorId,
      entryRevision: 1,
      warnings,
      notices,
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(scheduleDatabaseRefusal(error));
  });
}

/** Remove a technician from a visit. The last removal returns the visit to the unscheduled queue. */
export async function unassignVisitBooking(
  actor: ServiceActor & {
    boardId: string;
    entryId: string;
    expectedEntryRevision: number;
    expectedVisitRevision: number;
    reason?: string | null;
  },
): Promise<DispatchResult> {
  return withOrgTransaction(actor.orgId, async (): Promise<DispatchResult> => {
    const { board, allowed } = await dispatchAuthority(actor, actor.boardId);
    const entry = await lockStored(actor.orgId, board.id, requireUuid(actor.entryId, "Booking"));
    if (!entry.serviceVisitId)
      throw new ServiceError("This booking is not a visit booking.", {
        code: "service_invalid",
        remedy: "Remove it on the timeline or grid view.",
      });
    checkRevision(entry, actor.expectedEntryRevision);
    const visit = await lockVisit(actor.orgId, entry.serviceVisitId);
    visibleVisit(visit, allowed);
    checkVisitRevision(visit, actor.expectedVisitRevision);
    if (!visitIsReschedulable(visit.status)) {
      throw new ServiceError("The technician has already left for this visit.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Record the visit as unable to complete instead.",
      });
    }
    const label = await visitLabel(actor.orgId, visit);
    const reason = optionalText(actor.reason, "Reason", 2000) ?? `Removed from ${label}`;
    await setStatus(actor, entry, "cancelled", reason);
    const remaining = await visitTechnicians(actor.orgId, visit.id);
    const revision =
      remaining.length === 0
        ? await moveVisitStatus(actor, visit, {
            to: "unscheduled",
            reason,
            workerPartyId: entry.workerPartyId,
          })
        : await touchVisit(actor, visit, reason);
    await auditService({
      orgId: actor.orgId,
      table: "schedule_entries",
      rowId: entry.id,
      action: "update",
      actorId: actor.actorId,
      before: {
        status: "published",
        serviceVisitId: visit.id,
        workerPartyId: entry.workerPartyId,
        startsAt: entry.startsAt,
      },
      after: { status: "cancelled" },
      reason,
    });
    return {
      visitId: visit.id,
      visitRevision: revision,
      visitStatus: remaining.length === 0 ? "unscheduled" : visit.status,
      entryId: null,
      entryRevision: null,
      warnings: [],
      notices: [],
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(scheduleDatabaseRefusal(error));
  });
}

/** Send a scheduled visit to its technicians: they see it as dispatched on My visits. */
export async function dispatchVisit(
  actor: ServiceActor & { boardId: string; visitId: string; expectedRevision: number },
): Promise<DispatchResult> {
  return withOrgTransaction(actor.orgId, async (): Promise<DispatchResult> => {
    const { allowed } = await dispatchAuthority(actor, actor.boardId);
    const visit = await lockVisit(actor.orgId, actor.visitId);
    visibleVisit(visit, allowed);
    checkVisitRevision(visit, actor.expectedRevision);
    if (visit.status !== "scheduled")
      throw new ServiceError("Only a scheduled visit is dispatched.", {
        status: 409,
        code: "service_invalid_transition",
        remedy: "Assign a technician first, or reload the board.",
      });
    const revision = await moveVisitStatus(actor, visit, {
      to: "dispatched",
      reason: "Dispatched to the technician",
    });
    return {
      visitId: visit.id,
      visitRevision: revision,
      visitStatus: "dispatched" as const,
      entryId: null,
      entryRevision: null,
      warnings: [],
      notices: [],
    };
  }).catch((error: unknown) => {
    throw serviceDatabaseRefusal(scheduleDatabaseRefusal(error));
  });
}
