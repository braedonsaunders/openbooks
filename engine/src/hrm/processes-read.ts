import {
  checklistStepDesignSchema,
  actionableChecklistSteps,
  type ChecklistStepDesign,
} from "@openbooks/forms-core";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { requireHrmProcessRead } from "./authorization.ts";
import { HRM_FEATURE_KEY } from "./employment-read.ts";
import { addOffsetDays, isStepOverdue, summarizeProgress } from "./process-math.ts";
import { HrmProcessError, resolveStepActor } from "./processes.ts";
import { inputGuards } from "./input-guards.ts";

/**
 * Canonical HRM process READ service (no mutations).
 *
 * Reads the 0193 tables through the same gates as the write service:
 * hrm.process.read plus the employer-subsidiary scope, rechecked inside
 * the caller's transaction. Overdue and progress reuse process-math.ts —
 * never reimplemented. Business today resolves through
 * platform/business-date.ts (the org's zone, UTC fallback).
 *
 * Self-service reads (getOwnStep) return ONLY the step — the first
 * self-service touch exposes nothing beyond the step, and strangers read
 * NOT_FOUND (uniform with unknown ids, so existence cannot be probed).
 */

async function assertHrmFeatureOn(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new HrmProcessError(
      "FEATURE_OFF",
      "hrm feature is disabled: enable it on Company Settings → Features before reading processes",
    );
  }
}

const { requireOrgId, requireActorId, requireId } = inputGuards(
  (message) => new HrmProcessError("REFUSED", message),
);

export type ProcessSegment = "open" | "overdue" | "needs_action" | "completed" | "cancelled";

export interface ProcessListItem {
  readonly id: string;
  readonly kind: string;
  readonly effectiveDate: string;
  readonly status: string;
  readonly employmentId: string;
  readonly workerPartyId: string;
  readonly workerName: string;
  readonly total: number;
  readonly required: number;
  readonly doneRequired: number;
  readonly allRequiredDone: boolean;
  readonly overdueSteps: number;
  readonly nextDueOn: string | null;
  readonly nextActionTitle?: string | null;
  readonly nextActionOwner?: string | null;
  readonly openedByChangeId: string | null;
}

type ProcessListRow = {
  id: string;
  kind: string;
  effective_date: string;
  status: string;
  employment_id: string;
  worker_party_id: string;
  worker_name: string;
  opened_by_change_id: string | null;
  steps:
    | {
        id: string;
        template_step_id: string | null;
        title: string;
        owner_kind: string;
        owner_party_id: string | null;
        position: number;
        design: unknown;
        approval_status: string;
        required: boolean;
        status: string;
        due_on: string;
      }[]
    | null;
};

/**
 * The aggregate half of process read authority (mirrors
 * requireAggregateEmploymentRead in employment-read.ts): the
 * hrm.process.read grant, then the employer scope lifted to list reads.
 * Denial throws HrmAuthorizationError with the same remedy; scope returns
 * the allowed employer set (null = unrestricted) for the caller to filter
 * by, never a boolean to trust.
 */
