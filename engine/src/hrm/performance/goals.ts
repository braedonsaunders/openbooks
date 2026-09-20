import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { loadApprovalPerson, loadManagedEmploymentIds, requireHrmPerformanceOnEmployment } from "../authorization.ts";
import { businessToday } from "../../platform/business-date.ts";
import { HRM_FEATURE_KEY } from "../employment-read.ts";
import { HrmPerformanceError, mathRefusal } from "./errors.ts";
import { assertProgressPercent, parseCivilDay } from "./performance-math.ts";

/**
 * Governed HRM goals (0196, HR-7): create, progress, achieve, miss, cancel.
 * Every progress write appends its goal update in the SAME transaction as
 * the goal write, so a partial effect cannot exist; every conditional write
 * asserts its affected row count.
 *
 * Authority is the subject or HR: the actor's person identity comes from
 * users.party_id on the transaction runner, and an employment is the
 * actor's own when its worker matches. HR (hrm.performance.manage with the
 * employment's employer scope) acts on any employment. Achieving sets
 * progress to 100 with its evidence row; missing or cancelling needs a
 * note, recorded as the terminal update.
 *
 * Do not touch packages/payroll. Existing refusal classes are untouched.
 */

export type GoalStatus = "active" | "achieved" | "missed" | "cancelled";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireId(field: string, value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HrmPerformanceError("INVALID_INPUT", `${field} must be a uuid`);
  }
  return value;
}

async function assertPerformanceFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrm feature is disabled: enable it on Company Settings → Features before setting goals",
    );
  }
}

export interface GoalDTO {
  readonly id: string;
  readonly employmentId: string;
  readonly title: string;
  readonly description: string | null;
  readonly dueOn: string | null;
  readonly weight: string | null;
  readonly status: GoalStatus;
  readonly progressPercent: number;
  readonly cycleId: string | null;
}

type StoredGoal = {
  id: string;
  employmentId: string;
  title: string;
  description: string | null;
  dueOn: string | null;
  weight: string | null;
  status: string;
  progressPercent: number;
  cycleId: string | null;
  workerPartyId: string;
};

function toGoalDTO(row: StoredGoal): GoalDTO {
  if (!["active", "achieved", "missed", "cancelled"].includes(row.status)) {
    throw new HrmPerformanceError("BAD_STATE", `goal ${row.id} carries an unknown status`);
  }
  return {
    id: row.id,
    employmentId: row.employmentId,
    title: row.title,
    description: row.description,
    dueOn: row.dueOn,
    weight: row.weight,
    status: row.status as GoalStatus,
    progressPercent: row.progressPercent,
    cycleId: row.cycleId,
  };
}

async function loadGoal(exec: SqlExecutor, orgId: string, goalId: string): Promise<StoredGoal> {
  const row = (await exec.execute<StoredGoal>(sql`
    select g.id,
           g.employment_id as "employmentId",
           g.title, g.description,
           g.due_on::text as "dueOn",
           g.weight::text as weight,
           g.status,
           g.progress_percent as "progressPercent",
           g.cycle_id as "cycleId",
           e.worker_party_id as "workerPartyId"
      from hrm_goals g
      join worker_employments e
        on e.org_id = g.org_id and e.id = g.employment_id
     where g.org_id = ${orgId} and g.id = ${goalId}
  `)).rows[0];
  if (!row) {
    throw new HrmPerformanceError(
      "NOT_FOUND",
      `goal ${goalId} is not visible in this organization — check the id or the organization`,
    );
  }
  return row;
}

/**
 * The actor may act on the employment when they are its worker (subject)
 * or hold hrm.performance.manage over its employer. Returns the trusted
 * subject for the service to reuse in-transaction.
 */
