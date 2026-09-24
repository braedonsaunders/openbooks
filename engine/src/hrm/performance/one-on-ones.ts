import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { businessToday } from "../../platform/business-date.ts";
import {
  HrmAuthorizationError,
  loadApprovalPerson,
  loadManagedEmploymentIds,
  loadOwnEmploymentIds,
  lockEmploymentsForScope,
  requireAggregatePerformanceManage,
  requireAggregatePerformanceRead,
} from "../authorization.ts";
import { HRM_FEATURE_KEY } from "../employment-read.ts";
import { employerSubsidiaryScope } from "./subsidiary-scope.ts";
import { HrmPerformanceError, isUniqueViolationOn } from "./errors.ts";

/**
 * Governed HRM 1:1s (0228, HR-17): schedule, hold, skip, cancel, agenda
 * items, carry-forward, and the held-items evidence reader the review
 * drafting uses.
 *
 * Every conditional write asserts its affected row count: under RLS an
 * unscoped UPDATE silently matches nothing, and a write that matches zero
 * rows is a failure, not a success. Recurrence is a rule
 * ({every_weeks, weekday, time}), never pre-generated rows: holding or
 * skipping a recurring 1:1 generates exactly one next occurrence.
 * Carry-forward COPIES open items to the next occurrence with
 * carried_from_item_id and marks the original carried — never moved.
 *
 * Authority is structural, never caller-declared: HR
 * (hrm.performance.read/manage) sees pairs whose report sits inside
 * their allowed subsidiaries (unrestricted HR sees everything);
 * otherwise the actor's party must be the manager or the report
 * employment's worker party, or the actor must manage the report
 * through the live line relationship (with hrm.self.read). Private
 * items are readable only by their author — enforced in every read
 * below, never in the UI alone.
 *
 * A 1:1 belongs to the report's employer subsidiary: the report is the
 * review subject the pair serves, so HR scope is always checked against
 * the report employment. The manager may sit in any subsidiary —
 * cross-subsidiary management happens, and fencing the manager side
 * would hide a report's own pair from the HR covering them.
 *
 * Do not touch packages/payroll. Existing refusal classes are untouched.
 */

export const HRM_PERFORMANCE_CONTINUOUS_KEY = "hrmPerformance" as const;
export const HRM_ONE_ON_ONES_KEY = "hrmOneOnOnes" as const;

export type OneOnOneStatus = "scheduled" | "held" | "skipped" | "cancelled";
export type OneOnOneItemKind = "talking_point" | "action_item" | "note";
export type OneOnOneItemVisibility = "shared" | "private";
export type OneOnOneItemStatus = "open" | "done" | "carried";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireId(field: string, value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HrmPerformanceError("INVALID_INPUT", `${field} must be a uuid`);
  }
  return value;
}

async function assertContinuousFeature(db: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, HRM_FEATURE_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrm feature is disabled: enable it on Company Settings → Features before scheduling 1:1s",
    );
  }
  if (!(await lockAndCheckOrgFeature(db, orgId, HRM_PERFORMANCE_CONTINUOUS_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrmPerformance feature is disabled: enable it on Company Settings → Features before scheduling 1:1s",
    );
  }
}