async function requireAggregateProcessRead(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<Set<string> | null> {
  if (!(await actorHasPermission(exec, orgId, actorId, "hrm.process.read"))) {
    throw new HrmAuthorizationError(
      "Process access requires the hrm.process.read permission — ask an administrator to grant it in /admin/roles.",
    );
  }
  return actorAllowedSubsidiaryIds(exec, orgId, actorId);
}

function toListItem(row: ProcessListRow, today: string): ProcessListItem {
  const steps = row.steps ?? [];
  const summary = summarizeProgress(
    steps.map((step) => ({ required: step.required, status: step.status })),
  );
  let overdueSteps = 0;
  let nextDueOn: string | null = null;
  for (const step of steps) {
    if (step.status !== "pending") continue;
    if (isStepOverdue({ dueOn: step.due_on, today, status: step.status })) overdueSteps += 1;
    if (nextDueOn === null || step.due_on < nextDueOn) nextDueOn = step.due_on;
  }
  const ready = actionableChecklistSteps(
    steps.map((s) => ({
      ...s,
      sourceStepId: s.template_step_id,
      dueOn: s.due_on,
      approvalStatus: s.approval_status,
      design: checklistStepDesignSchema.parse(s.design),
    })),
  );
  return {
    nextActionTitle: ready[0]?.title ?? null,
    nextActionOwner: ready[0]?.owner_kind ?? null,
    id: row.id,
    kind: row.kind,
    effectiveDate: row.effective_date,
    status: row.status,
    employmentId: row.employment_id,
    workerPartyId: row.worker_party_id,
    workerName: row.worker_name,
    total: summary.total,
    required: summary.required,
    doneRequired: summary.doneRequired,
    allRequiredDone: summary.allRequiredDone,
    overdueSteps,
    nextDueOn,
    openedByChangeId: row.opened_by_change_id,
  };
}

export async function listProcesses(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly segment: ProcessSegment;
}): Promise<ProcessListItem[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const segment = query.segment;
  if (
    segment !== "open" &&
    segment !== "overdue" &&
    segment !== "needs_action" &&
    segment !== "completed" &&
    segment !== "cancelled"
  ) {
    throw new HrmProcessError(
      "REFUSED",
      `unknown process segment ${JSON.stringify(segment)} — list one of open, overdue, needs_action, completed, or cancelled`,
    );
  }
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    const allowed = await requireAggregateProcessRead(db, orgId, actorId);
    const today = await businessToday(orgId);
    const statusFilter =
      segment === "completed" ? "completed" : segment === "cancelled" ? "cancelled" : "open";
    const rows = (
      await db.execute<ProcessListRow>(sql`
      select p.id, p.kind, p.effective_date::text as effective_date, p.status,
             p.employment_id, e.worker_party_id::text as worker_party_id,
             wp.display_name as worker_name,
             p.opened_by_change_id::text as opened_by_change_id,
             coalesce((select json_agg(row_to_json(s)) from (
               select st.id,st.template_step_id,st.title,st.owner_kind,st.owner_party_id,st.position,st.design,st.approval_status,st.required, st.status, st.due_on::text as due_on
                 from hrm_process_steps st
                where st.org_id = p.org_id and st.process_id = p.id
                order by st.position) s), '[]'::json) as steps
        from hrm_processes p
        join worker_employments e on e.org_id = p.org_id and e.id = p.employment_id
        join parties wp on wp.org_id = p.org_id and wp.id = e.worker_party_id
       where p.org_id = ${orgId} and p.status = ${statusFilter}
         ${
           allowed === null
             ? sql``
             : sql`and e.employer_subsidiary_id in (
           select value::uuid from jsonb_array_elements_text(${JSON.stringify([...allowed])}::jsonb) as _a(value))`
         }
       order by p.effective_date desc, p.id
    `)
    ).rows;
    if (segment === "needs_action") {
      const person = (
        await db.execute<{ party_id: string | null }>(
          sql`select party_id from users where org_id=${orgId} and id=${actorId} and is_active`,
        )
      ).rows[0];
      const manages = await actorHasPermission(db, orgId, actorId, "hrm.process.manage");
      return rows
        .filter((row) =>
          actionableChecklistSteps(
            (row.steps ?? []).map((s) => ({
              ...s,
              sourceStepId: s.template_step_id,
              dueOn: s.due_on,
              approvalStatus: s.approval_status,
              design: checklistStepDesignSchema.parse(s.design),
            })),
          ).some((step) =>
            step.owner_kind === "manager" || step.owner_kind === "hr"
              ? manages
              : step.owner_kind === "employee"
                ? person?.party_id === row.worker_party_id
                : Boolean(person?.party_id && person.party_id === step.owner_party_id),
          ),
        )
        .map((row) => toListItem(row, today));
    }
    const items = rows.map((row) => toListItem(row, today));
    if (segment === "overdue") return items.filter((item) => item.overdueSteps > 0);
    return items;
  });
}

export interface ProcessStepDetail {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly description: string | null;
  readonly ownerKind: string;
  readonly ownerPartyId: string | null;
  readonly dueOn: string;
  readonly required: boolean;
  readonly evidenceKind: string;
  readonly status: string;
  readonly overdue: boolean;
  readonly doneBy: string | null;
  readonly doneByName?: string | null;
  readonly skipReason: string | null;
  readonly attachmentId: string | null;
  readonly design?: ChecklistStepDesign;
  readonly response?: Record<string, unknown> | null;
  readonly approvalStatus?: string;
  readonly sourceStepId?: string | null;
  readonly doneAt?: string | null;
  readonly canComplete?: boolean;
  readonly canSkip?: boolean;
  readonly blocked?: boolean;
}

