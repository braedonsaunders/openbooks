import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import {
  requireHrmRecruitingManage,
  requireOwnRequisitionForHiringManager,
} from "../authorization.ts";
import { RecruitingError } from "./errors.ts";
import { assertStageMoveAllowed } from "./funnel.ts";
import { requireActorId, requireId, requireOrgId, requireReason, isUniqueViolation } from "./input.ts";
import { firstStage, loadPipelineTemplate } from "./pipeline.ts";
import { createCandidate, loadCandidate, type CandidateDTO } from "./candidates.ts";
// HR-18 begin: disposition sync for posting-sourced applications (0229).
// Static edge applications→postings only; postings reaches back dynamically,
// so the module graph stays acyclic. recordDispositionForApplication is a
// strict no-op unless the application is posting-sourced and hrmJobBoards
// is on — HR-6 paths are byte-identical with the feature off.
import { recordDispositionForApplication } from "./postings.ts";
// HR-18 end

/**
 * Canonical recruiting application service (HR-6, 0195): one candidacy per
 * (requisition, candidate) moving through the requisition's own funnel.
 * Every transition appends an event in the SAME transaction as the state
 * write — a state without its evidence, or evidence without its state,
 * never commits. Moves are refused to a stage of another template, to the
 * hired stage except through hire, and out of a terminal state.
 */

export const APPLICATION_STATUSES = ["active", "rejected", "withdrawn", "hired"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export interface ApplicationDTO {
  readonly id: string;
  readonly requisitionId: string;
  readonly candidateId: string;
  readonly stageId: string;
  readonly status: ApplicationStatus;
  readonly appliedOn: string;
  readonly rejectedReason: string | null;
  readonly rejectedAt: string | null;
  readonly withdrawnAt: string | null;
  readonly hiredEmploymentId: string | null;
}

type ApplicationRow = {
  id: string;
  requisitionId: string;
  candidateId: string;
  stageId: string;
  status: string;
  appliedOn: string;
  rejectedReason: string | null;
  rejectedAt: string | null;
  withdrawnAt: string | null;
  hiredEmploymentId: string | null;
};

const APPLICATION_COLUMNS = sql`
  id, requisition_id as "requisitionId", candidate_id as "candidateId",
  stage_id as "stageId", status, applied_on as "appliedOn",
  rejected_reason as "rejectedReason", rejected_at as "rejectedAt",
  withdrawn_at as "withdrawnAt", hired_employment_id as "hiredEmploymentId"
`;

function toDTO(row: ApplicationRow): ApplicationDTO {
  if (!(APPLICATION_STATUSES as readonly string[]).includes(row.status)) {
    throw new RecruitingError("REFUSED", `application ${row.id} carries unknown status ${row.status} — refusing a lifecycle the service cannot resolve`);
  }
  return { ...row, status: row.status as ApplicationStatus };
}

export async function loadApplication(
  exec: SqlExecutor,
  orgId: string,
  applicationId: string,
): Promise<ApplicationRow | null> {
  return (await exec.execute<ApplicationRow>(sql`
    select ${APPLICATION_COLUMNS} from hrm_applications
     where org_id = ${orgId} and id = ${applicationId}
  `)).rows[0] ?? null;
}

async function loadApplicationForUpdate(
  exec: SqlExecutor,
  orgId: string,
  applicationId: string,
): Promise<ApplicationRow> {
  const row = (await exec.execute<ApplicationRow>(sql`
    select ${APPLICATION_COLUMNS} from hrm_applications
     where org_id = ${orgId} and id = ${applicationId} for update
  `)).rows[0];
  if (!row) {
    throw new RecruitingError("NOT_FOUND", "application is not visible in this organization");
  }
  return row;
}

/** Append one funnel event in the caller's transaction (never standalone). */
export async function appendApplicationEvent(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string | null;
    applicationId: string;
    kind: string;
    fromStageId?: string | null;
    toStageId?: string | null;
    reason?: string | null;
  },
): Promise<void> {
  const inserted = (await exec.execute<{ id: string }>(sql`
    insert into hrm_application_events
      (org_id, application_id, kind, from_stage_id, to_stage_id, reason, actor_id)
    values (${args.orgId}, ${args.applicationId}, ${args.kind},
            ${args.fromStageId ?? null}, ${args.toStageId ?? null},
            ${args.reason ?? null}, ${args.actorId})
    returning id
  `)).rows[0];
  if (!inserted) {
    throw new RecruitingError("REFUSED", "the funnel event was not recorded — no row was written; retry the request");
  }
}

