/** Completing and skipping process steps; completing and cancelling processes. */
import {
  checklistStepDesignSchema,
  withComputedFormulas,
  CHECKLIST_STEP_SUBJECT_KIND,
} from "@openbooks/forms-core";
import { cancelDispatchRuns } from "../flows/dispatch-result.ts";
import { lockApprovalSubject } from "../platform/approval-routing.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { actorHasPermission } from "../organization/actor-permissions.ts";
import { HrmAuthorizationError } from "./authorization.ts";
import { requireHrmEmploymentManage, requireHrmProcessManage } from "./authorization.ts";
import {
  HrmProcessError,
  requireOrgId,
  requireActorId,
  requireId,
  requireNonBlank,
  assertHrmFeatureOn,
} from "./process-core.ts";
import {
  loadStepForUpdate,
  loadProcessForUpdate,
  resolveStepActor,
  assertAttachmentReadable,
  auditChecklist,
} from "./process-runtime.ts";
import {
  validateDesignedCompletion,
  submitChecklistStepApproval,
} from "./process-step-approvals.ts";

// --- Complete / skip a step --------------------------------------------------

export interface CompleteStepQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly stepId: string;
  /** Required when the step's evidence_kind is attachment. */
  readonly attachmentId?: string;
  readonly acknowledged?: boolean;
  readonly response?: Record<string, unknown>;
}

/**
 * Complete one pending step. Evidence is enforced by kind: acknowledgement
 * records who (done_by) and when (done_at); attachment needs a file the
 * actor may read; none flips clean. A manager (hrm.process.manage in
 * scope) may complete any step; the employee may complete only their own.
 */
export async function completeProcessStep(
  query: CompleteStepQuery,
): Promise<{ status: "done" | "pending_approval" }> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const stepId = requireId(query.stepId, "stepId");
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await lockApprovalSubject(orgId, CHECKLIST_STEP_SUBJECT_KIND, stepId);
    const step = await loadStepForUpdate(db, orgId, stepId);
    if (step.process_status !== "open") {
      throw new HrmProcessError(
        "BAD_STATE",
        `the process is ${step.process_status} — a ${step.process_status} checklist takes no completions; open a new process for further work`,
      );
    }
    if (step.status !== "pending") {
      throw new HrmProcessError(
        "BAD_STATE",
        `this step is already ${step.status} — completed and skipped steps stand as recorded`,
      );
    }
    const actor = await resolveStepActor(db, orgId, actorId, step);
    if (actor === "stranger") {
      // Permission leg names the remedy; the scope leg stays uniform with
      // unknown ids (the employment-gate shape), so scope cannot be probed.
      if (await actorHasPermission(db, orgId, actorId, "hrm.process.manage")) {
        throw new HrmAuthorizationError(
          "Employment is not visible in this organization and legal-entity scope.",
        );
      }
      throw new HrmProcessError(
        "FORBIDDEN",
        "this step is owned by someone else — ask its owner or a manager to complete it, or hold hrm.process.manage in the employer's scope",
      );
    }
    let reviewed = (
      await db.execute<{
        design: unknown;
        approval_status: string;
        response: Record<string, unknown> | null;
        attachment_id: string | null;
      }>(
        sql`select design,approval_status,response,attachment_id from hrm_process_steps where org_id=${orgId} and id=${stepId}`,
        "objects",
      )
    )[0];
    const design = checklistStepDesignSchema.parse(reviewed?.design ?? {});
    if (design.form && query.response)
      query = { ...query, response: withComputedFormulas(design.form.sections, query.response) };
    if (reviewed?.approval_status !== "approved" && reviewed?.approval_status !== "pending") {
      await submitChecklistStepApproval(query);
      reviewed = (
        await db.execute<{
          design: unknown;
          approval_status: string;
          response: Record<string, unknown> | null;
          attachment_id: string | null;
        }>(
          sql`
        select design,approval_status,response,attachment_id from hrm_process_steps where org_id=${orgId} and id=${stepId}`,
          "objects",
        )
      )[0];
    }
    if (reviewed?.approval_status === "pending") return { status: "pending_approval" as const };
    if (reviewed?.approval_status === "approved") {
      const matches = (
        await db.execute<{ matches: boolean }>(
          sql`select response is not distinct from ${JSON.stringify(query.response ?? null)}::jsonb and attachment_id is not distinct from ${query.attachmentId ?? null}::uuid as matches from hrm_process_steps where org_id=${orgId} and id=${stepId}`,
          "objects",
        )
      )[0]?.matches;
      if (!matches)
        throw new HrmProcessError(
          "REFUSED",
          "The completion evidence differs from the approved submission — use the reviewed response and attachment.",
        );
    }
    await validateDesignedCompletion(db, orgId, actorId, step, query);
    let attachmentId: string | null = null;
    if (step.evidence_kind === "attachment") {
      if (typeof query.attachmentId !== "string" || query.attachmentId.length === 0) {
        throw new HrmProcessError(
          "EVIDENCE_REQUIRED",
          "this step requires attachment evidence — attach a file the completing actor may read",
        );
      }
      await assertAttachmentReadable(db, orgId, actorId, query.attachmentId);
      attachmentId = query.attachmentId;
    } else if (query.attachmentId !== undefined) {
      throw new HrmProcessError(
        "REFUSED",
        `this step takes ${step.evidence_kind} evidence — drop the attachment to complete it`,
      );
    }
    const done = await db.execute(
      sql`
      update hrm_process_steps
         set status = 'done', done_by = ${actorId}, done_at = now(),
             attachment_id = ${attachmentId}, response = ${JSON.stringify(query.response ?? null)}::jsonb, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${stepId} and status = 'pending'
      returning id
    `,
      "objects",
    );
    if (done.length !== 1) {
      throw new HrmProcessError(
        "REFUSED",
        "the step changed while completing — nothing completed; reload the checklist and try again",
      );
    }
    await auditChecklist(
      db,
      orgId,
      actorId,
      step.process_id,
      "step_completed",
      {
        stepId,
        status: "pending",
        response: reviewed?.response ?? null,
        attachmentId: reviewed?.attachment_id ?? null,
      },
      { stepId, status: "done", response: query.response ?? null, attachmentId },
      "Completed checklist evidence.",
      "hrm_processes",
    );
    return { status: "done" as const };
  });
}