export async function assertOneOnOnesFeature(db: SqlExecutor, orgId: string): Promise<void> {
  await assertContinuousFeature(db, orgId);
  if (!(await lockAndCheckOrgFeature(db, orgId, HRM_ONE_ON_ONES_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrmOneOnOnes feature is disabled: enable it on Company Settings → Features before scheduling 1:1s",
    );
  }
}

/**
 * The actor's HR scope: the allowed employer set (null = unrestricted),
 * or undefined when the actor holds no HR grant at all. The grant alone
 * is never the whole answer — every HR path below applies the returned
 * Set to the report employment.
 */
async function performanceReadScope(
  db: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<Set<string> | null | undefined> {
  try {
    return await requireAggregatePerformanceRead(db, orgId, actorId);
  } catch {
    return undefined;
  }
}

async function performanceManageScope(
  db: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<Set<string> | null | undefined> {
  try {
    return await requireAggregatePerformanceManage(db, orgId, actorId);
  } catch {
    return undefined;
  }
}

/** The report employment's employer subsidiary (the 1:1's owning scope), if it exists. */
async function reportEmployer(db: SqlExecutor, orgId: string, reportEmploymentId: string): Promise<string | null> {
  const rows = (await db.execute<{ employerSubsidiaryId: string | null }>(sql`
    select employer_subsidiary_id as "employerSubsidiaryId" from worker_employments
     where org_id = ${orgId} and id = ${reportEmploymentId}
  `)).rows;
  return rows[0]?.employerSubsidiaryId ?? null;
}

function reportNotVisible(): HrmPerformanceError {
  return new HrmPerformanceError("NOT_FOUND", "1:1 was not found — it may belong to another organization");
}

/** Read only the report id, then lock and scope-check it before loading a 1:1's joined data. */
async function lockOneOnOneReport(
  db: SqlExecutor,
  orgId: string,
  actorId: string,
  oneOnOneId: string,
): Promise<void> {
  const reportEmploymentId = (await db.execute<{ report_employment_id: string }>(sql`
    select report_employment_id from hrm_one_on_ones where org_id = ${orgId} and id = ${oneOnOneId}
  `)).rows[0]?.report_employment_id;
  if (!reportEmploymentId) throw reportNotVisible();
  try {
    await lockEmploymentsForScope(db, [reportEmploymentId], { orgId, actorId });
  } catch (error) {
    if (error instanceof HrmAuthorizationError) throw reportNotVisible();
    throw error;
  }
}

type StoredOneOnOne = {
  id: string;
  manager_employment_id: string;
  report_employment_id: string;
  report_employer_subsidiary_id: string | null;
  manager_party_id: string | null;
  report_party_id: string | null;
  manager_name: string;
  report_name: string;
  scheduled_at: string;
  held_at: string | null;
  status: OneOnOneStatus;
  skip_reason: string | null;
  recurrence: { every_weeks: number; weekday: number; time?: string } | null;
  series_id: string | null;
};

async function loadOneOnOne(db: SqlExecutor, orgId: string, id: string): Promise<StoredOneOnOne | null> {
  const rows = (await db.execute<StoredOneOnOne & { recurrence: unknown }>(sql`
    select o.id, o.manager_employment_id, o.report_employment_id,
           r.employer_subsidiary_id as report_employer_subsidiary_id,
           m.worker_party_id as manager_party_id, r.worker_party_id as report_party_id,
           coalesce(mp.display_name, '—') as manager_name, coalesce(rp.display_name, '—') as report_name,
           o.scheduled_at::text as scheduled_at, o.held_at::text as held_at,
           o.status, o.skip_reason, o.recurrence, o.series_id::text as series_id
      from hrm_one_on_ones o
      join worker_employments m on m.org_id = o.org_id and m.id = o.manager_employment_id
      join worker_employments r on r.org_id = o.org_id and r.id = o.report_employment_id
      left join parties mp on mp.org_id = o.org_id and mp.id = m.worker_party_id
      left join parties rp on rp.org_id = o.org_id and rp.id = r.worker_party_id
     where o.org_id = ${orgId} and o.id = ${id}
  `)).rows;
  const row = rows[0];
  if (!row) return null;
  return { ...row, recurrence: (row.recurrence ?? null) as StoredOneOnOne["recurrence"] };
}

/**
 * Structural 1:1 authority: HR reads pairs whose report sits inside
 * their allowed subsidiaries (unrestricted HR reads everything);
 * otherwise the actor's party must be the manager or the report, or
 * the actor must manage the report through the live line relationship
 * (with hrm.self.read). Returns true when the actor may see shared
 * content.
 */
async function canSeeOneOnOne(
  db: SqlExecutor,
  orgId: string,
  actorId: string,
  one: StoredOneOnOne,
): Promise<boolean> {
  const scope = await performanceReadScope(db, orgId, actorId);
  if (scope !== undefined) {
    return (
      scope === null ||
      (one.report_employer_subsidiary_id !== null && scope.has(one.report_employer_subsidiary_id))
    );
  }
  const person = await loadApprovalPerson(db, orgId, actorId);
  if (!person.partyId) return false;
  if (person.partyId === one.manager_party_id || person.partyId === one.report_party_id) return true;
  if (!(await actorHasPermission(db, orgId, actorId, "hrm.self.read"))) return false;
  const today = await businessToday(orgId);
  const own = await loadOwnEmploymentIds(db, orgId, actorId);
  if (!own.includes(one.manager_employment_id)) return false;
  const team = await loadManagedEmploymentIds(db, orgId, actorId, today);
  return team.includes(one.report_employment_id);
}

async function requireWriteAuthority(
  db: SqlExecutor,
  orgId: string,
  actorId: string,
  one: StoredOneOnOne,
): Promise<void> {
  const manageScope = await performanceManageScope(db, orgId, actorId);
  if (manageScope !== undefined) {
    // HR manage writes only pairs whose report sits inside their allowed
    // subsidiaries — a restricted manage role cannot hold, skip, cancel,
    // or add items on another subsidiary's pairs.
    if (
      manageScope === null ||
      (one.report_employer_subsidiary_id !== null && manageScope.has(one.report_employer_subsidiary_id))
    ) {
      return;
    }
    throw new HrmPerformanceError(
      "FORBIDDEN",
      "this 1:1 belongs to a report outside your allowed subsidiaries — only the pair, their HR administrator, or the report's line manager may change it",
    );
  }
  if (await canSeeOneOnOne(db, orgId, actorId, one)) return;
  throw new HrmPerformanceError(
    "FORBIDDEN",
    "this 1:1 belongs to another manager and report — only the pair, their HR administrator, or the report's line manager may change it",
  );
}

export interface OneOnOneItemDTO {
  readonly id: string;
  readonly kind: OneOnOneItemKind;
  readonly authorPartyId: string;
  readonly body: string;
  readonly visibility: OneOnOneItemVisibility;
  readonly status: OneOnOneItemStatus;
  readonly assigneePartyId: string | null;
  readonly dueOn: string | null;
  readonly position: number;
  readonly carriedFromItemId: string | null;
}

export interface OneOnOneDTO {
  readonly id: string;
  readonly managerEmploymentId: string;
  readonly reportEmploymentId: string;
  readonly managerName: string;
  readonly reportName: string;
  readonly scheduledAt: string;
  readonly heldAt: string | null;
  readonly status: OneOnOneStatus;
  readonly skipReason: string | null;
  readonly recurrence: StoredOneOnOne["recurrence"];
  readonly seriesId: string | null;
  readonly items: readonly OneOnOneItemDTO[];
}

type StoredItem = {
  id: string;
  kind: OneOnOneItemKind;
  author_party_id: string;
  body: string;
  visibility: OneOnOneItemVisibility;
  status: OneOnOneItemStatus;
  assignee_party_id: string | null;
  due_on: string | null;
  position: number;
  carried_from_item_id: string | null;
};

async function loadItems(
  db: SqlExecutor,
  orgId: string,
  oneOnOneId: string,
  authorPartyId: string | null,
): Promise<OneOnOneItemDTO[]> {
  const rows = (await db.execute<StoredItem>(sql`
    select id, kind, author_party_id, body, visibility, status,
           assignee_party_id, due_on::text as due_on, position,
           carried_from_item_id::text as carried_from_item_id
      from hrm_one_on_one_items
     where org_id = ${orgId} and one_on_one_id = ${oneOnOneId}
     order by position, created_at
  `)).rows;
  return rows
    .filter((row) => {
      // Private items are readable only by their author — enforced at
      // read, never in the UI alone. HR sees shared content but never
      // another person's private notes either: private means author only.
      if (row.visibility === "private" && row.author_party_id !== authorPartyId) return false;
      return true;
    })
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      authorPartyId: row.author_party_id,
      body: row.body,
      visibility: row.visibility,
      status: row.status,
      assigneePartyId: row.assignee_party_id,
      dueOn: row.due_on,
      position: row.position,
      carriedFromItemId: row.carried_from_item_id,
    }));
}