/**
 * Move authority over an application: the org-wide manage grant, or the
 * hiring manager on their own requisition. Terminal funnel decisions
 * (attach, reject, withdraw) are NOT covered here — they need the grant in
 * full. Either refusal names the same remedy.
 */
async function requireApplicationMove(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  requisitionId: string,
): Promise<void> {
  try {
    await requireHrmRecruitingManage(exec, orgId, actorId, requisitionId);
  } catch {
    await requireOwnRequisitionForHiringManager(exec, orgId, actorId, requisitionId);
  }
}

export interface CreateApplicationQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requisitionId: string;
  readonly candidateId: string;
  /** Set when createCandidate merged into a survivor: recorded as evidence. */
  readonly merged?: boolean;
}

/**
 * Attach a candidate to an open requisition at the funnel's first stage.
 * The requisition must be open and the candidate must exist; the pair is
 * unique per (requisition, candidate) — a second attach is refused by name
 * (storage backstops the race with the unique index).
 */
export async function createApplication(query: CreateApplicationQuery): Promise<ApplicationDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requisitionId = requireId(query.requisitionId, "requisitionId");
  const candidateId = requireId(query.candidateId, "candidateId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManage(db, orgId, actorId, requisitionId);
    const requisition = (await db.execute<{ status: string; pipelineTemplateId: string | null }>(sql`
      select status, pipeline_template_id as "pipelineTemplateId"
        from hrm_requisitions where org_id = ${orgId} and id = ${requisitionId}
    `)).rows[0];
    if (!requisition) {
      throw new RecruitingError("NOT_FOUND", "requisition is not visible in this organization");
    }
    if (requisition.status !== "open") {
      throw new RecruitingError(
        "BAD_STATE",
        `a ${requisition.status} requisition takes no new candidates — open it before attaching applications`,
      );
    }
    const candidate = await loadCandidate(db, orgId, candidateId);
    if (!candidate) {
      throw new RecruitingError("NOT_FOUND", "candidate is not visible in this organization — check the reference");
    }
    if (!requisition.pipelineTemplateId) {
      throw new RecruitingError(
        "REFUSED",
        "the requisition names no pipeline — open it (which names the default funnel) before attaching applications",
      );
    }
    const template = await loadPipelineTemplate(db, orgId, requisition.pipelineTemplateId);
    if (!template) {
      throw new RecruitingError("REFUSED", "the requisition's pipeline is gone — re-open the requisition onto a live funnel first");
    }
    const start = firstStage(template);
    const today = (await db.execute<{ today: string }>(sql`select current_date::text as today`)).rows[0]!.today;
    let inserted: ApplicationRow | undefined;
    try {
      inserted = (await db.execute<ApplicationRow>(sql`
        insert into hrm_applications
          (org_id, requisition_id, candidate_id, stage_id, status, applied_on, created_by, updated_by)
        values (${orgId}, ${requisitionId}, ${candidateId}, ${start.id}, 'active', ${today}::date, ${actorId}, ${actorId})
        returning ${APPLICATION_COLUMNS}
      `)).rows[0];
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RecruitingError(
          "REFUSED",
          "this candidate is already attached to the requisition — move the existing application instead of attaching twice",
        );
      }
      throw error;
    }
    if (!inserted) {
      throw new RecruitingError("REFUSED", "the application was not stored — no row was written; retry the request");
    }
    await appendApplicationEvent(db, {
      orgId,
      actorId,
      applicationId: inserted.id,
      kind: query.merged === true ? "merged" : "applied",
      toStageId: start.id,
      reason:
        query.merged === true
          ? "duplicate email merged into the existing candidate; the application attaches to the survivor"
          : null,
    });
    return toDTO(inserted);
  });
}

export interface AttachCandidateQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly requisitionId: string;
  readonly displayName: unknown;
  readonly email?: unknown;
  readonly phone?: unknown;
  readonly mergeInto?: unknown;
}

export interface AttachCandidateResult {
  readonly candidate: CandidateDTO;
  /** Set when createCandidate merged into a survivor: the application attaches to the survivor. */
  readonly mergedInto: CandidateDTO | null;
  readonly application: ApplicationDTO;
}

