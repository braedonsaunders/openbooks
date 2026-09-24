import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { HRM_FEATURE_KEY } from "../employment-read.ts";
import {
  requireHrmDocumentsManage,
  requireHrmDocumentsRead,
  requireUnrestrictedHrmScope,
} from "../authorization.ts";
import { HrmDocumentsError } from "./errors.ts";
import { assertCategoryDeclared } from "./categories.ts";
import { HRM_DOCUMENTS_FEATURE_KEY } from "./documents.ts";
import { purgeCabinetBytes } from "./cabinet.ts";

/**
 * HR-19 retention schedules with audited deletion.
 *
 * At completion (signed/acknowledged) applyCompletionRetention computes
 * retain_until from the active schedule for the document's category and
 * STORES it with the rule id AND the governing action — later schedule
 * edits never reinterpret a completed document. The daily runRetentionTick (worker duty
 * hrm-retention-tick) expires past-due sends, flags documents at
 * retain_until (retention_flagged event + open action row), and executes
 * the action once retain_until plus the org's declared grace days has
 * passed — unless legal_hold, which blocks with a named reason instead
 * of deleting. Delete purges the cabinet bytes and keeps the row with
 * status deleted plus every event; anonymize clears the title and the
 * party link. Every execution is a retention_actions row; executed_by
 * null = the scheduler.
 */

export const DEFAULT_RETENTION_GRACE_DAYS = 30;

async function assertDocumentsFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new HrmDocumentsError(
      "REFUSED",
      "retention is unavailable while the hrm feature is off — enable it under Company Settings → Features",
    );
  }
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_DOCUMENTS_FEATURE_KEY))) {
    throw new HrmDocumentsError(
      "REFUSED",
      "retention is unavailable while the hrmDocuments feature is off — enable it under Company Settings → Features",
    );
  }
  if (!(await lockAndCheckOrgFeature(exec, orgId, "hrmDocumentRetention"))) {
    throw new HrmDocumentsError(
      "REFUSED",
      "retention is unavailable while the hrmDocumentRetention feature is off — enable it under Company Settings → Features",
    );
  }
}

export interface RetentionScheduleDTO {
  id: string;
  categoryKey: string;
  retainYears: number;
  fromEvent: string;
  action: string;
  isActive: boolean;
}

type ScheduleRow = {
  id: string;
  category_key: string;
  retain_years: number;
  from_event: string;
  action: string;
  is_active: boolean;
};

function toScheduleDTO(row: ScheduleRow): RetentionScheduleDTO {
  return {
    id: row.id,
    categoryKey: row.category_key,
    retainYears: row.retain_years,
    fromEvent: row.from_event,
    action: row.action,
    isActive: row.is_active,
  };
}

export async function listSchedules(query: {
  orgId: string;
  actorId: string;
}): Promise<RetentionScheduleDTO[]> {
  await requireHrmDocumentsRead(db, query.orgId, query.actorId);
  const rows = (await db.execute<ScheduleRow>(sql`
    select id, category_key, retain_years, from_event, action, is_active
      from hrm_retention_schedules
     where org_id = ${query.orgId}
     order by category_key
  `)).rows;
  return rows.map(toScheduleDTO);
}