async function requireGoalAuthority(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<{ workerPartyId: string }> {
  const person = await loadApprovalPerson(exec, orgId, actorId);
  const subject = (await exec.execute<{ workerPartyId: string }>(sql`
    select worker_party_id as "workerPartyId" from worker_employments
     where org_id = ${orgId} and id = ${employmentId}
  `)).rows[0];
  if (!subject) {
    throw new HrmPerformanceError(
      "NOT_FOUND",
      `employment ${employmentId} is not visible in this organization — check the id or the organization`,
    );
  }
  if (person.partyId !== null && person.partyId === subject.workerPartyId) return subject;
  await requireHrmPerformanceOnEmployment(exec, orgId, actorId, employmentId, "hrm.performance.manage");
  return subject;
}

/** A goal on an employment: the subject sets their own, HR sets any in scope. */
export async function createGoal(args: {
  orgId: string;
  actorId: string;
  employmentId: string;
  title: string;
  description?: string | null;
  dueOn?: string | null;
  weight?: string | number | null;
  cycleId?: string | null;
}): Promise<GoalDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const employmentId = requireId("employmentId", args.employmentId);
  if (typeof args.title !== "string" || args.title.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "title must be a non-blank string");
  }
  const dueOn = args.dueOn == null ? null : mathRefusal("INVALID_INPUT", () => parseCivilDay(args.dueOn as string, "due date"));
  const weight = args.weight == null || String(args.weight).trim().length === 0 ? null : String(args.weight).trim();
  if (weight !== null && !/^\d+(\.\d+)?$/.test(weight)) {
    throw new HrmPerformanceError(
      "INVALID_INPUT",
      `weight must be a non-negative decimal, got ${JSON.stringify(args.weight)}`,
    );
  }
  const cycleId = args.cycleId == null ? null : requireId("cycleId", args.cycleId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    await requireGoalAuthority(db, orgId, actorId, employmentId);
    if (cycleId !== null) {
      const cycle = (await db.execute<{ id: string }>(sql`
        select id from hrm_review_cycles where org_id = ${orgId} and id = ${cycleId}
      `)).rows[0];
      if (!cycle) {
        throw new HrmPerformanceError(
          "NOT_FOUND",
          `review cycle ${cycleId} is not visible in this organization — set the goal without a cycle, or check the id`,
        );
      }
    }
    const row = (await db.execute<StoredGoal>(sql`
      insert into hrm_goals
        (org_id, employment_id, title, description, due_on, weight, status,
         progress_percent, cycle_id, created_by, updated_by)
      values (${orgId}, ${employmentId}, ${args.title.trim()}, ${args.description ?? null},
        ${dueOn}::date, ${weight}::numeric, 'active', 0, ${cycleId}, ${actorId}, ${actorId})
      returning id,
        employment_id as "employmentId", title, description,
        due_on::text as "dueOn", weight::text as weight, status,
        progress_percent as "progressPercent", cycle_id as "cycleId",
        (select worker_party_id from worker_employments
          where org_id = ${orgId} and id = ${employmentId}) as "workerPartyId"
    `)).rows[0]!;
    await db.execute(sql`
      insert into hrm_goal_updates (org_id, goal_id, progress_percent, note, actor_user_id)
      values (${orgId}, ${row.id}, 0, 'goal set', ${actorId})
    `);
    return toGoalDTO(row);
  });
}

/**
 * Record progress: appends the update and moves the goal in one
 * transaction. Only an active goal takes progress — an achieved, missed or
 * cancelled goal is history; set a new goal instead.
 */
export async function updateGoalProgress(args: {
  orgId: string;
  actorId: string;
  goalId: string;
  progressPercent: number;
  note?: string | null;
}): Promise<GoalDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const goalId = requireId("goalId", args.goalId);
  const progress = mathRefusal("INVALID_INPUT", () => assertProgressPercent(args.progressPercent));
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const goal = await loadGoal(db, orgId, goalId);
    await requireGoalAuthority(db, orgId, actorId, goal.employmentId);
    if (goal.status !== "active") {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `goal ${goalId} is ${goal.status} — only an active goal takes progress; set a new goal instead`,
      );
    }
    const moved = (await db.execute(sql`
      update hrm_goals
         set progress_percent = ${progress}, updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${goalId} and status = 'active'
    `)).rowCount ?? 0;
    if (moved !== 1) {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `goal ${goalId} moved while recording progress — re-read it and retry`,
      );
    }
    await db.execute(sql`
      insert into hrm_goal_updates (org_id, goal_id, progress_percent, note, actor_user_id)
      values (${orgId}, ${goalId}, ${progress}, ${args.note ?? null}, ${actorId})
    `);
    return toGoalDTO(await loadGoal(db, orgId, goalId));
  });
}