function toDTO(one: StoredOneOnOne, items: readonly OneOnOneItemDTO[]): OneOnOneDTO {
  return {
    id: one.id,
    managerEmploymentId: one.manager_employment_id,
    reportEmploymentId: one.report_employment_id,
    managerName: one.manager_name,
    reportName: one.report_name,
    scheduledAt: one.scheduled_at,
    heldAt: one.held_at,
    status: one.status,
    skipReason: one.skip_reason,
    recurrence: one.recurrence,
    seriesId: one.series_id,
    items,
  };
}

async function employmentParty(db: SqlExecutor, orgId: string, employmentId: string): Promise<string | null> {
  const rows = (await db.execute<{ worker_party_id: string | null }>(sql`
    select worker_party_id from worker_employments where org_id = ${orgId} and id = ${employmentId}
  `)).rows;
  return rows[0]?.worker_party_id ?? null;
}

export async function scheduleOneOnOne(args: {
  orgId: string;
  actorId: string;
  managerEmploymentId: string;
  reportEmploymentId: string;
  scheduledAt: string;
  recurrence?: { every_weeks: number; weekday: number; time?: string } | null;
}): Promise<OneOnOneDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const managerEmploymentId = requireId("managerEmploymentId", args.managerEmploymentId);
  const reportEmploymentId = requireId("reportEmploymentId", args.reportEmploymentId);
  if (managerEmploymentId === reportEmploymentId) {
    throw new HrmPerformanceError("INVALID_INPUT", "a 1:1 needs two different employments — manager and report cannot be the same person");
  }
  return withOrgTransaction(orgId, async () => {
    await assertOneOnOnesFeature(db, orgId);
    try {
      await lockEmploymentsForScope(db, [reportEmploymentId], { orgId, actorId });
    } catch (error) {
      if (error instanceof HrmAuthorizationError) throw reportNotVisible();
      throw error;
    }
    const managerParty = await employmentParty(db, orgId, managerEmploymentId);
    const reportParty = await employmentParty(db, orgId, reportEmploymentId);
    if (!managerParty || !reportParty) {
      throw new HrmPerformanceError(
        "NOT_FOUND",
        "manager or report employment was not found in this organization — pick employments from the directory",
      );
    }
    // Either party may propose; a third party must manage the report
    // through the live line relationship (with hrm.self.read); HR
    // schedules only pairs whose report sits inside their allowed
    // subsidiaries.
    const manageScope = await performanceManageScope(db, orgId, actorId);
    if (manageScope === undefined) {
      const person = await loadApprovalPerson(db, orgId, actorId);
      const isParty = person.partyId === managerParty || person.partyId === reportParty;
      if (!isParty) {
        if (!(await actorHasPermission(db, orgId, actorId, "hrm.self.read"))) {
          throw new HrmPerformanceError(
            "FORBIDDEN",
            "only the manager, the report, the report's line manager, or HR may schedule this 1:1 — ask an administrator to grant hrm.self.read in /admin/roles",
          );
        }
        const today = await businessToday(orgId);
        const own = await loadOwnEmploymentIds(db, orgId, actorId);
        if (!own.includes(managerEmploymentId)) {
          throw new HrmPerformanceError(
            "FORBIDDEN",
            "only the manager, the report, the report's line manager, or HR may schedule this 1:1",
          );
        }
        const team = await loadManagedEmploymentIds(db, orgId, actorId, today);
        if (!team.includes(reportEmploymentId)) {
          throw new HrmPerformanceError(
            "FORBIDDEN",
            "this employment does not report to you in the live line relationship — only the report's line manager may schedule for them",
          );
        }
      }
    } else if (manageScope !== null) {
      const employer = await reportEmployer(db, orgId, reportEmploymentId);
      if (employer === null || !manageScope.has(employer)) {
        throw new HrmPerformanceError(
          "FORBIDDEN",
          "this report sits outside your allowed subsidiaries — only the pair, their HR administrator, or the report's line manager may schedule this 1:1",
        );
      }
    }
    try {
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into hrm_one_on_ones (org_id, manager_employment_id, report_employment_id, scheduled_at, recurrence, created_by, updated_by)
        values (${orgId}, ${managerEmploymentId}, ${reportEmploymentId}, ${args.scheduledAt}::timestamptz,
                ${args.recurrence ? JSON.stringify(args.recurrence) : null}::jsonb, ${actorId}, ${actorId})
        returning id
      `)).rows[0];
      if (!inserted) throw new HrmPerformanceError("REFUSED", "the 1:1 was not stored — no row was written; retry the action");
      const one = await loadOneOnOne(db, orgId, inserted.id);
      if (!one) throw new HrmPerformanceError("REFUSED", "the 1:1 was not stored — no row can be read back; retry the action");
      const person = await loadApprovalPerson(db, orgId, actorId);
      return toDTO(one, await loadItems(db, orgId, one.id, person.partyId));
    } catch (e) {
      if (isUniqueViolationOn(e, "hrm_one_on_ones_unique_slot")) {
        throw new HrmPerformanceError(
          "DUPLICATE",
          "this pair already has a 1:1 at that time — open the existing one instead of scheduling a second",
        );
      }
      throw e;
    }
  });
}

async function nextOccurrenceAt(
  scheduledAt: string,
  recurrence: { every_weeks: number; weekday: number; time?: string },
): Promise<string> {
  const base = new Date(scheduledAt);
  if (Number.isNaN(base.getTime())) {
    throw new HrmPerformanceError("INVALID_INPUT", "scheduled_at is not a readable timestamp");
  }
  return new Date(base.getTime() + recurrence.every_weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
}

export async function holdOneOnOne(args: { orgId: string; actorId: string; id: string }): Promise<OneOnOneDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const id = requireId("id", args.id);
  return withOrgTransaction(orgId, async () => {
    await assertOneOnOnesFeature(db, orgId);
    await lockOneOnOneReport(db, orgId, actorId, id);
    const one = await loadOneOnOne(db, orgId, id);
    if (!one) throw reportNotVisible();
    await requireWriteAuthority(db, orgId, actorId, one);
    if (one.status !== "scheduled") {
      throw new HrmPerformanceError(
        "BAD_STATE",
        `only a scheduled 1:1 can be held — this one is ${one.status}; reopen it by scheduling a new occurrence`,
      );
    }
    const updated = (await db.execute<{ id: string }>(sql`
      update hrm_one_on_ones set status = 'held', held_at = now(), updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${id} and status = 'scheduled'
      returning id
    `)).rows;
    // A write that matches zero rows is a failure, not a success.
    if (updated.length !== 1) {
      throw new HrmPerformanceError("STALE_REVISION", "the 1:1 changed under you — reload it and try again");
    }
    // Carry open items forward: COPIED to the next occurrence, the
    // original marked carried — never moved, so history stays put. The
    // next occurrence exists only under a recurrence rule; without one
    // the items stay open on the held record as its history.
    const person = await loadApprovalPerson(db, orgId, actorId);
    if (one.recurrence) {
      const nextAt = await nextOccurrenceAt(one.scheduled_at, one.recurrence);
      const seriesId = one.series_id ?? one.id;
      const next = (await db.execute<{ id: string }>(sql`
        insert into hrm_one_on_ones (org_id, manager_employment_id, report_employment_id, scheduled_at, recurrence, series_id, created_by, updated_by)
        values (${orgId}, ${one.manager_employment_id}, ${one.report_employment_id}, ${nextAt}::timestamptz,
                ${JSON.stringify(one.recurrence)}::jsonb, ${seriesId}, ${actorId}, ${actorId})
        -- Conflict is expected and benign: the STALE_REVISION CAS below the
        -- load serializes same-record completions, so the only way this row
        -- already exists is a prior completion of THIS record creating the
        -- next occurrence — in which case its open items were already
        -- carried and skipping them again is correct.
        on conflict do nothing
        returning id
      `)).rows[0];
      if (next) {
        const open = (await db.execute<StoredItem>(sql`
          select id, kind, author_party_id, body, visibility, status, assignee_party_id,
                 due_on::text as due_on, position, carried_from_item_id::text as carried_from_item_id
            from hrm_one_on_one_items
           where org_id = ${orgId} and one_on_one_id = ${id} and status = 'open'
        `)).rows;
        for (const item of open) {
          // Carry-forward copies, never moves: the just-written next id
          // is the only fresh row, so a conflict here is unexpected and
          // must surface rather than absorb.
          const copied = (await db.execute<{ id: string }>(sql`
            insert into hrm_one_on_one_items (org_id, one_on_one_id, kind, author_party_id, body, visibility, status, carried_from_item_id, assignee_party_id, due_on, position, created_by, updated_by)
            values (${orgId}, ${next.id}, ${item.kind}, ${item.author_party_id}, ${item.body}, ${item.visibility},
                    'open', ${item.id}, ${item.assignee_party_id}, ${item.due_on}::date, ${item.position}, ${actorId}, ${actorId})
            returning id
          `)).rows[0];
          if (!copied) {
            throw new HrmPerformanceError("REFUSED", "an agenda item could not be carried forward — no row was written; retry the action");
          }
          const marked = (await db.execute<{ id: string }>(sql`
            update hrm_one_on_one_items set status = 'carried', updated_by = ${actorId}, updated_at = now()
             where org_id = ${orgId} and id = ${item.id} and status = 'open'
            returning id
          `)).rows;
          if (marked.length !== 1) {
            throw new HrmPerformanceError("STALE_REVISION", "an agenda item changed under you — reload the 1:1 and try again");
          }
        }
      }
    }
    const held = await loadOneOnOne(db, orgId, id);
    if (!held) throw new HrmPerformanceError("NOT_FOUND", "1:1 was not found — it may belong to another organization");
    return toDTO(held, await loadItems(db, orgId, id, person.partyId));
  });
}

export async function skipOneOnOne(args: {
  orgId: string;
  actorId: string;
  id: string;
  reason: string;
}): Promise<OneOnOneDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const id = requireId("id", args.id);
  if (typeof args.reason !== "string" || args.reason.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "skipping a 1:1 needs a reason — say why this occurrence is skipped");
  }
  return withOrgTransaction(orgId, async () => {
    await assertOneOnOnesFeature(db, orgId);
    await lockOneOnOneReport(db, orgId, actorId, id);
    const one = await loadOneOnOne(db, orgId, id);
    if (!one) throw reportNotVisible();
    await requireWriteAuthority(db, orgId, actorId, one);
    if (one.status !== "scheduled") {
      throw new HrmPerformanceError("BAD_STATE", `only a scheduled 1:1 can be skipped — this one is ${one.status}`);
    }
    const updated = (await db.execute<{ id: string }>(sql`
      update hrm_one_on_ones set status = 'skipped', skip_reason = ${args.reason.trim()}, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${id} and status = 'scheduled'
      returning id
    `)).rows;
    if (updated.length !== 1) {
      throw new HrmPerformanceError("STALE_REVISION", "the 1:1 changed under you — reload it and try again");
    }
    if (one.recurrence) {
      const nextAt = await nextOccurrenceAt(one.scheduled_at, one.recurrence);
      const seriesId = one.series_id ?? one.id;
      await db.execute(sql`
        insert into hrm_one_on_ones (org_id, manager_employment_id, report_employment_id, scheduled_at, recurrence, series_id, created_by, updated_by)
        values (${orgId}, ${one.manager_employment_id}, ${one.report_employment_id}, ${nextAt}::timestamptz,
                ${JSON.stringify(one.recurrence)}::jsonb, ${seriesId}, ${actorId}, ${actorId})
        -- Ensure-exists semantics: the STALE_REVISION CAS above makes this
        -- the only writer for this record's next occurrence, so a conflict
        -- means it already exists and doing nothing is the whole intent.
        on conflict do nothing
      `);
    }
    const skipped = await loadOneOnOne(db, orgId, id);
    if (!skipped) throw new HrmPerformanceError("NOT_FOUND", "1:1 was not found — it may belong to another organization");
    const person = await loadApprovalPerson(db, orgId, actorId);
    return toDTO(skipped, await loadItems(db, orgId, id, person.partyId));
  });
}

export async function cancelOneOnOne(args: { orgId: string; actorId: string; id: string }): Promise<void> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const id = requireId("id", args.id);
  await withOrgTransaction(orgId, async () => {
    await assertOneOnOnesFeature(db, orgId);
    await lockOneOnOneReport(db, orgId, actorId, id);
    const one = await loadOneOnOne(db, orgId, id);
    if (!one) throw reportNotVisible();
    await requireWriteAuthority(db, orgId, actorId, one);
    if (one.status !== "scheduled") {
      throw new HrmPerformanceError("BAD_STATE", `only a scheduled 1:1 can be cancelled — this one is ${one.status}`);
    }
    const updated = (await db.execute<{ id: string }>(sql`
      update hrm_one_on_ones set status = 'cancelled', updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${id} and status = 'scheduled'
      returning id
    `)).rows;
    if (updated.length !== 1) {
      throw new HrmPerformanceError("STALE_REVISION", "the 1:1 changed under you — reload it and try again");
    }
  });
}

export async function addOneOnOneItem(args: {
  orgId: string;
  actorId: string;
  oneOnOneId: string;
  kind: OneOnOneItemKind;
  body: string;
  visibility?: OneOnOneItemVisibility;
  assigneePartyId?: string | null;
  dueOn?: string | null;
}): Promise<OneOnOneItemDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const oneOnOneId = requireId("oneOnOneId", args.oneOnOneId);
  if (!["talking_point", "action_item", "note"].includes(args.kind)) {
    throw new HrmPerformanceError("INVALID_INPUT", "item kind must be talking_point, action_item, or note");
  }
  if (typeof args.body !== "string" || args.body.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "an agenda item needs a body — say what the point is");
  }
  const visibility = args.visibility ?? "shared";
  if (visibility !== "shared" && visibility !== "private") {
    throw new HrmPerformanceError("INVALID_INPUT", "visibility must be shared or private");
  }
  return withOrgTransaction(orgId, async () => {
    await assertOneOnOnesFeature(db, orgId);
    await lockOneOnOneReport(db, orgId, actorId, oneOnOneId);
    const one = await loadOneOnOne(db, orgId, oneOnOneId);
    if (!one) throw reportNotVisible();
    // Either party adds items; a private item belongs to its author.
    await requireWriteAuthority(db, orgId, actorId, one);
    if (one.status !== "scheduled") {
      throw new HrmPerformanceError("BAD_STATE", `only a scheduled 1:1 takes new agenda items — this one is ${one.status}`);
    }
    const person = await loadApprovalPerson(db, orgId, actorId);
    if (!person.partyId) {
      throw new HrmPerformanceError("FORBIDDEN", "your user has no person identity in this organization — ask an administrator to link it before adding agenda items");
    }
    const maxPos = (await db.execute<{ max: number }>(sql`
      select coalesce(max(position), -1) as max from hrm_one_on_one_items where org_id = ${orgId} and one_on_one_id = ${oneOnOneId}
    `)).rows[0]?.max ?? -1;
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into hrm_one_on_one_items (org_id, one_on_one_id, kind, author_party_id, body, visibility, assignee_party_id, due_on, position, created_by, updated_by)
      values (${orgId}, ${oneOnOneId}, ${args.kind}, ${person.partyId}, ${args.body.trim()}, ${visibility},
              ${args.assigneePartyId ?? null}, ${args.dueOn ?? null}::date, ${maxPos + 1}, ${actorId}, ${actorId})
      returning id
    `)).rows[0];
    if (!inserted) throw new HrmPerformanceError("REFUSED", "the agenda item was not stored — no row was written; retry the action");
    const rows = (await db.execute<StoredItem>(sql`
      select id, kind, author_party_id, body, visibility, status, assignee_party_id,
             due_on::text as due_on, position, carried_from_item_id::text as carried_from_item_id
        from hrm_one_on_one_items where org_id = ${orgId} and id = ${inserted.id}
    `)).rows;
    const row = rows[0];
    if (!row) throw new HrmPerformanceError("REFUSED", "the agenda item was not stored — no row can be read back; retry the action");
    return {
      id: row.id, kind: row.kind, authorPartyId: row.author_party_id, body: row.body,
      visibility: row.visibility, status: row.status, assigneePartyId: row.assignee_party_id,
      dueOn: row.due_on, position: row.position, carriedFromItemId: row.carried_from_item_id,
    };
  });
}