export interface SkipStepQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly stepId: string;
  readonly reason: unknown;
}

/**
 * Skip one pending step with a reason (storage pins every skip to a
 * non-blank reason — reasonless history is not evidence). Skipping a
 * REQUIRED step needs hrm.employment.manage in scope; optional steps take
 * the manager or the owner.
 */
export async function skipProcessStep(query: SkipStepQuery): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const stepId = requireId(query.stepId, "stepId");
  const reason = requireNonBlank("reason", query.reason);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await lockApprovalSubject(orgId, CHECKLIST_STEP_SUBJECT_KIND, stepId);
    const step = await loadStepForUpdate(db, orgId, stepId);
    if (step.process_status !== "open") {
      throw new HrmProcessError(
        "BAD_STATE",
        `the process is ${step.process_status} — a ${step.process_status} checklist takes no skips; open a new process for further work`,
      );
    }
    if (step.status !== "pending") {
      throw new HrmProcessError(
        "BAD_STATE",
        `this step is already ${step.status} — completed and skipped steps stand as recorded`,
      );
    }
    if (step.required) {
      // Authority first, in-transaction: the employment.manage gate carries
      // the permission plus the employer scope.
      await requireHrmEmploymentManage(db, orgId, actorId, step.employment_id);
    } else {
      const actor = await resolveStepActor(db, orgId, actorId, step);
      if (actor === "stranger") {
        if (await actorHasPermission(db, orgId, actorId, "hrm.process.manage")) {
          throw new HrmAuthorizationError(
            "Employment is not visible in this organization and legal-entity scope.",
          );
        }
        throw new HrmProcessError(
          "FORBIDDEN",
          "this step is owned by someone else — ask its owner or a manager to skip it, or hold hrm.process.manage in the employer's scope",
        );
      }
    }
    const waitingRuns = await db.execute<{ id: string }>(
      sql`select id from flow_runs where org_id=${orgId} and subject_kind=${CHECKLIST_STEP_SUBJECT_KIND} and subject_id=${stepId} and status in ('running','waiting')`,
      "objects",
    );
    await cancelDispatchRuns(
      orgId,
      waitingRuns.map((r) => r.id),
      { actorId },
    );
    const skipped = await db.execute(
      sql`
      update hrm_process_steps
         set status = 'skipped', skip_reason = ${reason},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${stepId} and status = 'pending'
      returning id
    `,
      "objects",
    );
    if (skipped.length !== 1) {
      throw new HrmProcessError(
        "REFUSED",
        "the step changed while skipping — nothing skipped; reload the checklist and try again",
      );
    }
    await auditChecklist(
      db,
      orgId,
      actorId,
      step.process_id,
      "step_skipped",
      { stepId, status: "pending" },
      { stepId, status: "skipped", skipReason: reason },
      reason,
      "hrm_processes",
    );
  });
}

