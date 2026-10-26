/**
 * Recurring shift patterns on people boards: the pattern library, the
 * assignments that apply a pattern to a person, occurrence exceptions and
 * deterministic generation of bookings.
 *
 * Generation is idempotent. For each occurrence in the window it books the
 * occurrence when no live booking holds it, revises a generated booking whose
 * pattern definition changed, and keeps a booking a person changed on the
 * board. Occurrences no longer wanted — an omission, a removed slot or an
 * assignment that ended — lose their future bookings. Bookings that have
 * started are never touched, and the board's publication policy decides
 * when a generated change is submitted. Tenant Flows alone determine
 * whether it releases immediately or waits for configured decisions.
 */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, withTransactionSavepoint } from "../platform/db.ts";
import { addCalendarDays, isIsoCalendarDate } from "../platform/civil-date.ts";
import { isUuid } from "../platform/uuid.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { ScopeNotFoundError, subsidiaryVisibleFilter } from "../organization/subsidiary-scope.ts";
import {
  boardAuthority,
  getBoard,
  peopleBoardAuthority,
  requireBoardCapability,
  type ScheduleActor,
  type ScheduleBoard,
} from "./boards.ts";
import { ScheduleError, scheduleDatabaseRefusal } from "./errors.ts";
import {
  bookablePerson,
  cancelPendingRevisions,
  hash,
  insertEntry,
  removePublished,
  setStatus,
  STORED_COLUMNS,
  type Normalized,
  type StoredEntry,
} from "./entries.ts";
import {
  normalizePattern,
  occurrenceKey,
  patternOccurrences,
  type OccurrenceException,
  type OccurrenceProblem,
  type PatternOccurrence,
  type PatternSlot,
} from "./patterns.ts";
import { requireDate } from "./spans.ts";
import { resolveTarget, type ResolvedTarget, type TargetRef } from "./targets.ts";

export type SchedulePattern = {
  readonly id: string;
  readonly subsidiaryId: string | null;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly timeZone: string;
  readonly cycleDays: number;
  readonly cycleAnchor: string;
  readonly slots: readonly PatternSlot[];
  readonly targetKind: TargetRef["kind"] | null;
  readonly targetId: string | null;
  readonly projectTaskId: string | null;
  readonly departmentId: string | null;
  readonly detail: string | null;
  readonly horizonDays: number;
  readonly isActive: boolean;
  readonly revision: number;
};

const PATTERN_COLUMNS = sql`id, subsidiary_id as "subsidiaryId", code, name, description, time_zone as "timeZone", cycle_days as "cycleDays",
  cycle_anchor::text as "cycleAnchor", slots, target_kind as "targetKind", coalesce(customer_party_id, project_id, location_id, schedule_code_id) as "targetId",
  project_task_id as "projectTaskId", department_id as "departmentId", detail, horizon_days as "horizonDays", is_active as "isActive", revision`;

export interface PatternInput {
  readonly subsidiaryId: string | null;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly timeZone: string;
  readonly cycleDays: number;
  readonly cycleAnchor: string;
  readonly slots: readonly PatternSlot[];
  readonly target: TargetRef | null;
  readonly projectTaskId: string | null;
  readonly departmentId: string | null;
  readonly detail: string | null;
  readonly horizonDays: number;
  readonly isActive: boolean;
  readonly reason: string;
}

function text(value: unknown, field: string, maximum: number, required: true): string;
function text(value: unknown, field: string, maximum: number, required: false): string | null;
function text(value: unknown, field: string, maximum: number, required: boolean): string | null {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) {
    if (required)
      throw new ScheduleError(`${field} is required.`, {
        code: "schedule_invalid",
        remedy: `Enter the ${field.toLowerCase()}.`,
      });
    return null;
  }
  if (typeof value !== "string" || value.trim().length > maximum)
    throw new ScheduleError(`${field} must be text of at most ${maximum} characters.`, {
      code: "schedule_invalid",
    });
  return value.trim();
}

function requireId(value: unknown, field: string): string {
  if (!isUuid(value))
    throw new ScheduleError(`${field} is not recognized.`, { code: "schedule_invalid" });
  return value;
}

async function requireQualificationTypes(
  orgId: string,
  slots: readonly PatternSlot[],
): Promise<void> {
  const ids = [...new Set(slots.flatMap((slot) => slot.qualificationTypeIds))];
  if (!ids.length) return;
  if (!(await lockAndCheckOrgFeature(db, orgId, "hrmCertifications"))) {
    throw new ScheduleError("Qualification requirements need Certifications and licenses.", {
      code: "schedule_feature_disabled",
      remedy:
        "Enable Certifications and licenses on Company Settings → Features, or remove the requirements.",
    });
  }
  const found = await db.execute<{ id: string }>(
    sql`select id from hrm_qualification_types where org_id = ${orgId} and is_active
    and id = any(${`{${ids.join(",")}}`}::uuid[]) for share`,
    "objects",
  );
  if (found.length !== ids.length) {
    throw new ScheduleError("A required qualification type is inactive or unknown.", {
      code: "schedule_invalid",
      remedy: "Choose active qualification types from the qualification taxonomy.",
    });
  }
}