export async function setOneOnOneItemDone(args: {
  orgId: string;
  actorId: string;
  oneOnOneId: string;
  itemId: string;
  done: boolean;
}): Promise<void> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const oneOnOneId = requireId("oneOnOneId", args.oneOnOneId);
  const itemId = requireId("itemId", args.itemId);
  await withOrgTransaction(orgId, async () => {
    await assertOneOnOnesFeature(db, orgId);
    await lockOneOnOneReport(db, orgId, actorId, oneOnOneId);
    const one = await loadOneOnOne(db, orgId, oneOnOneId);
    if (!one) throw reportNotVisible();
    await requireWriteAuthority(db, orgId, actorId, one);
    const target = args.done ? "done" : "open";
    const updated = (await db.execute<{ id: string }>(sql`
      update hrm_one_on_one_items set status = ${target}, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${itemId} and one_on_one_id = ${oneOnOneId} and status in ('open', 'done')
      returning id
    `)).rows;
    if (updated.length !== 1) {
      throw new HrmPerformanceError(
        "NOT_FOUND",
        "agenda item was not found on this 1:1, or it is already carried forward — carried items live on the next occurrence",
      );
    }
  });
}

/**
 * Schedule-form directory: the actor's own employments plus the reports
 * they manage as of today (with names), or everything for HR. A
 * scheduler outside all three gets the uniform refusal, never an empty
 * directory pretending they have nobody to meet.
 */