export async function saveSchedule(input: {
  orgId: string;
  actorId: string;
  scheduleId?: string;
  categoryKey: unknown;
  retainYears: unknown;
  fromEvent: unknown;
  action: unknown;
  isActive?: boolean;
}): Promise<RetentionScheduleDTO> {
  const categoryKey =
    typeof input.categoryKey === "string" ? input.categoryKey.trim() : "";
  if (!categoryKey) {
    throw new HrmDocumentsError(
      "VALIDATION",
      "category is required — one schedule per document category, declared under Setup → Workforce → Document Categories",
    );
  }
  const retainYears = Number(input.retainYears);
  if (!Number.isInteger(retainYears) || retainYears < 0 || retainYears > 100) {
    throw new HrmDocumentsError("VALIDATION", "retainYears must be a whole number of years from 0 to 100");
  }
  if (input.fromEvent !== "completion" && input.fromEvent !== "termination" && input.fromEvent !== "creation") {
    throw new HrmDocumentsError(
      "VALIDATION",
      "fromEvent must be completion, termination, or creation — the date the retention clock starts from",
    );
  }
  if (input.action !== "delete" && input.action !== "anonymize") {
    throw new HrmDocumentsError("VALIDATION", "action must be delete or anonymize");
  }
  return withOrgTransaction(input.orgId, async () => {
    await requireHrmDocumentsManage(db, input.orgId, input.actorId);
    // Retention schedules are org-wide policy (they purge every legal
    // entity's documents): a subsidiary-restricted manager gets the
    // canonical 403, not a cross-entity policy write.
    await requireUnrestrictedHrmScope(db, input.orgId, input.actorId);
    await assertDocumentsFeature(db, input.orgId);
    // Membership, not shape: a schedule for an undeclared category would
    // never match a document, so the save is refused against the Setup
    // vocabulary instead of stored as a dead rule.
    await assertCategoryDeclared(db, input.orgId, categoryKey);
    if (input.scheduleId) {
      const updated = (await db.execute<ScheduleRow>(sql`
        update hrm_retention_schedules
           set category_key = ${categoryKey}, retain_years = ${retainYears},
               from_event = ${input.fromEvent}, action = ${input.action},
               is_active = ${input.isActive ?? true},
               updated_at = now(), updated_by = ${input.actorId}
         where org_id = ${input.orgId} and id = ${input.scheduleId}
        returning id, category_key, retain_years, from_event, action, is_active
      `)).rows[0];
      if (!updated) {
        throw new HrmDocumentsError("NOT_FOUND", "retention schedule is not visible in this organization");
      }
      return toScheduleDTO(updated);
    }
    try {
      const inserted = (await db.execute<ScheduleRow>(sql`
        insert into hrm_retention_schedules
          (org_id, category_key, retain_years, from_event, action, is_active, created_by, updated_by)
        values (${input.orgId}, ${categoryKey}, ${retainYears},
                ${input.fromEvent}, ${input.action}, ${input.isActive ?? true},
                ${input.actorId}, ${input.actorId})
        returning id, category_key, retain_years, from_event, action, is_active
      `)).rows[0];
      if (!inserted) {
        throw new HrmDocumentsError(
          "REFUSED",
          "the schedule insert matched no row — the save is refused, never a silent success",
        );
      }
      return toScheduleDTO(inserted);
    } catch (e) {
      // The driver wraps the Postgres unique violation (23505) in a
      // Failed-query shell — walk the cause chain, since the shell's own
      // message names the statement, not the violation.
      const chain: string[] = [];
      let cursor: unknown = e;
      while (cursor instanceof Error && chain.length < 5) {
        chain.push(cursor.message);
        const cause = (cursor as { cause?: unknown }).cause;
        cursor = cause instanceof Error ? cause : null;
      }
      if (/duplicate key|unique violation|23505|hrm_retention_schedules_org_category/i.test(chain.join("\n"))) {
        throw new HrmDocumentsError(
          "REFUSED",
          `category ${JSON.stringify(categoryKey)} already has a schedule — edit it instead of adding a second; two schedules for one category is ambiguous deletion`,
        );
      }
      throw e;
    }
  });
}

/**
 * Compute and store retain_until at completion. Called in the completing
 * transaction (sign/acknowledge). No active schedule = no retention clock
 * (refused by nothing — the org simply keeps the document).
 */
export async function applyCompletionRetention(
  exec: SqlExecutor,
  orgId: string,
  documentId: string,
  actorId: string | null,
): Promise<void> {
  const doc = (await exec.execute<{
    category_key: string;
    employment_id: string | null;
    completed_at: string | null;
    created_at: string;
  }>(sql`
    select category_key, employment_id,
           completed_at::text as completed_at, created_at::text as created_at
      from hrm_documents where org_id = ${orgId} and id = ${documentId}
  `)).rows[0];
  if (!doc) {
    throw new HrmDocumentsError("NOT_FOUND", "document is not visible in this organization");
  }
  const schedule = (await exec.execute<ScheduleRow>(sql`
    select id, category_key, retain_years, from_event, action, is_active
      from hrm_retention_schedules
     where org_id = ${orgId} and category_key = ${doc.category_key} and is_active
  `)).rows[0];
  if (!schedule) return;
  let anchor: string | null = null;
  if (schedule.from_event === "completion") {
    anchor = doc.completed_at;
  } else if (schedule.from_event === "creation") {
    anchor = doc.created_at;
  } else {
    // Termination anchor: the latest live employment version end for the
    // document's employment. No employment or no end date = the clock
    // cannot start — fail closed with a blocked action row, never zero.
    const term = doc.employment_id
      ? (await exec.execute<{ end: string | null }>(sql`
          select max(effective_to)::text as end
            from worker_employment_versions
           where org_id = ${orgId} and employment_id = ${doc.employment_id}
             and recorded_until is null
        `)).rows[0]?.end ?? null
      : null;
    if (!term) {
      await exec.execute(sql`
        insert into hrm_retention_actions (org_id, document_id, schedule_id, due_on, action, blocked_reason)
        values (${orgId}, ${documentId}, ${schedule.id}, current_date, ${schedule.action},
                'termination anchor: no employment end date is recorded — record the termination before retention can clock this document')
      `);
      return;
    }
    anchor = term;
  }
  if (!anchor) return;
  const computed = (await exec.execute<{ until: string }>(sql`
    select (${anchor}::date + (${schedule.retain_years} || ' years')::interval)::date::text as until
  `)).rows[0]!.until;
  // The completion snapshot freezes the GOVERNING action alongside the
  // date: later schedule edits (anonymize → delete) govern only documents
  // that complete after the edit — never historical documents, whose tick
  // copies this frozen value instead of the schedule's live one.
  const touched = (await exec.execute<{ n: string }>(sql`
    update hrm_documents
       set retain_until = ${computed}::date, retention_rule_id = ${schedule.id},
           retention_action = ${schedule.action},
           updated_at = now(), updated_by = coalesce(${actorId}, updated_by)
     where org_id = ${orgId} and id = ${documentId} and retain_until is null
    returning 1
  `)).rows.length;
  if (touched === 0) {
    throw new HrmDocumentsError(
      "REFUSED",
      "retain_until is already stored — a completed document's retention clock never recomputes, not even when the schedule changes",
    );
  }
}