// --- Complete / cancel a process ---------------------------------------------

export async function completeProcess(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly processId: string;
}): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const processId = requireId(query.processId, "processId");
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    const process = await loadProcessForUpdate(db, orgId, processId);
    if (process.status !== "open") {
      throw new HrmProcessError(
        "BAD_STATE",
        `the process is already ${process.status} — ${process.status} checklists stay as recorded`,
      );
    }
    await requireHrmProcessManage(db, orgId, actorId, process.employment_id);
    const pending = await db.execute<{ title: string }>(
      sql`
      select title from hrm_process_steps
       where org_id = ${orgId} and process_id = ${processId}
         and required and status = 'pending'
       order by position
    `,
      "objects",
    );
    if (pending.length > 0) {
      const names = pending
        .slice(0, 3)
        .map((row) => JSON.stringify(row.title))
        .join(", ");
      const more = pending.length > 3 ? ` and ${pending.length - 3} more` : "";
      throw new HrmProcessError(
        "REFUSED",
        `${pending.length} required step(s) still pending (${names}${more}) — complete or skip them before completing the process`,
      );
    }
    const completed = await db.execute(
      sql`
      update hrm_processes
         set status = 'completed', completed_at = now(),
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${processId} and status = 'open'
      returning id
    `,
      "objects",
    );
    if (completed.length !== 1) {
      throw new HrmProcessError(
        "REFUSED",
        "the process left the open state while completing — nothing completed; reload it and try again",
      );
    }
    await auditChecklist(
      db,
      orgId,
      actorId,
      processId,
      "completed",
      { status: "open" },
      { status: "completed" },
      "All required checklist work was completed or explicitly skipped.",
      "hrm_processes",
    );
  });
}

export async function cancelProcess(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly processId: string;
  readonly reason: unknown;
}): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const processId = requireId(query.processId, "processId");
  const reason = requireNonBlank("reason", query.reason);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    const stepIds = await db.execute<{ id: string }>(
      sql`select id from hrm_process_steps where org_id=${orgId} and process_id=${processId} order by id`,
      "objects",
    );
    for (const step of stepIds)
      await lockApprovalSubject(orgId, CHECKLIST_STEP_SUBJECT_KIND, step.id);
    const process = await loadProcessForUpdate(db, orgId, processId);
    if (process.status !== "open") {
      throw new HrmProcessError(
        "BAD_STATE",
        `the process is already ${process.status} — ${process.status} checklists stay as recorded`,
      );
    }
    await requireHrmProcessManage(db, orgId, actorId, process.employment_id);
    const runs = await db.execute<{ id: string }>(
      sql`select id from flow_runs where org_id=${orgId} and subject_kind=${CHECKLIST_STEP_SUBJECT_KIND} and subject_id in (select id from hrm_process_steps where org_id=${orgId} and process_id=${processId}) and status in ('running','waiting')`,
      "objects",
    );
    await cancelDispatchRuns(
      orgId,
      runs.map((r) => r.id),
      { actorId },
    );
    const cancelled = await db.execute(
      sql`
      update hrm_processes
         set status = 'cancelled', cancelled_at = now(), cancel_reason = ${reason},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${processId} and status = 'open'
      returning id
    `,
      "objects",
    );
    if (cancelled.length !== 1) {
      throw new HrmProcessError(
        "REFUSED",
        "the process left the open state while cancelling — nothing cancelled; reload it and try again",
      );
    }
    await auditChecklist(
      db,
      orgId,
      actorId,
      processId,
      "cancelled",
      { status: "open" },
      { status: "cancelled" },
      reason,
      "hrm_processes",
    );
  });
}