export async function listOneOnOneDirectory(args: {
  orgId: string;
  actorId: string;
}): Promise<{ employments: readonly { id: string; name: string; mine: boolean }[] }> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertOneOnOnesFeature(db, orgId);
    const readScope = await performanceReadScope(db, orgId, actorId);
    if (readScope !== undefined) {
      // HR's schedule-form directory covers only their allowed
      // subsidiaries — never the whole org. An empty scope reads
      // empty, never all (and never an `in ()` syntax error).
      if (readScope !== null && readScope.size === 0) return { employments: [] };
      const scopeFilter =
        readScope === null
          ? sql``
          : sql`and ${employerSubsidiaryScope(readScope, "e.employer_subsidiary_id")}`;
      const rows = (await db.execute<{ id: string; name: string }>(sql`
        select e.id, coalesce(p.display_name, '—') as name
          from worker_employments e
          left join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
         where e.org_id = ${orgId}
         ${scopeFilter}
         order by name
      `)).rows;
      const scoped = await lockEmploymentsForScope(
        db,
        rows.map((row) => row.id),
        { orgId, actorId, outOfScope: "filter" },
      );
      const visibleIds = new Set(scoped.map((employment) => employment.id));
      return { employments: rows.filter((row) => visibleIds.has(row.id)).map((row) => ({ ...row, mine: false })) };
    }
    if (!(await actorHasPermission(db, orgId, actorId, "hrm.self.read"))) {
      throw new HrmPerformanceError(
        "FORBIDDEN",
        "scheduling 1:1s needs hrm.self.read — ask an administrator to grant it in /admin/roles",
      );
    }
    const today = await businessToday(orgId);
    const own = await loadOwnEmploymentIds(db, orgId, actorId);
    const team = await loadManagedEmploymentIds(db, orgId, actorId, today);
    const ids = [...new Set([...own, ...team])];
    if (ids.length === 0) return { employments: [] };
    const params = ids.map((id) => sql`${id}::uuid`);
    const rows = (await db.execute<{ id: string; name: string }>(sql`
      select e.id, coalesce(p.display_name, '—') as name
        from worker_employments e
        left join parties p on p.org_id = e.org_id and p.id = e.worker_party_id
       where e.org_id = ${orgId} and e.id in (${sql.join(params, sql`, `)})
       order by name
    `)).rows;
    const scoped = await lockEmploymentsForScope(
      db,
      rows.map((row) => row.id),
      { orgId, actorId, outOfScope: "filter" },
    );
    const visibleIds = new Set(scoped.map((employment) => employment.id));
    const mine = new Set(own);
    return { employments: rows.filter((row) => visibleIds.has(row.id)).map((row) => ({ id: row.id, name: row.name, mine: mine.has(row.id) })) };
  });
}