/** Org-declared grace days (Company settings → HRM), default 30. */
export async function loadGraceDays(exec: SqlExecutor, orgId: string): Promise<number> {
  const row = (await exec.execute<{ grace: unknown }>(sql`
    select settings->'hrmDocuments'->>'retentionGraceDays' as grace from orgs where id = ${orgId}
  `)).rows[0];
  const days = Number(row?.grace);
  if (row?.grace !== undefined && row?.grace !== null && (!Number.isInteger(days) || days < 0)) {
    throw new HrmDocumentsError(
      "REFUSED",
      "retentionGraceDays is misconfigured — set whole days at zero or above under Company Settings, or clear it for the 30-day default",
    );
  }
  return Number.isInteger(days) && days >= 0 ? days : DEFAULT_RETENTION_GRACE_DAYS;
}

export interface RetentionTickResult {
  expired: number;
  clocksStarted: number;
  flagged: number;
  executed: number;
  blocked: number;
}

/**
 * The daily retention job (worker duty hrm-retention-tick, one org at a
 * time): expire past-due sends, start clocks on completed documents that
 * predate the rule, flag documents at retain_until, and execute actions
 * past grace — unless legal_hold. One transaction per org.
 */
export async function runRetentionTick(orgId: string, today: string): Promise<RetentionTickResult> {
  return withOrgTransaction(orgId, async () => {
    const result: RetentionTickResult = { expired: 0, clocksStarted: 0, flagged: 0, executed: 0, blocked: 0 };
    // (1) Expire sends past their expiry.
    const expired = await db.execute<{ id: string }>(sql`
      update hrm_documents
         set status = 'expired', updated_at = now()
       where org_id = ${orgId} and status in ('sent', 'viewed', 'partially_signed')
         and expires_at is not null and expires_at < now()
      returning id
    `);
    for (const row of expired.rows) {
      await db.execute(sql`
        insert into hrm_document_events (org_id, document_id, kind, actor)
        values (${orgId}, ${row.id}, 'expired', null)
      `);
      result.expired += 1;
    }
    // (2) Start clocks on completed documents with no stored retain_until.
    const unclocked = (await db.execute<{ id: string }>(sql`
      select id from hrm_documents
       where org_id = ${orgId} and status in ('signed', 'acknowledged')
         and completed_at is not null and retain_until is null
       limit 200
    `)).rows;
    for (const row of unclocked) {
      await applyCompletionRetention(db, orgId, row.id, null);
      result.clocksStarted += 1;
    }
    // (3) Flag documents at retain_until — one action row per document,
    // ever. An executed row ends the document's retention story (no
    // re-flag after delete/anonymize); an open row means flagged and
    // waiting out grace or held. Without this, every tick would open a
    // fresh row on an already-executed document.
    // The flagged action is the document's FROZEN completion snapshot
    // (d.retention_action), never the schedule's live value: editing a
    // schedule after completion must not re-govern historical documents.
    // The coalesce covers only rows snapshotted before the freeze column
    // existed that the backfill could not reach (no rule to inherit from);
    // every governed row carries its frozen action.
    const due = (await db.execute<{ id: string; schedule_id: string; action: string }>(sql`
      select d.id, d.retention_rule_id as schedule_id,
             coalesce(d.retention_action, s.action) as action
        from hrm_documents d
        join hrm_retention_schedules s on s.id = d.retention_rule_id
       where d.org_id = ${orgId} and d.retain_until is not null
         and d.retain_until <= ${today}::date
         and d.status not in ('deleted', 'voided')
         and not exists (
           select 1 from hrm_retention_actions a
            where a.org_id = d.org_id and a.document_id = d.id
         )
       limit 200
    `)).rows;
    for (const row of due) {
      await db.execute(sql`
        insert into hrm_retention_actions (org_id, document_id, schedule_id, due_on, action)
        values (${orgId}, ${row.id}, ${row.schedule_id}, ${today}::date, ${row.action})
      `);
      await db.execute(sql`
        insert into hrm_document_events (org_id, document_id, kind, actor)
        values (${orgId}, ${row.id}, 'retention_flagged', null)
      `);
      result.flagged += 1;
    }
    // (4) Execute actions past grace — unless legal hold.
    const grace = await loadGraceDays(db, orgId);
    const open = (await db.execute<{
      id: string;
      document_id: string;
      action: string;
      due_on: string;
      legal_hold: boolean;
      file_id: string | null;
    }>(sql`
      select a.id, a.document_id, a.action, a.due_on::text as due_on,
             d.legal_hold, d.file_id
        from hrm_retention_actions a
        join hrm_documents d on d.org_id = a.org_id and d.id = a.document_id
       where a.org_id = ${orgId} and a.executed_at is null
         and a.due_on <= (${today}::date - (${grace} || ' days')::interval)
         and d.status not in ('deleted', 'voided')
       limit 200
    `)).rows;
    for (const row of open) {
      if (row.legal_hold) {
        await db.execute(sql`
          update hrm_retention_actions
             set blocked_reason = 'legal hold is on — release the hold to let retention proceed'
           where org_id = ${orgId} and id = ${row.id}
        `);
        result.blocked += 1;
        continue;
      }
      if (row.action === "delete") {
        if (row.file_id) await purgeCabinetBytes(db, orgId, row.file_id);
        await db.execute(sql`
          update hrm_documents set status = 'deleted', updated_at = now()
           where org_id = ${orgId} and id = ${row.document_id}
        `);
        await db.execute(sql`
          insert into hrm_document_events (org_id, document_id, kind, actor)
          values (${orgId}, ${row.document_id}, 'deleted', null)
        `);
      } else {
        if (row.file_id) await purgeCabinetBytes(db, orgId, row.file_id);
        await db.execute(sql`
          update hrm_documents
             set title = 'Anonymized document', party_id = null, employment_id = null,
                 file_id = null, updated_at = now()
           where org_id = ${orgId} and id = ${row.document_id}
        `);
        await db.execute(sql`
          insert into hrm_document_events (org_id, document_id, kind, actor)
          values (${orgId}, ${row.document_id}, 'deleted', null)
        `);
      }
      await db.execute(sql`
        update hrm_retention_actions set executed_at = now(), executed_by = null
         where org_id = ${orgId} and id = ${row.id}
      `);
      result.executed += 1;
    }
    return result;
  });
}