/**
 * Achieve a goal: progress to 100 with its evidence row, status achieved.
 * Missing or cancelling needs a note, recorded as the terminal update.
 */
export async function setGoalStatus(args: {
  orgId: string;
  actorId: string;
  goalId: string;
  status: "achieved" | "missed" | "cancelled";
  note?: string | null;
}): Promise<GoalDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const goalId = requireId("goalId", args.goalId);
  if (args.status !== "achieved" && args.status !== "missed" && args.status !== "cancelled") {
    throw new HrmPerformanceError(
      "INVALID_INPUT",
      `goal status must be achieved, missed, or cancelled, got ${JSON.stringify(args.status)}`,
    );
  }
  const note = args.note ?? null;
  if (args.status !== "achieved" && (note === null || note.trim().length === 0)) {
    throw new HrmPerformanceError(
      "REFUSED",
      `goal ${goalId} cannot be ${args.status} without a note — the note is the terminal evidence`,
    );
  }
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const goal = await loadGoal(db, orgId, goalId);
    await requireGoalAuthority(db, orgId, actorId, goal.employmentId);
    if (goal.status !== "active") {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `goal ${goalId} is ${goal.status} — only an active goal ${args.status === "achieved" ? "achieves" : args.status === "missed" ? "misses" : "cancels"}`,
      );
    }
    // Achieving completes the progress; missing and cancelling keep it.
    const progress = args.status === "achieved" ? 100 : goal.progressPercent;
    const moved = (await db.execute(sql`
      update hrm_goals
         set status = ${args.status}, progress_percent = ${progress},
             updated_at = now(), updated_by = ${actorId}
       where org_id = ${orgId} and id = ${goalId} and status = 'active'
    `)).rowCount ?? 0;
    if (moved !== 1) {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `goal ${goalId} moved while updating — re-read it and retry`,
      );
    }
    await db.execute(sql`
      insert into hrm_goal_updates (org_id, goal_id, progress_percent, note, actor_user_id)
      values (${orgId}, ${goalId}, ${progress},
        ${args.status === "achieved" ? "goal achieved" : note}, ${actorId})
    `);
    return toGoalDTO(await loadGoal(db, orgId, goalId));
  });
}

/**
 * Goal read scope: the subject, the manager of the employment as of
 * today, or HR with hrm.performance.manage over its employer. Nobody else
 * reads a goal — the privacy half of the goal surface.
 */
export async function requireGoalReadAuthority(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<void> {
  const person = await loadApprovalPerson(exec, orgId, actorId);
  const subject = (await exec.execute<{ workerPartyId: string }>(sql`
    select worker_party_id as "workerPartyId" from worker_employments
     where org_id = ${orgId} and id = ${employmentId}
  `)).rows[0];
  if (!subject) {
    throw new HrmPerformanceError(
      "NOT_FOUND",
      `employment ${employmentId} is not visible in this organization — check the id or the organization`,
    );
  }
  if (person.partyId !== null && person.partyId === subject.workerPartyId) return;
  const managed = await loadManagedEmploymentIds(exec, orgId, actorId, await businessToday(orgId));
  if (managed.includes(employmentId)) return;
  await requireHrmPerformanceOnEmployment(exec, orgId, actorId, employmentId, "hrm.performance.manage");
}

/** Progress evidence for one goal, newest last: the subject, their
 * manager as of today, or HR reads — the same scope as the goal list. */
export async function listGoalUpdates(args: {
  orgId: string;
  actorId: string;
  goalId: string;
}): Promise<{ progressPercent: number; note: string | null; recordedAt: string }[]> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const goalId = requireId("goalId", args.goalId);
  return withOrgTransaction(orgId, async () => {
    await assertPerformanceFeature(db, orgId);
    const goal = await loadGoal(db, orgId, goalId);
    await requireGoalReadAuthority(db, orgId, actorId, goal.employmentId);
    const rows = (await db.execute<{ progressPercent: number; note: string | null; recordedAt: string }>(sql`
      select progress_percent as "progressPercent", note,
             recorded_at as "recordedAt"
        from hrm_goal_updates
       where org_id = ${orgId} and goal_id = ${goalId}
       order by recorded_at
    `)).rows;
    return rows;
  });
}