/**
 * Attach a prospect to an open requisition in ONE transaction: the
 * candidate row (or email-dedupe merge) and the application row commit
 * together. A failed attach stores nothing — the prospect is never
 * orphaned without an application, which the old two-POST island could
 * leave behind when the second POST failed.
 */
export async function attachCandidate(query: AttachCandidateQuery): Promise<AttachCandidateResult> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const requisitionId = requireId(query.requisitionId, "requisitionId");
  return withOrgTransaction(orgId, async () => {
    const { candidate, mergedInto } = await createCandidate({
      orgId,
      actorId,
      displayName: query.displayName,
      email: query.email,
      phone: query.phone,
      mergeInto: query.mergeInto,
    });
    const survivor = mergedInto ?? candidate;
    const application = await createApplication({
      orgId,
      actorId,
      requisitionId,
      candidateId: survivor.id,
      ...(mergedInto ? { merged: true } : {}),
    });
    return { candidate, mergedInto, application };
  });
}

export interface MoveApplicationStageQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly applicationId: string;
  readonly toStageId: string;
  readonly reason?: unknown;
  /** True only when the move rides the hire transaction. */
  readonly viaHire?: boolean;
}

/**
 * Move an application within its own funnel. Refused across templates, to
 * the hired stage except through hire, and out of a terminal state — each
 * by name, with the remedy in the message.
 */
export async function moveApplicationStage(query: MoveApplicationStageQuery): Promise<ApplicationDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const applicationId = requireId(query.applicationId, "applicationId");
  const toStageId = requireId(query.toStageId, "toStageId");
  const viaHire = query.viaHire === true;
  const reason = query.reason === undefined || query.reason === null ? null : String(query.reason);
  return withOrgTransaction(orgId, async () => {
    const current = await loadApplicationForUpdate(db, orgId, applicationId);
    await requireApplicationMove(db, orgId, actorId, current.requisitionId);
    const requisition = (await db.execute<{ pipelineTemplateId: string | null }>(sql`
      select pipeline_template_id as "pipelineTemplateId"
        from hrm_requisitions where org_id = ${orgId} and id = ${current.requisitionId}
    `)).rows[0];
    if (!requisition?.pipelineTemplateId) {
      throw new RecruitingError("REFUSED", "the requisition's pipeline is gone — re-open the requisition onto a live funnel first");
    }
    const template = await loadPipelineTemplate(db, orgId, requisition.pipelineTemplateId);
    if (!template) {
      throw new RecruitingError("REFUSED", "the requisition's pipeline is gone — re-open the requisition onto a live funnel first");
    }
    const fromStage = template.stages.find((stage) => stage.id === current.stageId) ?? null;
    const toStage = template.stages.find((stage) => stage.id === toStageId) ?? null;
    try {
      assertStageMoveAllowed({
        fromStatus: current.status,
        fromIsTerminal: fromStage?.isTerminal ?? true,
        toKind: toStage?.kind ?? "unknown",
        toIsTerminal: toStage?.isTerminal ?? true,
        sameTemplate: toStage !== null,
        viaHire,
      });
    } catch (error) {
      throw new RecruitingError("REFUSED", error instanceof Error ? error.message : String(error));
    }
    if (fromStage && fromStage.id === toStage!.id) {
      throw new RecruitingError("BAD_STATE", "the application already sits on that stage — move it to a different stage");
    }
    const updated = (await db.execute<ApplicationRow>(sql`
      update hrm_applications
         set stage_id = ${toStageId}, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${applicationId} and status = 'active'
      returning ${APPLICATION_COLUMNS}
    `)).rows[0];
    if (!updated) {
      throw new RecruitingError(
        "STALE_REVISION",
        "the application changed while moving — reload it and try again",
      );
    }
    await appendApplicationEvent(db, {
      orgId,
      actorId,
      applicationId,
      kind: "stage_changed",
      fromStageId: current.stageId,
      toStageId,
      reason,
    });
    // HR-18: disposition sync for posting-sourced applications (no-op otherwise).
    await recordDispositionForApplication(db, { orgId, applicationId });
    return toDTO(updated);
  });
}

export interface RejectApplicationQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly applicationId: string;
  readonly reason: unknown;
}