export interface ProcessDetail {
  readonly id: string;
  readonly kind: string;
  readonly effectiveDate: string;
  readonly status: string;
  readonly employmentId: string;
  readonly workerPartyId: string;
  readonly workerName: string;
  readonly openedByChangeId: string | null;
  readonly progress: {
    total: number;
    required: number;
    doneRequired: number;
    allRequiredDone: boolean;
  };
  readonly steps: ProcessStepDetail[];
  readonly canManage?: boolean;
}

export async function getProcess(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly processId: string;
}): Promise<ProcessDetail> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const processId = requireId(query.processId, "processId");
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    const head = (
      await db.execute<{
        id: string;
        kind: string;
        effective_date: string;
        status: string;
        employment_id: string;
        worker_party_id: string;
        worker_name: string;
        opened_by_change_id: string | null;
      }>(sql`
      select p.id, p.kind, p.effective_date::text as effective_date, p.status,
             p.employment_id::text as employment_id,
             e.worker_party_id::text as worker_party_id,
             wp.display_name as worker_name,
             p.opened_by_change_id::text as opened_by_change_id
        from hrm_processes p
        join worker_employments e on e.org_id = p.org_id and e.id = p.employment_id
        join parties wp on wp.org_id = p.org_id and wp.id = e.worker_party_id
       where p.org_id = ${orgId} and p.id = ${processId}
    `)
    ).rows[0];
    if (!head) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process not found in this organization — check the process id",
      );
    }
    // Authority second, over the trusted employment id: unknown, wrong-org,
    // and out-of-scope subjects are refused uniformly inside the gate.
    await requireHrmProcessRead(db, orgId, actorId, head.employment_id);
    const today = await businessToday(orgId);
    return assembleDetail(db, orgId, head, today, actorId);
  });
}

type ProcessHead = {
  id: string;
  kind: string;
  effective_date: string;
  status: string;
  employment_id: string;
  worker_party_id: string;
  worker_name: string;
  opened_by_change_id: string | null;
};

async function assembleDetail(
  exec: SqlExecutor,
  orgId: string,
  head: ProcessHead,
  today: string,
  actorId: string,
): Promise<ProcessDetail> {
  const rows = (
    await exec.execute<{
      id: string;
      position: number;
      title: string;
      description: string | null;
      owner_kind: string;
      owner_party_id: string | null;
      due_on: string;
      required: boolean;
      evidence_kind: string;
      status: string;
      done_by: string | null;
      done_by_name: string | null;
      skip_reason: string | null;
      attachment_id: string | null;
      design: unknown;
      response: Record<string, unknown> | null;
      approval_status: string;
      template_step_id: string | null;
      done_at: string | null;
    }>(sql`
    select design,response,approval_status,template_step_id,done_at::text, id, position, title, description, owner_kind,
           owner_party_id::text as owner_party_id, due_on::text as due_on,
           required, evidence_kind, status,
           done_by::text as done_by,(select u.name from users u where u.org_id=hrm_process_steps.org_id and u.id=hrm_process_steps.done_by) as done_by_name, skip_reason,
           attachment_id::text as attachment_id
      from hrm_process_steps
     where org_id = ${orgId} and process_id = ${head.id}
     order by position
  `)
  ).rows;
  const maySkipRequired = await actorHasPermission(exec, orgId, actorId, "hrm.employment.manage");
  const summary = summarizeProgress(
    rows.map((row) => ({ required: row.required, status: row.status })),
  );
  const stepActors = await Promise.all(
    rows.map((row) =>
      resolveStepActor(exec, orgId, actorId, {
        ...row,
        employment_id: head.employment_id,
        worker_party_id: head.worker_party_id,
      }),
    ),
  );
  return {
    canManage: stepActors.includes("manager"),
    id: head.id,
    kind: head.kind,
    effectiveDate: head.effective_date,
    status: head.status,
    employmentId: head.employment_id,
    workerPartyId: head.worker_party_id,
    workerName: head.worker_name,
    openedByChangeId: head.opened_by_change_id,
    progress: {
      total: summary.total,
      required: summary.required,
      doneRequired: summary.doneRequired,
      allRequiredDone: summary.allRequiredDone,
    },
    steps: rows.map((row, index) => ({
      design: checklistStepDesignSchema.parse(row.design),
      response: row.response,
      approvalStatus: row.approval_status,
      sourceStepId: row.template_step_id,
      doneAt: row.done_at,
      canComplete: stepActors[index] !== "stranger",
      canSkip: row.required ? maySkipRequired : stepActors[index] !== "stranger",
      id: row.id,
      position: row.position,
      title: row.title,
      description: row.description,
      ownerKind: row.owner_kind,
      ownerPartyId: row.owner_party_id,
      dueOn: row.due_on,
      required: row.required,
      evidenceKind: row.evidence_kind,
      status: row.status,
      overdue: isStepOverdue({ dueOn: row.due_on, today, status: row.status }),
      doneBy: row.done_by,
      doneByName: row.done_by_name,
      skipReason: row.skip_reason,
      attachmentId: row.attachment_id,
    })),
  };
}

