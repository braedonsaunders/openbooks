/** Designed-step completion validation and checklist step approvals. */
import {
  checklistStepDesignSchema,
  validateResponse,
  splitRecordData,
  withComputedFormulas,
  CHECKLIST_STEP_SUBJECT_KIND,
} from "@openbooks/forms-core";
import { lockApprovalSubject } from "../platform/approval-routing.ts";
import { completedGateAllowsSelfApproval } from "../flows/approval-decision-policy.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { requireHrmProcessManage } from "./authorization.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  HrmProcessError,
  requireOrgId,
  requireActorId,
  requireId,
  assertHrmFeatureOn,
} from "./process-core.ts";
import {
  type StepRow,
  loadStepForUpdate,
  resolveStepActor,
  assertAttachmentReadable,
  auditChecklist,
} from "./process-runtime.ts";
import { type CompleteStepQuery } from "./process-step-execution.ts";

export async function validateDesignedCompletion(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  step: StepRow,
  query: CompleteStepQuery,
  submitting = false,
) {
  const row = (
    await exec.execute<{ design: unknown; approval_status: string }>(
      sql`select design,approval_status from hrm_process_steps where org_id=${orgId} and id=${step.id}`,
      "objects",
    )
  )[0];
  if (!row)
    throw new HrmProcessError(
      "NOT_FOUND",
      "Checklist step is no longer visible — reload the checklist.",
    );
  const design = checklistStepDesignSchema.parse(row.design ?? {});
  const pending = await exec.execute<{ title: string }>(
    sql`select title from hrm_process_steps where org_id=${orgId} and process_id=${step.process_id} and template_step_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(design.dependencies)}::jsonb) as deps(value)) and status='pending' order by position`,
    "objects",
  );
  const dependencyCount = (
    await exec.execute<{ count: number }>(
      sql`select count(*)::int as count from hrm_process_steps where org_id=${orgId} and process_id=${step.process_id} and template_step_id in(select value::uuid from jsonb_array_elements_text(${JSON.stringify(design.dependencies)}::jsonb) as ids(value))`,
      "objects",
    )
  )[0]?.count;
  if (dependencyCount !== design.dependencies.length)
    throw new HrmProcessError(
      "REFUSED",
      "A prerequisite is missing from this checklist — ask HR to cancel it and open a corrected checklist from a published template.",
    );
  if (pending.length)
    throw new HrmProcessError(
      "REFUSED",
      `Complete prerequisite steps first: ${pending.map((s) => s.title).join(", ")}.`,
    );
  if (
    step.evidence_kind === "acknowledgement" &&
    Object.keys((row.design ?? {}) as object).length &&
    query.acknowledged !== true
  )
    throw new HrmProcessError(
      "EVIDENCE_REQUIRED",
      "Confirm that you reviewed these instructions before completing this step.",
    );
  if (design.form) {
    const computed = withComputedFormulas(design.form.sections, query.response ?? {});
    const { values, rows } = splitRecordData(design.form.sections, computed);
    const errors = validateResponse(design.form, values, rows);
    for (const section of design.form.sections)
      for (const field of section.fields) {
        if (field.type !== "party" && field.type !== "gl_account") continue;
        const sources = section.repeating ? (rows[section.id] ?? []) : [values];
        for (const source of sources) {
          const value = source[field.id];
          if (value === null || value === undefined || value === "") continue;
          if (typeof value !== "string" || !isUuid(value))
            throw new HrmProcessError(
              "EVIDENCE_REQUIRED",
              `Choose a valid reference for ${field.label} from its picker.`,
            );
          const target = (
            await exec.execute(
              sql`select id from ${sql.identifier(field.type === "party" ? "parties" : "accounts")} where org_id=${orgId} and id=${value} and is_active`,
              "objects",
            )
          )[0];
          if (!target)
            throw new HrmProcessError(
              "EVIDENCE_REQUIRED",
              `${field.label} is not available in this organization — choose an active reference from its picker.`,
            );
        }
      }
    if (errors.length)
      throw new HrmProcessError(
        "EVIDENCE_REQUIRED",
        `Complete the form: ${errors.map((e) => `${design.form!.sections.flatMap((s) => s.fields).find((f) => f.id === e.fieldId)?.label ?? e.fieldId}: ${e.message}`).join(" ")}.`,
      );
  } else if (query.response && Object.keys(query.response).length)
    throw new HrmProcessError(
      "REFUSED",
      "This step does not collect a form response — remove the response before completing it.",
    );
  if (!submitting && row.approval_status !== "approved")
    throw new HrmProcessError(
      "REFUSED",
      "This step requires approval — submit it for review and wait for the configured approvers before completing it.",
    );
}