/** Reject with a reason — the funnel end for this candidacy, recorded as evidence. */
export async function rejectApplication(query: RejectApplicationQuery): Promise<ApplicationDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const applicationId = requireId(query.applicationId, "applicationId");
  const reason = requireReason(query.reason);
  return withOrgTransaction(orgId, async () => {
    const current = await loadApplicationForUpdate(db, orgId, applicationId);
    await requireHrmRecruitingManage(db, orgId, actorId, current.requisitionId);
    if (current.status !== "active") {
      throw new RecruitingError(
        "BAD_STATE",
        `a ${current.status} application cannot be rejected — only active candidacies reject`,
      );
    }
    const updated = (await db.execute<ApplicationRow>(sql`
      update hrm_applications
         set status = 'rejected', rejected_reason = ${reason}, rejected_at = now(),
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${applicationId} and status = 'active'
      returning ${APPLICATION_COLUMNS}
    `)).rows[0];
    if (!updated) {
      throw new RecruitingError("STALE_REVISION", "the application changed while rejecting — reload it and try again");
    }
    await appendApplicationEvent(db, {
      orgId,
      actorId,
      applicationId,
      kind: "rejected",
      fromStageId: current.stageId,
      reason,
    });
    // HR-18: disposition sync for posting-sourced applications (no-op otherwise).
    await recordDispositionForApplication(db, { orgId, applicationId });
    return toDTO(updated);
  });
}

export interface WithdrawApplicationQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly applicationId: string;
}

/** Withdraw a candidacy (the candidate's own decision; no reason demanded). */
export async function withdrawApplication(query: WithdrawApplicationQuery): Promise<ApplicationDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const applicationId = requireId(query.applicationId, "applicationId");
  return withOrgTransaction(orgId, async () => {
    const current = await loadApplicationForUpdate(db, orgId, applicationId);
    await requireHrmRecruitingManage(db, orgId, actorId, current.requisitionId);
    if (current.status !== "active") {
      throw new RecruitingError(
        "BAD_STATE",
        `a ${current.status} application cannot be withdrawn — only active candidacies withdraw`,
      );
    }
    const updated = (await db.execute<ApplicationRow>(sql`
      update hrm_applications
         set status = 'withdrawn', withdrawn_at = now(),
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${applicationId} and status = 'active'
      returning ${APPLICATION_COLUMNS}
    `)).rows[0];
    if (!updated) {
      throw new RecruitingError("STALE_REVISION", "the application changed while withdrawing — reload it and try again");
    }
    await appendApplicationEvent(db, {
      orgId,
      actorId,
      applicationId,
      kind: "withdrawn",
      fromStageId: current.stageId,
    });
    // HR-18: disposition sync for posting-sourced applications (no-op otherwise).
    await recordDispositionForApplication(db, { orgId, applicationId });
    return toDTO(updated);
  });
}

/**
 * Mark the application hired. Called ONLY from the hire transaction after
 * the change request is filed: the hired stage move rides along (viaHire),
 * so the funnel end and the hire evidence commit together.
 */
export async function markApplicationHired(
  exec: SqlExecutor,
  args: { orgId: string; actorId: string; applicationId: string; employmentId: string; hiredStageId: string },
): Promise<ApplicationDTO> {
  const current = await loadApplicationForUpdate(exec, args.orgId, args.applicationId);
  if (current.status !== "active") {
    throw new RecruitingError(
      "BAD_STATE",
      `a ${current.status} application cannot be hired — only active candidacies hire`,
    );
  }
  const updated = (await exec.execute<ApplicationRow>(sql`
    update hrm_applications
       set status = 'hired', stage_id = ${args.hiredStageId},
           hired_employment_id = ${args.employmentId},
           updated_by = ${args.actorId}, updated_at = now()
     where org_id = ${args.orgId} and id = ${args.applicationId} and status = 'active'
    returning ${APPLICATION_COLUMNS}
  `)).rows[0];
  if (!updated) {
    throw new RecruitingError("REFUSED", "the application changed while hiring — the hire is refused rather than recorded twice");
  }
  await appendApplicationEvent(exec, {
    orgId: args.orgId,
    actorId: args.actorId,
    applicationId: args.applicationId,
    kind: "hired",
    fromStageId: current.stageId,
    toStageId: args.hiredStageId,
  });
  // HR-18: disposition sync for posting-sourced applications (no-op otherwise).
  await recordDispositionForApplication(exec, { orgId: args.orgId, applicationId: args.applicationId });
  return toDTO(updated);
}