export interface RetentionActionDTO {
  id: string;
  documentId: string;
  scheduleId: string;
  dueOn: string;
  executedAt: string | null;
  action: string;
  executedBy: string | null;
  blockedReason: string | null;
}

export async function listRetentionActions(query: {
  orgId: string;
  actorId: string;
  pendingOnly?: boolean;
}): Promise<RetentionActionDTO[]> {
  await requireHrmDocumentsRead(db, query.orgId, query.actorId);
  const rows = (await db.execute<{
    id: string;
    document_id: string;
    schedule_id: string;
    due_on: string;
    executed_at: string | null;
    action: string;
    executed_by: string | null;
    blocked_reason: string | null;
  }>(sql`
    select id, document_id, schedule_id, due_on::text as due_on,
           executed_at::text as executed_at, action, executed_by, blocked_reason
      from hrm_retention_actions
     where org_id = ${query.orgId}
       ${query.pendingOnly ? sql`and executed_at is null` : sql``}
     order by due_on desc
     limit 200
  `)).rows;
  return rows.map((r) => ({
    id: r.id,
    documentId: r.document_id,
    scheduleId: r.schedule_id,
    dueOn: r.due_on,
    executedAt: r.executed_at,
    action: r.action,
    executedBy: r.executed_by,
    blockedReason: r.blocked_reason,
  }));
}