export interface OnboardingOverview {
  readonly openProcesses: ProcessListItem[];
  readonly overdueSteps: (ProcessStepDetail & {
    processId: string;
    processKind: string;
    workerName: string;
  })[];
  readonly dueNextSevenDays: (ProcessStepDetail & {
    processId: string;
    processKind: string;
    workerName: string;
  })[];
}

/** HR overview panel: open checklists, overdue steps, and the next seven days. */
export async function getOnboardingOverview(query: {
  readonly orgId: string;
  readonly actorId: string;
}): Promise<OnboardingOverview> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    const allowed = await requireAggregateProcessRead(db, orgId, actorId);
    const today = await businessToday(orgId);
    const rows = (
      await db.execute<ProcessListRow>(sql`
      select p.id, p.kind, p.effective_date::text as effective_date, p.status,
             p.employment_id, e.worker_party_id::text as worker_party_id,
             wp.display_name as worker_name,
             p.opened_by_change_id::text as opened_by_change_id,
             coalesce((select json_agg(row_to_json(s)) from (
               select st.id,st.template_step_id,st.title,st.owner_kind,st.owner_party_id,st.position,st.design,st.approval_status,st.required, st.status, st.due_on::text as due_on
                 from hrm_process_steps st
                where st.org_id = p.org_id and st.process_id = p.id
                order by st.position) s), '[]'::json) as steps
        from hrm_processes p
        join worker_employments e on e.org_id = p.org_id and e.id = p.employment_id
        join parties wp on wp.org_id = p.org_id and wp.id = e.worker_party_id
       where p.org_id = ${orgId} and p.status = 'open'
         ${
           allowed === null
             ? sql``
             : sql`and e.employer_subsidiary_id in (
           select value::uuid from jsonb_array_elements_text(${JSON.stringify([...allowed])}::jsonb) as _a(value))`
         }
       order by p.effective_date desc, p.id
    `)
    ).rows;
    const openProcesses = rows.map((row) => toListItem(row, today));
    const stepRows = (
      await db.execute<{
        id: string;
        process_id: string;
        process_kind: string;
        worker_name: string;
        position: number;
        title: string;
        description: string | null;
        owner_kind: string;
        owner_party_id: string | null;
        due_on: string;
        required: boolean;
        evidence_kind: string;
        status: string;
        done_by: string | null;
        skip_reason: string | null;
        attachment_id: string | null;
      }>(sql`
      select st.id, st.process_id::text as process_id, p.kind as process_kind,
             wp.display_name as worker_name,
             st.position, st.title, st.description, st.owner_kind,
             st.owner_party_id::text as owner_party_id, st.due_on::text as due_on,
             st.required, st.evidence_kind, st.status,
             st.done_by::text as done_by, st.skip_reason,
             st.attachment_id::text as attachment_id
        from hrm_process_steps st
        join hrm_processes p on p.org_id = st.org_id and p.id = st.process_id
        join worker_employments e on e.org_id = st.org_id and e.id = p.employment_id
        join parties wp on wp.org_id = st.org_id and wp.id = e.worker_party_id
       where st.org_id = ${orgId} and p.status = 'open' and st.status = 'pending'
         ${
           allowed === null
             ? sql``
             : sql`and e.employer_subsidiary_id in (
           select value::uuid from jsonb_array_elements_text(${JSON.stringify([...allowed])}::jsonb) as _a(value))`
         }
       order by st.due_on, st.position
    `)
    ).rows;
    const overdueSteps: OnboardingOverview["overdueSteps"] = [];
    const dueNextSevenDays: OnboardingOverview["dueNextSevenDays"] = [];
    for (const row of stepRows) {
      const detail = {
        id: row.id,
        position: row.position,
        title: row.title,
        description: row.description,
        ownerKind: row.owner_kind,
        ownerPartyId: row.owner_party_id,
        dueOn: row.due_on,
        required: row.required,
        evidenceKind: row.evidence_kind,
        status: row.status,
        overdue: isStepOverdue({ dueOn: row.due_on, today, status: row.status }),
        doneBy: row.done_by,
        skipReason: row.skip_reason,
        attachmentId: row.attachment_id,
        processId: row.process_id,
        processKind: row.process_kind,
        workerName: row.worker_name,
      };
      if (detail.overdue) {
        overdueSteps.push(detail);
      } else if (row.due_on <= addOffsetDays(today, 7)) {
        dueNextSevenDays.push(detail);
      }
    }
    return { openProcesses, overdueSteps, dueNextSevenDays };
  });
}