export async function getOneOnOne(args: { orgId: string; actorId: string; id: string }): Promise<OneOnOneDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const id = requireId("id", args.id);
  return withOrgTransaction(orgId, async () => {
    await assertOneOnOnesFeature(db, orgId);
    await lockOneOnOneReport(db, orgId, actorId, id);
    const one = await loadOneOnOne(db, orgId, id);
    if (!one) throw reportNotVisible();
    if (!(await canSeeOneOnOne(db, orgId, actorId, one))) {
      // Uniform NOT_FOUND so existence cannot be probed across the pair boundary.
      throw new HrmPerformanceError("NOT_FOUND", "1:1 was not found — it may belong to another organization");
    }
    const person = await loadApprovalPerson(db, orgId, actorId);
    return toDTO(one, await loadItems(db, orgId, id, person.partyId));
  });
}

export async function listOneOnOnes(args: {
  orgId: string;
  actorId: string;
  employmentId?: string;
  status?: OneOnOneStatus;
}): Promise<readonly OneOnOneDTO[]> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertOneOnOnesFeature(db, orgId);
    const readScope = await performanceReadScope(db, orgId, actorId);
    const privileged = readScope !== undefined;
    const person = await loadApprovalPerson(db, orgId, actorId);
    const today = await businessToday(orgId);
    const own = await loadOwnEmploymentIds(db, orgId, actorId);
    const team = privileged ? [] : await loadManagedEmploymentIds(db, orgId, actorId, today);
    const statusFilter = args.status ? sql` and o.status = ${args.status}` : sql``;
    const employmentFilter = args.employmentId ? sql` and (o.manager_employment_id = ${args.employmentId} or o.report_employment_id = ${args.employmentId})` : sql``;
    const rows = (await db.execute<StoredOneOnOne & { recurrence: unknown }>(sql`
      select o.id, o.manager_employment_id, o.report_employment_id,
             r.employer_subsidiary_id as report_employer_subsidiary_id,
             m.worker_party_id as manager_party_id, r.worker_party_id as report_party_id,
             coalesce(mp.display_name, '—') as manager_name, coalesce(rp.display_name, '—') as report_name,
             o.scheduled_at::text as scheduled_at, o.held_at::text as held_at,
             o.status, o.skip_reason, o.recurrence, o.series_id::text as series_id
        from hrm_one_on_ones o
        join worker_employments m on m.org_id = o.org_id and m.id = o.manager_employment_id
        join worker_employments r on r.org_id = o.org_id and r.id = o.report_employment_id
        left join parties mp on mp.org_id = o.org_id and mp.id = m.worker_party_id
        left join parties rp on rp.org_id = o.org_id and rp.id = r.worker_party_id
       where o.org_id = ${orgId}${statusFilter}${employmentFilter}
       order by o.scheduled_at desc
    `)).rows;
    const visibleEmployments = await lockEmploymentsForScope(
      db,
      rows.map((row) => row.report_employment_id),
      { orgId, actorId, outOfScope: "filter" },
    );
    const visibleEmploymentIds = new Set(visibleEmployments.map((employment) => employment.id));
    const out: OneOnOneDTO[] = [];
    for (const raw of rows) {
      const one: StoredOneOnOne = { ...raw, recurrence: (raw.recurrence ?? null) as StoredOneOnOne["recurrence"] };
      if (!visibleEmploymentIds.has(one.report_employment_id)) continue;
      // HR sees only pairs whose report sits inside their allowed
      // subsidiaries — the privileged flag alone is never enough.
      const inScope =
        readScope === null ||
        (readScope !== undefined &&
          one.report_employer_subsidiary_id !== null &&
          readScope.has(one.report_employer_subsidiary_id));
      const visible =
        (privileged && inScope) ||
        (person.partyId !== null &&
          (person.partyId === one.manager_party_id || person.partyId === one.report_party_id)) ||
        (own.includes(one.manager_employment_id) && team.includes(one.report_employment_id));
      if (!visible) continue;
      out.push(toDTO(one, await loadItems(db, orgId, one.id, person.partyId)));
    }
    return out;
  });
}