export async function submitChecklistStepApproval(query: CompleteStepQuery): Promise<void> {
  const orgId = requireOrgId(query.orgId),
    actorId = requireActorId(query.actorId),
    id = requireId(query.stepId, "stepId");
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await lockApprovalSubject(orgId, CHECKLIST_STEP_SUBJECT_KIND, id);
    const step = await loadStepForUpdate(db, orgId, id);
    if ((await resolveStepActor(db, orgId, actorId, step)) === "stranger")
      throw new HrmProcessError(
        "FORBIDDEN",
        "Submit only your own checklist step, or ask a scoped HR manager to submit it.",
      );
    if (step.process_status !== "open" || step.status !== "pending")
      throw new HrmProcessError(
        "BAD_STATE",
        "Only a pending step on an open checklist can be submitted.",
      );
    const row = (
      await db.execute<{
        design: unknown;
        approval_status: string;
        response: unknown;
        attachment_id: string | null;
      }>(
        sql`select design,approval_status,response,attachment_id from hrm_process_steps where org_id=${orgId} and id=${id}`,
        "objects",
      )
    )[0];
    if (!row)
      throw new HrmProcessError("NOT_FOUND", "Checklist step not found — reload the checklist.");
    const design = checklistStepDesignSchema.parse(row.design);
    if (row.approval_status === "pending" || row.approval_status === "approved")
      throw new HrmProcessError(
        "BAD_STATE",
        "This evidence has already been submitted — review its approval state before taking another action.",
      );
    if (design.form && query.response)
      query = { ...query, response: withComputedFormulas(design.form.sections, query.response) };
    // Validate the same evidence as completion, withholding only the approval check.
    await validateDesignedCompletion(db, orgId, actorId, step, { ...query }, true);
    if (query.attachmentId && step.evidence_kind !== "attachment")
      throw new HrmProcessError(
        "REFUSED",
        "This step does not collect a file — remove the attachment before submitting it.",
      );
    if (step.evidence_kind === "attachment") {
      if (!query.attachmentId)
        throw new HrmProcessError(
          "EVIDENCE_REQUIRED",
          "Attach the supporting file before submitting this step for approval.",
        );
      await assertAttachmentReadable(db, orgId, actorId, query.attachmentId);
    }
    const prepared = await db.execute(
      sql`update hrm_process_steps set submitted_by=${actorId},submitted_at=now(),response=${JSON.stringify(query.response ?? null)}::jsonb,attachment_id=${query.attachmentId ?? null},approval_status='pending',updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${id} and status='pending' returning id`,
      "objects",
    );
    if (prepared.length !== 1)
      throw new HrmProcessError(
        "REFUSED",
        "The step changed during submission — reload and retry.",
      );
    const { routeSubjectSubmission } = await import("../flows/submission-policy.ts");
    const { policy, dispatch, submissionId } = await routeSubjectSubmission({
      orgId,
      actorId,
      subjectKind: CHECKLIST_STEP_SUBJECT_KIND,
      subjectId: id,
    });
    const gated = dispatch.runs.find((run) => run.gatesCreated > 0);
    const stored = await db.execute(
      sql`update hrm_process_steps set flow_run_id=${gated?.runId ?? null},approval_status=${policy.kind === "gated" ? "pending" : "approved"} where org_id=${orgId} and id=${id} and approval_status='pending' returning id`,
      "objects",
    );
    if (stored.length !== 1)
      throw new HrmProcessError(
        "REFUSED",
        "Approval evidence was not stored — nothing was submitted.",
      );
    await auditChecklist(
      db,
      orgId,
      actorId,
      step.process_id,
      "step_submitted",
      {
        stepId: id,
        approvalStatus: row.approval_status,
        response: row.response,
        attachmentId: row.attachment_id,
      },
      {
        stepId: id,
        submissionId,
        policy,
        runId: gated?.runId ?? null,
        approvalStatus: policy.kind === "gated" ? "pending" : "approved",
        response: query.response ?? null,
        attachmentId: query.attachmentId ?? null,
      },
      "Submitted checklist evidence for native workflow approval.",
      "hrm_processes",
    );
  });
}

export async function releaseChecklistStepApproval(args: {
  approvalRunId?: string;
  subjectId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
  ctx: { orgId: string; userId?: string | null };
}): Promise<void> {
  const { orgId, userId } = args.ctx,
    actorId = requireActorId(userId);
  await assertHrmFeatureOn(db, orgId);
  const step = await loadStepForUpdate(db, orgId, args.subjectId);
  await requireHrmProcessManage(db, orgId, actorId, step.employment_id);
  const row = (
    await db.execute<{ approval_status: string; submitted_by: string; flow_run_id: string | null }>(
      sql`select approval_status,submitted_by,flow_run_id from hrm_process_steps where org_id=${orgId} and id=${step.id}`,
      "objects",
    )
  )[0];
  if (row?.approval_status !== "pending") return;
  if (step.process_status !== "open" || step.status !== "pending")
    throw new HrmProcessError(
      "BAD_STATE",
      "This checklist no longer accepts approval decisions — cancel the outstanding gate through its workflow controls.",
    );
  if (
    row.submitted_by === actorId &&
    !(await completedGateAllowsSelfApproval(db, {
      orgId,
      subjectKind: CHECKLIST_STEP_SUBJECT_KIND,
      subjectId: step.id,
      approvalRunId: args.approvalRunId,
      actorId,
      outcome: args.outcome,
    }))
  )
    throw new HrmProcessError(
      "FORBIDDEN",
      "The submitted Flow policy requires another authorized approver for this checklist evidence.",
    );
  const changed = await db.execute(
    sql`update hrm_process_steps set approval_status=${args.outcome},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${step.id} and approval_status='pending' returning id`,
    "objects",
  );
  if (changed.length !== 1)
    throw new HrmProcessError(
      "REFUSED",
      "The approval state changed — reload the worklist before deciding.",
    );
  await auditChecklist(
    db,
    orgId,
    actorId,
    step.process_id,
    "step_" + args.outcome,
    { approvalStatus: "pending" },
    { stepId: step.id, approvalStatus: args.outcome, approvalRunId: args.approvalRunId ?? null },
    args.comment?.trim() || "Native checklist approval decision.",
    "hrm_processes",
  );
}