export interface OwnStep {
  readonly design: ChecklistStepDesign;
  readonly response: Record<string, unknown> | null;
  readonly approvalStatus: string;
  readonly attachmentId: string | null;
  readonly blocked: boolean;
  readonly processStatus: string;
  readonly id: string;
  readonly processId: string;
  readonly title: string;
  readonly description: string | null;
  readonly dueOn: string;
  readonly required: boolean;
  readonly evidenceKind: string;
  readonly status: string;
  readonly overdue: boolean;
}

/**
 * Self-service read: the employee's own step and nothing else. Owners read
 * the step; strangers (and unknown ids) read NOT_FOUND, so the step's
 * existence cannot be probed through this entry.
 */
export async function getOwnStep(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly stepId: string;
}): Promise<OwnStep> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const stepId = requireId(query.stepId, "stepId");
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    const row = (
      await db.execute<{
        design: unknown;
        response: Record<string, unknown> | null;
        approval_status: string;
        attachment_id: string | null;
        process_status: string;
        id: string;
        process_id: string;
        title: string;
        description: string | null;
        owner_kind: string;
        owner_party_id: string | null;
        due_on: string;
        required: boolean;
        evidence_kind: string;
        status: string;
        employment_id: string;
        worker_party_id: string;
      }>(sql`
      select s.design,s.response,s.approval_status,s.attachment_id,p.status as process_status,s.id, s.process_id::text as process_id, s.title, s.description,
             s.owner_kind, s.owner_party_id::text as owner_party_id,
             s.due_on::text as due_on, s.required, s.evidence_kind, s.status,
             p.employment_id::text as employment_id,
             e.worker_party_id::text as worker_party_id
        from hrm_process_steps s
        join hrm_processes p on p.org_id = s.org_id and p.id = s.process_id
        join worker_employments e on e.org_id = s.org_id and e.id = p.employment_id
       where s.org_id = ${orgId} and s.id = ${stepId}
    `)
    ).rows[0];
    if (!row) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "step not found in this organization — check the step id",
      );
    }
    const actor = await resolveStepActor(db, orgId, actorId, row);
    if (actor !== "owner") {
      throw new HrmProcessError(
        "NOT_FOUND",
        "step not found in this organization — check the step id",
      );
    }
    const today = await businessToday(orgId);
    const design = checklistStepDesignSchema.parse(row.design);
    const blocked =
      (
        await db.execute(
          sql`select id from hrm_process_steps where org_id=${orgId} and process_id=${row.process_id} and status='pending' and template_step_id in(select value::uuid from jsonb_array_elements_text(${JSON.stringify(design.dependencies)}::jsonb) as ids(value)) limit 1`,
        )
      ).rows.length > 0;
    return {
      design,
      response: row.response,
      approvalStatus: row.approval_status,
      attachmentId: row.attachment_id,
      processStatus: row.process_status,
      blocked,
      id: row.id,
      processId: row.process_id,
      title: row.title,
      description: row.description,
      dueOn: row.due_on,
      required: row.required,
      evidenceKind: row.evidence_kind,
      status: row.status,
      overdue: isStepOverdue({ dueOn: row.due_on, today, status: row.status }),
    };
  });
}

/** A workflow link resolves its parent through the canonical scoped checklist read. */
export async function getChecklistForStep(query: {
  orgId: string;
  actorId: string;
  stepId: string;
}): Promise<ProcessDetail> {
  const stepId = requireId(query.stepId, "stepId");
  return withOrgTransaction(query.orgId, async () => {
    const parent = (
      await db.execute<{ process_id: string }>(
        sql`select process_id from hrm_process_steps where org_id=${query.orgId} and id=${stepId}`,
      )
    ).rows[0];
    if (!parent)
      throw new HrmProcessError(
        "NOT_FOUND",
        "Checklist step is no longer visible — open the checklist list.",
      );
    return getProcess({ ...query, processId: parent.process_id });
  });
}