/** Create or revise a pattern. Revisions change only bookings generated afterwards. */
export async function savePattern(
  actor: ScheduleActor,
  input: PatternInput & { id?: string; expectedRevision?: number },
): Promise<{ id: string; record: SchedulePattern }> {
  if (input.expectedRevision !== undefined && input.id === undefined) {
    throw new ScheduleError("Name the pattern and its current revision to change it.", {
      status: 409,
      code: "schedule_stale",
      remedy: "Reload the pattern.",
    });
  }
  const subsidiaryId =
    input.subsidiaryId === null ? null : requireId(input.subsidiaryId, "Legal entity");
  const code = text(input.code, "Code", 64, true),
    name = text(input.name, "Name", 160, true);
  const description = text(input.description, "Description", 2000, false),
    detail = text(input.detail, "Detail", 120, false);
  const reason = text(input.reason, "Reason", 2000, true);
  if (
    !Number.isSafeInteger(input.horizonDays) ||
    input.horizonDays < 1 ||
    input.horizonDays > 366
  ) {
    throw new ScheduleError("Bookings are generated 1 through 366 days ahead.", {
      code: "schedule_invalid",
      remedy: "Enter how many days ahead to keep bookings generated.",
    });
  }
  if (typeof input.isActive !== "boolean")
    throw new ScheduleError("Choose whether the pattern is active.", { code: "schedule_invalid" });
  const pattern = normalizePattern({
    timeZone: input.timeZone,
    cycleDays: input.cycleDays,
    cycleAnchor: input.cycleAnchor,
    slots: input.slots,
  });
  return withOrgTransaction(actor.orgId, async () => {
    const allowed = await peopleBoardAuthority(actor, "hrm.shifts.manage", subsidiaryId);
    if (subsidiaryId === null && allowed !== null) {
      throw new ScheduleError(
        "Organization-wide patterns are managed by people with access to every legal entity.",
        { code: "schedule_scope", remedy: "Choose the legal entity this pattern belongs to." },
      );
    }
    if (
      subsidiaryId &&
      !(
        await db.execute(
          sql`select id from subsidiaries where org_id = ${actor.orgId} and id = ${subsidiaryId} and is_active for share`,
          "objects",
        )
      ).length
    ) {
      throw new ScopeNotFoundError();
    }
    const target = await resolveTarget(db, actor.orgId, allowed, input.target, input.projectTaskId);
    const departmentId =
      input.departmentId === null ? null : requireId(input.departmentId, "Department");
    if (
      departmentId &&
      !(
        await db.execute(
          sql`select id from departments where org_id = ${actor.orgId} and id = ${departmentId} and is_active for share`,
          "objects",
        )
      ).length
    ) {
      throw new ScheduleError("The department is not available.", {
        code: "schedule_invalid",
        remedy: "Pick an active department.",
      });
    }
    await requireQualificationTypes(actor.orgId, pattern.slots);
    const values = sql`time_zone = ${pattern.timeZone}, cycle_days = ${pattern.cycleDays}, cycle_anchor = ${pattern.cycleAnchor}, slots = ${JSON.stringify(pattern.slots)}::jsonb,
      target_kind = ${target?.kind ?? null}, customer_party_id = ${target?.customerPartyId ?? null}, project_id = ${target?.projectId ?? null},
      project_task_id = ${target?.projectTaskId ?? null}, location_id = ${target?.locationId ?? null}, schedule_code_id = ${target?.scheduleCodeId ?? null},
      department_id = ${departmentId}, detail = ${detail}, horizon_days = ${input.horizonDays}, is_active = ${input.isActive}, name = ${name}, description = ${description}, reason = ${reason}`;
    if (input.expectedRevision !== undefined) {
      const id = requireId(input.id, "Pattern");
      const before = (
        await db.execute<SchedulePattern>(
          sql`select ${PATTERN_COLUMNS} from schedule_patterns where org_id = ${actor.orgId} and id = ${id}
        ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed, { orgWideNull: true })} for update`,
          "objects",
        )
      )[0];
      if (!before) throw new ScopeNotFoundError();
      if (before.code !== code || before.subsidiaryId !== subsidiaryId) {
        throw new ScheduleError("A pattern keeps its code and legal entity.", {
          code: "schedule_invalid",
          remedy: "Create a new pattern for a different code or legal entity.",
        });
      }
      if (before.revision !== input.expectedRevision) {
        throw new ScheduleError("Someone changed this pattern since it was loaded.", {
          status: 409,
          code: "schedule_stale",
          remedy: "Reload the pattern and make the change again.",
        });
      }
      const updated = await db.execute<SchedulePattern>(
        sql`update schedule_patterns set ${values}, revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
        where org_id = ${actor.orgId} and id = ${id} and revision = ${input.expectedRevision} returning ${PATTERN_COLUMNS}`,
        "objects",
      );
      if (updated.length !== 1)
        throw new ScheduleError("Someone changed this pattern since it was loaded.", {
          status: 409,
          code: "schedule_stale",
          remedy: "Reload the pattern.",
        });
      return { id, record: updated[0]! };
    }
    const id = input.id === undefined ? crypto.randomUUID() : requireId(input.id, "Pattern key");
    const saved = await db.execute<SchedulePattern>(
      sql`insert into schedule_patterns (id, org_id, subsidiary_id, code, name, description, time_zone, cycle_days, cycle_anchor, slots,
      target_kind, customer_party_id, project_id, project_task_id, location_id, schedule_code_id, department_id, detail, horizon_days, is_active, reason, created_by, updated_by)
      values (${id}, ${actor.orgId}, ${subsidiaryId}, ${code}, ${name}, ${description}, ${pattern.timeZone}, ${pattern.cycleDays}, ${pattern.cycleAnchor}, ${JSON.stringify(pattern.slots)}::jsonb,
      ${target?.kind ?? null}, ${target?.customerPartyId ?? null}, ${target?.projectId ?? null}, ${target?.projectTaskId ?? null}, ${target?.locationId ?? null}, ${target?.scheduleCodeId ?? null},
      ${departmentId}, ${detail}, ${input.horizonDays}, ${input.isActive}, ${reason}, ${actor.actorId}, ${actor.actorId}) returning ${PATTERN_COLUMNS}`,
      "objects",
    );
    if (saved.length !== 1)
      throw new ScheduleError("The pattern was not saved.", {
        code: "schedule_not_saved",
        remedy: "Reload Setup and try again.",
      });
    return { id, record: saved[0]! };
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

/** Active patterns a board's manager may assign to people of that board. */
export function listBoardPatterns(
  actor: ScheduleActor & { boardId: string },
): Promise<SchedulePattern[]> {
  return withOrgTransaction(actor.orgId, async () => {
    const board = await peopleBoard(actor, actor.boardId);
    const allowed = await boardAuthority(actor, board, "read");
    return await db.execute<SchedulePattern>(
      sql`select ${PATTERN_COLUMNS} from schedule_patterns where org_id = ${actor.orgId} and is_active
      ${board.subsidiaryId ? sql`and (subsidiary_id is null or subsidiary_id = ${board.subsidiaryId})` : sql``}
      ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed, { orgWideNull: true })} order by code, id`,
      "objects",
    );
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

async function peopleBoard(actor: ScheduleActor, boardId: string): Promise<ScheduleBoard> {
  const board = await getBoard(actor, requireId(boardId, "Board"));
  await requireBoardCapability(actor, board, "patterns");
  return board;
}

export type PatternAssignment = {
  readonly id: string;
  readonly boardId: string;
  readonly patternId: string;
  readonly patternCode: string;
  readonly patternName: string;
  readonly workerPartyId: string;
  readonly workerName: string;
  readonly employmentId: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly status: "active" | "ended" | "cancelled";
  readonly generatedThrough: string | null;
  readonly lastGeneration: GenerationSummary | null;
  readonly revision: number;
  readonly exceptions: readonly PatternExceptionRecord[];
};

export type PatternExceptionRecord = {
  readonly id: string;
  readonly occursOn: string;
  readonly slotIndex: number;
  readonly kind: "omit" | "select_instant";
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly reason: string;
};

const ASSIGNMENT_COLUMNS = sql`a.id, a.board_id as "boardId", a.pattern_id as "patternId", p.code as "patternCode", p.name as "patternName",
  a.worker_party_id as "workerPartyId", w.display_name as "workerName", a.employment_id as "employmentId",
  a.effective_from::text as "effectiveFrom", a.effective_to::text as "effectiveTo", a.status, a.generated_through::text as "generatedThrough",
  a.last_generation as "lastGeneration", a.revision, a.subsidiary_id as "subsidiaryId", a.created_by as "createdBy", a.request_hash as "requestHash"`;

type AssignmentRow = Omit<PatternAssignment, "exceptions"> & {
  subsidiaryId: string | null;
  createdBy: string;
  requestHash: string;
};

async function readAssignments(
  orgId: string,
  filter: ReturnType<typeof sql>,
): Promise<PatternAssignment[]> {
  const rows = await db.execute<AssignmentRow>(
    sql`select ${ASSIGNMENT_COLUMNS} from schedule_pattern_assignments a
    join schedule_patterns p on p.org_id = a.org_id and p.id = a.pattern_id
    join parties w on w.org_id = a.org_id and w.id = a.worker_party_id
    where a.org_id = ${orgId} and ${filter} order by w.display_name, a.effective_from, a.id`,
    "objects",
  );
  if (!rows.length) return [];
  const exceptions = await db.execute<PatternExceptionRecord & { assignmentId: string }>(
    sql`select id, assignment_id as "assignmentId", occurs_on::text as "occursOn",
    slot_index as "slotIndex", kind, to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startsAt",
    to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "endsAt", reason
    from schedule_pattern_exceptions where org_id = ${orgId} and revoked_at is null
      and assignment_id = any(${`{${rows.map((row) => row.id).join(",")}}`}::uuid[]) order by occurs_on, slot_index`,
    "objects",
  );
  return rows.map(
    ({ subsidiaryId: _subsidiary, createdBy: _created, requestHash: _hash, ...row }) => ({
      ...row,
      exceptions: exceptions
        .filter((item) => item.assignmentId === row.id)
        .map(({ assignmentId: _assignment, ...item }) => item),
    }),
  );
}

/** The pattern assignments on a people board. */
export function listBoardAssignments(
  actor: ScheduleActor & { boardId: string },
): Promise<PatternAssignment[]> {
  return withOrgTransaction(actor.orgId, async () => {
    const board = await peopleBoard(actor, actor.boardId);
    const allowed = await boardAuthority(actor, board, "read");
    return readAssignments(
      actor.orgId,
      sql`a.board_id = ${board.id} ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, allowed)}`,
    );
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

async function lockAssignment(
  actor: ScheduleActor,
  id: string,
): Promise<{ board: ScheduleBoard; allowed: ReadonlySet<string> | null; row: AssignmentRow }> {
  const head = (
    await db.execute<{ boardId: string }>(
      sql`select board_id as "boardId" from schedule_pattern_assignments where org_id = ${actor.orgId} and id = ${requireId(id, "Assignment")}`,
      "objects",
    )
  )[0];
  if (!head) throw new ScopeNotFoundError();
  const board = await peopleBoard(actor, head.boardId);
  const allowed = await boardAuthority(actor, board, "manage");
  const row = (
    await db.execute<AssignmentRow>(
      sql`select ${ASSIGNMENT_COLUMNS} from schedule_pattern_assignments a
    join schedule_patterns p on p.org_id = a.org_id and p.id = a.pattern_id join parties w on w.org_id = a.org_id and w.id = a.worker_party_id
    where a.org_id = ${actor.orgId} and a.id = ${id} ${subsidiaryVisibleFilter(sql`a.subsidiary_id`, allowed)} for update of a`,
      "objects",
    )
  )[0];
  if (!row) throw new ScopeNotFoundError();
  return { board, allowed, row };
}

/** Resolve the person's employment when they hold exactly one employment eligible for the assignment. */
async function assignmentEmployment(
  orgId: string,
  workerPartyId: string,
  requested: string | null | undefined,
  subsidiaryId: string | null,
): Promise<string | null> {
  if (requested !== undefined && requested !== null) {
    const row = (
      await db.execute(
        sql`select id from worker_employments where org_id = ${orgId} and id = ${requireId(requested, "Employment")} and worker_party_id = ${workerPartyId} for share`,
        "objects",
      )
    )[0];
    if (!row)
      throw new ScheduleError("The employment does not belong to this person.", {
        code: "schedule_invalid",
        remedy: "Select the person's employment again.",
      });
    return requested;
  }
  if (requested === null) return null;
  const rows = await db.execute<{ id: string }>(
    sql`select id from worker_employments where org_id = ${orgId} and worker_party_id = ${workerPartyId}
    ${subsidiaryId ? sql`and employer_subsidiary_id = ${subsidiaryId}` : sql``} order by id for share`,
    "objects",
  );
  if (rows.length > 1) {
    throw new ScheduleError("This person has more than one employment.", {
      code: "schedule_employment_ambiguous",
      remedy: "Choose the employment the recurring shifts belong to.",
    });
  }
  return rows[0]?.id ?? null;
}

export interface AssignmentInput {
  readonly id: string;
  readonly boardId: string;
  readonly patternId: string;
  readonly workerPartyId: string;
  readonly employmentId?: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly reason: string;
}

/** Assign a pattern to a person on a board, then generate its first horizon of bookings. */
export async function createAssignment(
  actor: ScheduleActor & AssignmentInput,
): Promise<{ assignment: PatternAssignment; generation: GenerationSummary }> {
  const id = requireId(actor.id, "Assignment key");
  const effectiveFrom = requireDate(actor.effectiveFrom, "Start date");
  const effectiveTo =
    actor.effectiveTo === null ? null : requireDate(actor.effectiveTo, "End date");
  if (effectiveTo !== null && effectiveTo <= effectiveFrom)
    throw new ScheduleError("The assignment must end after it starts.", {
      code: "schedule_invalid_range",
      remedy: "Choose an end date after the start, or leave it open.",
    });
  const reason = text(actor.reason, "Reason", 2000, true);
  const requestHash = hash({
    boardId: actor.boardId,
    patternId: actor.patternId,
    workerPartyId: actor.workerPartyId,
    employmentId: actor.employmentId ?? null,
    effectiveFrom,
    effectiveTo,
    reason,
  });
  return withOrgTransaction(actor.orgId, async () => {
    const board = await peopleBoard(actor, actor.boardId);
    const allowed = await boardAuthority(actor, board, "manage");
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`schedule-assignment:${actor.orgId}:${id}`}, 0))`,
    );
    const existing = (
      await db.execute<{ requestHash: string; createdBy: string }>(
        sql`select request_hash as "requestHash", created_by as "createdBy"
      from schedule_pattern_assignments where org_id = ${actor.orgId} and id = ${id}`,
        "objects",
      )
    )[0];
    if (existing) {
      if (existing.requestHash !== requestHash || existing.createdBy !== actor.actorId) {
        throw new ScheduleError(
          "This assignment key was already used for a different assignment.",
          {
            status: 409,
            code: "schedule_key_reused",
            remedy: "Reload the board; the existing assignment is preserved.",
          },
        );
      }
      const [assignment] = await readAssignments(actor.orgId, sql`a.id = ${id}`);
      return {
        assignment: assignment!,
        generation: assignment!.lastGeneration ?? emptySummary(effectiveFrom, effectiveFrom),
      };
    }
    const person = await bookablePerson(actor.orgId, allowed, actor.workerPartyId);
    const pattern = (
      await db.execute<SchedulePattern>(
        sql`select ${PATTERN_COLUMNS} from schedule_patterns where org_id = ${actor.orgId} and id = ${requireId(actor.patternId, "Pattern")}
      and is_active ${subsidiaryVisibleFilter(sql`subsidiary_id`, allowed, { orgWideNull: true })} for share`,
        "objects",
      )
    )[0];
    if (!pattern)
      throw new ScheduleError("The pattern is inactive or outside your access.", {
        code: "schedule_invalid",
        remedy: "Choose an active pattern in Setup → Shift patterns.",
      });
    if (pattern.subsidiaryId && pattern.subsidiaryId !== person.subsidiaryId) {
      throw new ScheduleError("The pattern belongs to another legal entity than the person.", {
        code: "schedule_invalid",
        remedy: "Choose a pattern of the person's legal entity.",
      });
    }
    const employmentId = await assignmentEmployment(
      actor.orgId,
      person.partyId,
      actor.employmentId,
      person.subsidiaryId,
    );
    const inserted = await db.execute(
      sql`insert into schedule_pattern_assignments (id, org_id, board_id, pattern_id, worker_party_id, employment_id, subsidiary_id,
      effective_from, effective_to, reason, request_hash, created_by, updated_by)
      values (${id}, ${actor.orgId}, ${board.id}, ${pattern.id}, ${person.partyId}, ${employmentId}, ${person.subsidiaryId},
      ${effectiveFrom}, ${effectiveTo}, ${reason}, ${requestHash}, ${actor.actorId}, ${actor.actorId}) returning id`,
      "objects",
    );
    if (inserted.length !== 1)
      throw new ScheduleError("The assignment was not saved.", {
        code: "schedule_not_saved",
        remedy: "Reload the board and try again.",
      });
    const generation = await generate(actor, board, allowed, id, {
      through: null,
      reason: `Recurring pattern ${pattern.code} assigned`,
    });
    const [assignment] = await readAssignments(actor.orgId, sql`a.id = ${id}`);
    return { assignment: assignment!, generation };
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

/** End an assignment from a date (exclusive) or cancel it; future bookings it generated are removed. */
export async function closeAssignment(
  actor: ScheduleActor & {
    assignmentId: string;
    expectedRevision: number;
    action: "end" | "cancel";
    effectiveTo?: string;
    reason: string;
  },
): Promise<{ assignment: PatternAssignment; generation: GenerationSummary }> {
  const reason = text(actor.reason, "Reason", 2000, true);
  return withOrgTransaction(actor.orgId, async () => {
    const { board, allowed, row } = await lockAssignment(actor, actor.assignmentId);
    if (row.revision !== actor.expectedRevision)
      throw new ScheduleError("Someone changed this assignment since it was loaded.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Reload the board.",
      });
    if (row.status !== "active")
      throw new ScheduleError("This assignment has already ended.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Create a new assignment to continue the pattern.",
      });
    let effectiveTo = row.effectiveTo;
    if (actor.action === "end") {
      effectiveTo = requireDate(actor.effectiveTo, "End date");
      if (
        effectiveTo <= row.effectiveFrom ||
        (row.effectiveTo !== null && effectiveTo > row.effectiveTo)
      ) {
        throw new ScheduleError(
          "The end date must fall after the start and no later than the planned end.",
          {
            code: "schedule_invalid_range",
            remedy: "Choose the first date the person no longer works the pattern.",
          },
        );
      }
    } else if (actor.action !== "cancel")
      throw new ScheduleError("Choose to end or cancel the assignment.", {
        code: "schedule_invalid",
      });
    const updated = await db.execute(
      sql`update schedule_pattern_assignments set status = ${actor.action === "end" ? "ended" : "cancelled"}, effective_to = ${effectiveTo},
      reason = ${reason}, revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
      where org_id = ${actor.orgId} and id = ${row.id} and revision = ${row.revision} returning id`,
      "objects",
    );
    if (updated.length !== 1)
      throw new ScheduleError("Someone changed this assignment since it was loaded.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Reload the board.",
      });
    const generation = await generate(actor, board, allowed, row.id, { through: null, reason });
    const [assignment] = await readAssignments(actor.orgId, sql`a.id = ${row.id}`);
    return { assignment: assignment!, generation };
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

/** Omit an occurrence, or select the real instants of a clock time a daylight-saving change repeats. */
export async function recordPatternException(
  actor: ScheduleActor & {
    assignmentId: string;
    occursOn: string;
    slotIndex: number;
    kind: "omit" | "select_instant";
    startsAt?: string;
    endsAt?: string;
    reason: string;
  },
): Promise<{ assignment: PatternAssignment; generation: GenerationSummary }> {
  const occursOn = requireDate(actor.occursOn, "Occurrence date");
  const reason = text(actor.reason, "Reason", 2000, true);
  if (!Number.isSafeInteger(actor.slotIndex) || actor.slotIndex < 0 || actor.slotIndex > 999)
    throw new ScheduleError("The slot is not recognized.", { code: "schedule_invalid" });
  if (actor.kind !== "omit" && actor.kind !== "select_instant")
    throw new ScheduleError("Choose to omit the occurrence or select its instants.", {
      code: "schedule_invalid",
    });
  return withOrgTransaction(actor.orgId, async () => {
    const { board, allowed, row } = await lockAssignment(actor, actor.assignmentId);
    const existing = (
      await db.execute(
        sql`select id from schedule_pattern_exceptions where org_id = ${actor.orgId} and assignment_id = ${row.id}
      and occurs_on = ${occursOn} and slot_index = ${actor.slotIndex} and revoked_at is null for update`,
        "objects",
      )
    )[0];
    if (existing)
      throw new ScheduleError("This occurrence already has an exception.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Revoke the existing exception first.",
      });
    const inserted = await db.execute(
      sql`insert into schedule_pattern_exceptions (org_id, assignment_id, occurs_on, slot_index, kind, starts_at, ends_at, reason, created_by)
      values (${actor.orgId}, ${row.id}, ${occursOn}, ${actor.slotIndex}, ${actor.kind}, ${actor.kind === "select_instant" ? (actor.startsAt ?? null) : null},
      ${actor.kind === "select_instant" ? (actor.endsAt ?? null) : null}, ${reason}, ${actor.actorId}) returning id`,
      "objects",
    );
    if (inserted.length !== 1)
      throw new ScheduleError("The exception was not saved.", {
        code: "schedule_not_saved",
        remedy: "Reload the board.",
      });
    const generation = await generate(actor, board, allowed, row.id, {
      from: occursOn,
      through: occursOn,
      reason,
    });
    if (
      actor.kind === "select_instant" &&
      generation.problems.some(
        (problem) => problem.occursOn === occursOn && problem.slotIndex === actor.slotIndex,
      )
    ) {
      throw new ScheduleError(
        "The selected instants are not real occurrences of the slot's clock times.",
        {
          code: "schedule_pattern_selection_mismatch",
          remedy: "Choose one of the occurrences listed for this date.",
        },
      );
    }
    const [assignment] = await readAssignments(actor.orgId, sql`a.id = ${row.id}`);
    return { assignment: assignment!, generation };
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

export async function revokePatternException(
  actor: ScheduleActor & { exceptionId: string; reason: string },
): Promise<{ assignment: PatternAssignment; generation: GenerationSummary }> {
  const reason = text(actor.reason, "Reason", 2000, true);
  return withOrgTransaction(actor.orgId, async () => {
    const exception = (
      await db.execute<{ assignmentId: string; occursOn: string }>(
        sql`select assignment_id as "assignmentId", occurs_on::text as "occursOn"
      from schedule_pattern_exceptions where org_id = ${actor.orgId} and id = ${requireId(actor.exceptionId, "Exception")} and revoked_at is null`,
        "objects",
      )
    )[0];
    if (!exception) throw new ScopeNotFoundError();
    const { board, allowed, row } = await lockAssignment(actor, exception.assignmentId);
    const updated = await db.execute(
      sql`update schedule_pattern_exceptions set revoked_at = now(), revoked_by = ${actor.actorId}, revoke_reason = ${reason}
      where org_id = ${actor.orgId} and id = ${actor.exceptionId} and revoked_at is null returning id`,
      "objects",
    );
    if (updated.length !== 1)
      throw new ScheduleError("The exception was already revoked.", {
        status: 409,
        code: "schedule_stale",
        remedy: "Reload the board.",
      });
    const generation = await generate(actor, board, allowed, row.id, {
      from: exception.occursOn,
      through: exception.occursOn,
      reason,
    });
    const [assignment] = await readAssignments(actor.orgId, sql`a.id = ${row.id}`);
    return { assignment: assignment!, generation };
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

/** Generate an assignment's bookings through a date (default: the pattern's horizon). */
export async function generateAssignment(
  actor: ScheduleActor & { assignmentId: string; through?: string | null; reason?: string | null },
): Promise<GenerationSummary> {
  return withOrgTransaction(actor.orgId, async () => {
    const { board, allowed, row } = await lockAssignment(actor, actor.assignmentId);
    return generate(actor, board, allowed, row.id, {
      through: actor.through ? requireDate(actor.through, "Generate through") : null,
      reason:
        text(actor.reason ?? null, "Reason", 2000, false) ?? `Recurring pattern ${row.patternCode}`,
    });
  }).catch((error: unknown) => {
    throw scheduleDatabaseRefusal(error);
  });
}

export type GenerationFailure = {
  readonly occursOn: string;
  readonly slotIndex: number;
  readonly message: string;
  readonly remedy: string | null;
};

export type GenerationSummary = {
  readonly from: string;
  readonly through: string;
  readonly created: number;
  readonly revised: number;
  readonly removed: number;
  readonly kept: number;
  readonly unchanged: number;
  readonly problems: readonly OccurrenceProblem[];
  readonly failures: readonly GenerationFailure[];
};

function emptySummary(from: string, through: string): GenerationSummary {
  return {
    from,
    through,
    created: 0,
    revised: 0,
    removed: 0,
    kept: 0,
    unchanged: 0,
    problems: [],
    failures: [],
  };
}

type PatternRow = SchedulePattern & {
  customerPartyId: string | null;
  projectId: string | null;
  locationId: string | null;
  scheduleCodeId: string | null;
};

function sameBooking(
  row: StoredEntry,
  want: PatternOccurrence,
  target: ResolvedTarget | null,
  departmentId: string | null,
  detail: string | null,
  employmentId: string | null,
): boolean {
  const targetId = target
    ? (target.customerPartyId ?? target.projectId ?? target.locationId ?? target.scheduleCodeId)
    : null;
  return (
    row.startsAt === want.startsAt &&
    row.endsAt === want.endsAt &&
    row.breakMinutes === want.breakMinutes &&
    row.timeZone === want.timeZone &&
    row.spanMode === "timed" &&
    (row.targetKind ?? null) === (target?.kind ?? null) &&
    (row.targetId ?? null) === targetId &&
    (row.projectTaskId ?? null) === (target?.projectTaskId ?? null) &&
    (row.departmentId ?? null) === departmentId &&
    (row.detail ?? null) === detail &&
    (row.employmentId ?? null) === employmentId &&
    [...row.requiredQualificationTypeIds].sort().join(",") ===
      [...want.qualificationTypeIds].sort().join(",")
  );
}

/**
 * Bring an assignment's future bookings in line with its pattern over a
 * window. Runs inside the caller's transaction and authority; each
 * occurrence is isolated so a conflict (leave, a double booking, a missing
 * qualification) is reported without discarding the rest.
 */
async function generate(
  actor: ScheduleActor,
  board: ScheduleBoard,
  allowed: ReadonlySet<string> | null,
  assignmentId: string,
  options: { from?: string; through: string | null; reason: string },
): Promise<GenerationSummary> {
  const assignment = (
    await db.execute<{
      status: string;
      effectiveFrom: string;
      effectiveTo: string | null;
      generatedThrough: string | null;
      workerPartyId: string;
      employmentId: string | null;
      patternId: string;
    }>(
      sql`select status, effective_from::text as "effectiveFrom", effective_to::text as "effectiveTo",
    generated_through::text as "generatedThrough", worker_party_id as "workerPartyId", employment_id as "employmentId", pattern_id as "patternId"
    from schedule_pattern_assignments where org_id = ${actor.orgId} and id = ${assignmentId} for update`,
      "objects",
    )
  )[0];
  if (!assignment) throw new ScopeNotFoundError();
  const pattern = (
    await db.execute<PatternRow>(
      sql`select ${PATTERN_COLUMNS}, customer_party_id as "customerPartyId", project_id as "projectId",
    location_id as "locationId", schedule_code_id as "scheduleCodeId" from schedule_patterns where org_id = ${actor.orgId} and id = ${assignment.patternId} for share`,
      "objects",
    )
  )[0]!;
  const clock = (
    await db.execute<{ today: string; now: string }>(
      sql`select (now() at time zone ${board.timeZone})::date::text as today,
    to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`,
      "objects",
    )
  )[0]!;
  const from = [options.from ?? clock.today, clock.today, assignment.effectiveFrom].sort().at(-1)!;
  const horizon = addCalendarDays(clock.today, pattern.horizonDays - 1);
  const requested = options.through ?? horizon;
  if (!isIsoCalendarDate(requested))
    throw new ScheduleError("Generate through needs a real calendar date.", {
      code: "schedule_invalid_date",
    });
  const scopeThrough = [requested, assignment.generatedThrough ?? requested].sort().at(-1)!;
  // Every occurrence the assignment still holds is reconciled, so a narrow
  // request never removes bookings generated further ahead.
  const lastWanted =
    assignment.status === "cancelled"
      ? null
      : assignment.effectiveTo
        ? [scopeThrough, addCalendarDays(assignment.effectiveTo, -1)].sort()[0]!
        : scopeThrough;
  const summary = {
    ...emptySummary(from, scopeThrough),
    problems: [] as OccurrenceProblem[],
    failures: [] as GenerationFailure[],
  };
  if (scopeThrough < from) return summary;

  const desired = new Map<string, PatternOccurrence>();
  if (lastWanted !== null && lastWanted >= from && pattern.isActive) {
    const exceptions = new Map<string, OccurrenceException>(
      (
        await db.execute<{
          occursOn: string;
          slotIndex: number;
          kind: "omit" | "select_instant";
          startsAt: string | null;
          endsAt: string | null;
          reason: string;
        }>(
          sql`
      select occurs_on::text as "occursOn", slot_index as "slotIndex", kind, reason,
        to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startsAt", to_char(ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "endsAt"
      from schedule_pattern_exceptions where org_id = ${actor.orgId} and assignment_id = ${assignmentId} and revoked_at is null and occurs_on between ${from} and ${lastWanted}`,
          "objects",
        )
      ).map((row) => [
        occurrenceKey(row.occursOn, row.slotIndex),
        row.kind === "omit"
          ? { kind: "omit", reason: row.reason }
          : { kind: "select_instant", startsAt: row.startsAt!, endsAt: row.endsAt! },
      ]),
    );
    const expansion = patternOccurrences({ pattern, from, through: lastWanted, exceptions });
    summary.problems.push(...expansion.problems);
    for (const occurrence of expansion.occurrences)
      desired.set(occurrenceKey(occurrence.occursOn, occurrence.slotIndex), occurrence);
  }
  const target = desired.size
    ? await resolveTarget(
        db,
        actor.orgId,
        allowed,
        pattern.targetKind && pattern.targetId
          ? { kind: pattern.targetKind, id: pattern.targetId }
          : null,
        pattern.projectTaskId,
      )
    : null;
  const departmentId = pattern.departmentId ?? board.departmentId;
  const person = desired.size
    ? (
        await db.execute<{ subsidiaryId: string | null }>(
          sql`select subsidiary_id as "subsidiaryId" from parties where org_id = ${actor.orgId} and id = ${assignment.workerPartyId}`,
          "objects",
        )
      )[0]!
    : null;

  const live = await db.execute<StoredEntry>(
    sql`select ${STORED_COLUMNS} from schedule_entries
    where org_id = ${actor.orgId} and pattern_assignment_id = ${assignmentId} and status <> 'cancelled' and pattern_occurs_on between ${from} and ${scopeThrough}
    order by pattern_occurs_on, pattern_slot, status desc for update`,
    "objects",
  );
  const byKey = new Map<string, { published?: StoredEntry; draft?: StoredEntry }>();
  for (const row of live) {
    const key = occurrenceKey(row.patternOccursOn!, row.patternSlot!);
    const slot = byKey.get(key) ?? {};
    if (row.status === "published") slot.published = row;
    else slot.draft = row;
    byKey.set(key, slot);
  }
  const reason = options.reason;
  const keys = [...new Set([...desired.keys(), ...byKey.keys()])].sort();
  for (const key of keys) {
    const want = desired.get(key);
    const held = byKey.get(key) ?? {};
    const [occursOn, slotText] = key.split(":");
    const slotIndex = Number(slotText);
    try {
      await withTransactionSavepoint(db, async () => {
        if (!want) {
          // Not wanted: remove future bookings that still hold the occurrence.
          let removed = false;
          if (held.draft && !held.draft.started) {
            await setStatus(actor, held.draft, "cancelled", reason);
            removed = true;
          }
          if (held.published && !held.published.started) {
            await cancelPendingRevisions(actor, held.published.id, reason);
            await removePublishedForPattern(actor, board, held.published, reason);
            removed = true;
          }
          if (removed) summary.removed++;
          return;
        }
        const head = held.draft ?? held.published;
        if (head?.patternOverride) {
          summary.kept++;
          return;
        }
        if (
          head &&
          sameBooking(head, want, target, departmentId, pattern.detail, assignment.employmentId)
        ) {
          summary.unchanged++;
          return;
        }
        if (head?.started) {
          summary.kept++;
          return;
        }
        const booking: Normalized = {
          subject: {
            id: assignment.workerPartyId,
            kind: "person",
            subsidiaryId: person?.subsidiaryId ?? null,
          },
          target,
          departmentId,
          detail: pattern.detail,
          notes: null,
          seriesId: null,
          span: {
            spanMode: "timed",
            timeZone: want.timeZone,
            startsOn: want.startsOn,
            endsOn: want.endsOn,
            startsAt: want.startsAt,
            endsAt: want.endsAt,
            breakMinutes: want.breakMinutes,
          },
        };
        const generatedHash = hash({
          assignmentId,
          occursOn,
          slotIndex,
          pattern: pattern.id,
          revision: pattern.revision,
          span: booking.span,
          target,
          departmentId,
          detail: pattern.detail,
        });
        const origin = {
          pattern: { assignmentId, occursOn: occursOn!, slot: slotIndex, override: false },
        };
        const common = {
          actor,
          board,
          booking,
          reason,
          requestHash: generatedHash,
          employmentId: assignment.employmentId,
          requiredQualificationTypeIds: want.qualificationTypeIds,
          origin,
        };
        if (!head) {
          // Occurrences already under way are history, not new bookings.
          if (want.startsAt <= clock.now) return;
          await insertEntry({
            ...common,
            id: crypto.randomUUID(),
            status: "draft",
            supersedesId: null,
          });
          summary.created++;
          return;
        }
        if (head.status === "draft") {
          // A generated draft is replaced by a draft of the current definition.
          await setStatus(actor, head, "cancelled", reason);
          await insertEntry({
            ...common,
            id: crypto.randomUUID(),
            status: "draft",
            supersedesId: head.supersedesId,
          });
        } else {
          await insertEntry({
            ...common,
            id: crypto.randomUUID(),
            status: "draft",
            supersedesId: head.id,
          });
        }
        summary.revised++;
      });
    } catch (error) {
      const refusal = scheduleDatabaseRefusal(error);
      if (!(refusal instanceof ScheduleError)) throw refusal;
      summary.failures.push({
        occursOn: occursOn!,
        slotIndex,
        message: refusal.message,
        remedy: refusal.remedy ?? null,
      });
    }
  }
  if (board.publishPolicy === "live") {
    const drafts = await db.execute<{ id: string; starts_on: string; ends_on: string }>(
      sql`select d.id,d.starts_on::text,d.ends_on::text from schedule_entries d
      left join schedule_entries prior on prior.org_id=d.org_id and prior.id=d.supersedes_id
      where d.org_id=${actor.orgId} and d.board_id=${board.id} and d.status='draft'
        and coalesce(d.pattern_assignment_id,prior.pattern_assignment_id)=${assignmentId} order by d.starts_on,d.id for update of d`,
      "objects",
    );
    if (drafts.length) {
      const { publishScheduleBoard } = await import("./publications.ts");
      const dates = drafts.flatMap((draft) => [draft.starts_on, draft.ends_on]).sort();
      const published = await publishScheduleBoard({
        ...actor,
        boardId: board.id,
        from: dates[0]!,
        through: dates.at(-1)!,
        entryIds: drafts.map((draft) => draft.id),
        reason,
      });
      const { deliverScheduleNotice } = await import("./distribution-hooks.ts");
      if (published.notices.length)
        await deliverScheduleNotice({
          orgId: actor.orgId,
          actorId: actor.actorId,
          boardName: board.name,
          notices: published.notices,
        });
    }
  }
  const generatedThrough =
    lastWanted !== null && lastWanted >= from
      ? [assignment.generatedThrough ?? lastWanted, lastWanted].sort().at(-1)!
      : assignment.generatedThrough;
  const updated = await db.execute(
    sql`update schedule_pattern_assignments set generated_through = ${generatedThrough}, last_generation = ${JSON.stringify(
      {
        at: new Date().toISOString(),
        from: summary.from,
        through: summary.through,
        created: summary.created,
        revised: summary.revised,
        removed: summary.removed,
        kept: summary.kept,
        unchanged: summary.unchanged,
        problems: summary.problems.map(({ startChoices, endChoices, ...problem }) => ({
          ...problem,
          startChoices,
          endChoices,
        })),
        failures: summary.failures,
      },
    )}::jsonb,
    reason = ${reason}, revision = revision + 1, updated_at = now(), updated_by = ${actor.actorId}
    where org_id = ${actor.orgId} and id = ${assignmentId} returning id`,
    "objects",
  );
  if (updated.length !== 1)
    throw new ScheduleError("The assignment changed during generation.", {
      status: 409,
      code: "schedule_stale",
      remedy: "Reload the board and generate again.",
    });
  return summary;
}

/** Generation removes its own occurrences without recording an omission. */
async function removePublishedForPattern(
  actor: ScheduleActor,
  board: ScheduleBoard,
  row: StoredEntry,
  reason: string,
): Promise<void> {
  await removePublished(actor, board, row, reason);
}

/**
 * Keep every active assignment generated through its pattern's horizon.
 * Runs once per organization from the daily worker duty. Each assignment
 * runs under the authority of the person who last configured it and in its
 * own savepoint, so one refusal never stops the others.
 */
export async function maintainPatternAssignments(
  orgId: string,
): Promise<{ assignments: number; failures: number }> {
  return withOrgTransaction(orgId, async () => {
    if (
      !(await lockAndCheckOrgFeature(db, orgId, "hrm")) ||
      !(await lockAndCheckOrgFeature(db, orgId, "hrmShiftPlanning"))
    )
      return { assignments: 0, failures: 0 };
    const due = await db.execute<{ id: string; boardId: string; actorId: string }>(
      sql`select a.id, a.board_id as "boardId", a.updated_by as "actorId"
      from schedule_pattern_assignments a join schedule_patterns p on p.org_id = a.org_id and p.id = a.pattern_id
      join schedule_boards b on b.org_id = a.org_id and b.id = a.board_id
      join users u on u.org_id = a.org_id and u.id = a.updated_by and u.is_active
      where a.org_id = ${orgId} and a.status = 'active' and b.is_active and p.is_active
        and (a.effective_to is null or a.effective_to > (now() at time zone b.time_zone)::date)
        and (a.generated_through is null or a.generated_through < (now() at time zone b.time_zone)::date + (p.horizon_days - 1))
      order by a.id`,
      "objects",
    );
    let failures = 0;
    for (const item of due) {
      try {
        await withTransactionSavepoint(db, async () => {
          const actor = { orgId, actorId: item.actorId };
          const board = await getBoard(actor, item.boardId);
          const allowed = await boardAuthority(actor, board, "manage");
          const summary = await generate(actor, board, allowed, item.id, {
            through: null,
            reason: "Recurring pattern extended through its horizon",
          });
          if (summary.failures.length || summary.problems.length) failures++;
        });
      } catch (error) {
        const refusal = scheduleDatabaseRefusal(error);
        if (!(refusal instanceof ScheduleError) && !(refusal instanceof ScopeNotFoundError))
          throw refusal;
        failures++;
      }
    }
    return { assignments: due.length, failures };
  });
}