/**
 * Held-1:1 shared-item evidence for review drafting: shared items from
 * held 1:1s touching the subject employment, newest first. Private notes
 * never appear here — evidence is shared content only.
 */
export async function listHeldSharedItemsForEmployment(args: {
  orgId: string;
  actorId: string;
  employmentId: string;
}): Promise<readonly { oneOnOneId: string; heldAt: string; kind: OneOnOneItemKind; body: string }[]> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const employmentId = requireId("employmentId", args.employmentId);
  return withOrgTransaction(orgId, async () => {
    await assertContinuousFeature(db, orgId);
    try {
      await lockEmploymentsForScope(db, [employmentId], { orgId, actorId });
    } catch (error) {
      if (error instanceof HrmAuthorizationError) throw reportNotVisible();
      throw error;
    }
    // Evidence serves the manager review: HR reads only evidence for
    // employments inside their allowed subsidiaries, otherwise the
    // reader must manage the employment structurally.
    const readScope = await performanceReadScope(db, orgId, actorId);
    if (readScope === undefined) {
      const today = await businessToday(orgId);
      const own = await loadOwnEmploymentIds(db, orgId, actorId);
      const team = await loadManagedEmploymentIds(db, orgId, actorId, today);
      if (!team.includes(employmentId) && !own.includes(employmentId)) {
        throw new HrmPerformanceError(
          "FORBIDDEN",
          "1:1 evidence serves the manager review — only the report's line manager or HR may read it",
        );
      }
    } else if (readScope !== null) {
      const employer = await reportEmployer(db, orgId, employmentId);
      if (employer === null || !readScope.has(employer)) {
        throw new HrmPerformanceError(
          "FORBIDDEN",
          "1:1 evidence serves the manager review — only the report's line manager or the HR covering them may read it",
        );
      }
    }
    const rows = (await db.execute<{ oneOnOneId: string; heldAt: string; kind: OneOnOneItemKind; body: string }>(sql`
      select i.one_on_one_id as "oneOnOneId", o.held_at::text as "heldAt", i.kind, i.body
        from hrm_one_on_one_items i
        join hrm_one_on_ones o on o.org_id = i.org_id and o.id = i.one_on_one_id
       where i.org_id = ${orgId} and o.status = 'held'
         and (o.manager_employment_id = ${employmentId} or o.report_employment_id = ${employmentId})
         and i.visibility = 'shared' and i.status <> 'carried'
       order by o.held_at desc
    `)).rows;
    return rows;
  });
}
