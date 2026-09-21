import { sql } from "drizzle-orm";
import { requireHrmCertificationsRead } from "../authorization.ts";
import { businessToday } from "../../platform/business-date.ts";
import { HrmQualificationError } from "./errors.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import {
  HRM_CERTIFICATIONS_FEATURE,
  HRM_DISPATCH_GATING_FEATURE,
  assertQualificationsFeature,
  projectDerivedStatus,
  requireDate,
  requireId,
  type DerivedQualificationStatus,
  type SqlExecutor,
  type StoredQualificationStatus,
} from "./shared.ts";
import type { RequirementSubjectKind, RequirementSeverity } from "./requirements.ts";

/**
 * Dispatch gating (HR-14): can this person be on that job today?
 *
 * checkAssignment answers over the requirements on a subject (project,
 * equipment, position, classification) and the employment's held
 * qualifications as of `on`. A block severity lands in blocking (the
 * caller refuses the assignment BY NAME with the list); a warn severity
 * lands in warnings (the caller lets it through, records a warned event
 * against the deficient qualification via noteWarnedDispatch, and shows
 * the warning). Time already worked is never blocked: field-ticket crew
 * rows and timesheet entries use the read-only verdict as a chip, and a
 * worker who worked unqualified is a finding for HR-13's compliance
 * findings where that feature is on, else a warning chip.
 */

export type GateVerdictReason = "missing" | "expired" | "pending";

export interface GateFinding {
  readonly typeId: string;
  readonly typeCode: string;
  readonly typeName: string;
  readonly severity: RequirementSeverity;
  readonly reason: GateVerdictReason;
  /** The deficient qualification, when one exists to attach to. */
  readonly qualificationId: string | null;
  readonly detail: string;
}

export type GateVerdict = { ok: true; warnings: GateFinding[] } | { ok: false; blocking: GateFinding[]; warnings: GateFinding[] };

export interface CheckAssignmentInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly subjectKind: RequirementSubjectKind;
  readonly subjectId: string;
  /** YYYY-MM-DD as-of; defaults to the org's business today. */
  readonly on?: string;
}

type ApplicableRequirement = {
  type_id: string;
  type_code: string;
  type_name: string;
  renewal_lead_days: number;
  severity: RequirementSeverity;
};

type HeldRow = {
  id: string;
  type_id: string;
  status: StoredQualificationStatus;
  expires_on: string | null;
  issued_on: string;
};

/**
 * Read-only gate (read grant): the scheduling path, field-ticket crew
 * rows, timesheet chips and the check API all read through here. Warn
 * events are written separately by noteWarnedDispatch inside the
 * caller's own transaction — a read never writes.
 */
export async function checkAssignment(
  exec: SqlExecutor,
  input: CheckAssignmentInput,
): Promise<GateVerdict> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const employmentId = requireId(input.employmentId, "employmentId");
  const subjectId = requireId(input.subjectId, "subjectId");
  const subjectKind = input.subjectKind;
  await requireHrmCertificationsRead(exec, orgId, actorId);
  await assertQualificationsFeature(exec, orgId, HRM_CERTIFICATIONS_FEATURE, "Dispatch gating");
  const on = input.on ? requireDate(input.on, "on") : await businessToday(orgId);
  return checkAssignmentInternal(exec, orgId, employmentId, subjectKind, subjectId, on);
}

export interface CheckAssignmentTrustedInput {
  readonly orgId: string;
  readonly employmentId: string;
  readonly subjectKind: RequirementSubjectKind;
  readonly subjectId: string;
  readonly on: string;
}

/**
 * Trusted gate for the scheduling write path (no per-actor grant — see
 * ScheduleGateInput.trusted). Feature assert stays; the verdict scopes
 * to the single assigned employment.
 */
export async function checkAssignmentTrusted(
  exec: SqlExecutor,
  input: CheckAssignmentTrustedInput,
): Promise<GateVerdict> {
  const orgId = requireId(input.orgId, "orgId");
  const employmentId = requireId(input.employmentId, "employmentId");
  const subjectId = requireId(input.subjectId, "subjectId");
  const on = requireDate(input.on, "on");
  await assertQualificationsFeature(exec, orgId, HRM_CERTIFICATIONS_FEATURE, "Dispatch gating");
  return checkAssignmentInternal(exec, orgId, employmentId, input.subjectKind, subjectId, on);
}

export async function checkAssignmentInternal(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  subjectKind: RequirementSubjectKind,
  subjectId: string,
  on: string,
): Promise<GateVerdict> {
  const requirements = (await exec.execute<ApplicableRequirement>(sql`
    select r.type_id::text as type_id, t.code as type_code, t.name as type_name,
           t.renewal_lead_days, r.severity
      from hrm_qualification_requirements r
      join hrm_qualification_types t
        on t.org_id = r.org_id and t.id = r.type_id and t.is_active
     where r.org_id = ${orgId}::uuid
       and r.subject_kind = ${subjectKind}
       and r.subject_id = ${subjectId}::uuid
       and r.required_from <= ${on}::date
       and (r.required_to is null or r.required_to >= ${on}::date)
     order by t.code
  `)).rows;
  if (requirements.length === 0) return { ok: true, warnings: [] };
  const held = (await exec.execute<HeldRow>(sql`
    select q.id::text as id, q.type_id::text as type_id, q.status,
           q.expires_on::text, q.issued_on::text
      from hrm_worker_qualifications q
     where q.org_id = ${orgId}::uuid and q.employment_id = ${employmentId}::uuid
     order by q.issued_on desc
  `)).rows;
  const blocking: GateFinding[] = [];
  const warnings: GateFinding[] = [];
  for (const req of requirements) {
    const candidates = held.filter((h) => h.type_id === req.type_id);
    const finding = evaluateRequirement(req, candidates, on);
    if (!finding) continue;
    if (req.severity === "block") blocking.push(finding);
    else warnings.push(finding);
  }
  if (blocking.length > 0) return { ok: false, blocking, warnings };
  return { ok: true, warnings };
}

function evaluateRequirement(
  req: ApplicableRequirement,
  candidates: HeldRow[],
  on: string,
): GateFinding | null {
  if (candidates.length === 0) {
    return {
      typeId: req.type_id,
      typeCode: req.type_code,
      typeName: req.type_name,
      severity: req.severity,
      reason: "missing",
      qualificationId: null,
      detail: `${req.type_name} is required and the worker holds no ${req.type_code} qualification — record one before dispatching.`,
    };
  }
  // The strongest credential decides: valid first, then expiring,
  // then pending, then expired. A revoked row is not a credential.
  const live = candidates.filter((c) => c.status !== "revoked");
  if (live.length === 0) {
    return {
      typeId: req.type_id,
      typeCode: req.type_code,
      typeName: req.type_name,
      severity: req.severity,
      reason: "missing",
      qualificationId: null,
      detail: `${req.type_name} was revoked — record a new ${req.type_code} qualification before dispatching.`,
    };
  }
  const projected: { row: HeldRow; status: DerivedQualificationStatus }[] = live.map((row) => ({
    row,
    status: projectDerivedStatus({ stored: row.status, expiresOn: row.expires_on, leadDays: req.renewal_lead_days, today: on }),
  }));
  const rank = (s: DerivedQualificationStatus) =>
    s === "valid" ? 0 : s === "expiring" ? 1 : s === "pending_verification" ? 2 : 3;
  projected.sort((a, b) => rank(a.status) - rank(b.status));
  const best = projected[0];
  // Unreachable: live is non-empty above, so projected is non-empty.
  if (!best) return null;
  if (best.status === "valid" || best.status === "expiring") return null;
  if (best.status === "pending_verification") {
    return {
      typeId: req.type_id,
      typeCode: req.type_code,
      typeName: req.type_name,
      severity: req.severity,
      reason: "pending",
      qualificationId: best.row.id,
      detail: `${req.type_name} is recorded but pending verification — HR must verify it before dispatch counts as qualified.`,
    };
  }
  return {
    typeId: req.type_id,
    typeCode: req.type_code,
    typeName: req.type_name,
    severity: req.severity,
    reason: "expired",
    qualificationId: best.row.id,
    detail: `${req.type_name} expired ${best.row.expires_on} — renew it before dispatching.`,
  };
}

export interface NoteWarnedDispatchInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly warnings: readonly GateFinding[];
  readonly context: string;
}

/**
 * Record a warn-severity dispatch that proceeded anyway: one warned
 * event per deficient qualification (missing credentials have no row
 * to attach to, so they stay display-only). Runs inside the caller's
 * transaction — the assignment and its warning commit together.
 */
export async function noteWarnedDispatch(
  exec: SqlExecutor,
  input: NoteWarnedDispatchInput,
): Promise<void> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const context = input.context.trim() || "dispatch";
  for (const warning of input.warnings) {
    if (!warning.qualificationId) continue;
    const inserted = (await exec.execute<{ id: string }>(sql`
      insert into hrm_qualification_events
        (org_id, qualification_id, kind, actor_id, reason)
      values (${orgId}::uuid, ${warning.qualificationId}::uuid, 'warned',
              ${actorId}::uuid, ${`${context}: ${warning.detail}`}::text)
      returning id
    `)).rows[0]?.id;
    if (!inserted) {
      throw new HrmQualificationError("The dispatch warning was not recorded — no row was written; retry the action.");
    }
  }
}

export interface ScheduleGateInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly resourceId: string;
  readonly taskId?: string;
  readonly on?: string;
  /** Injectable gate for the feature-off bypass proof (throws if called). */
  readonly gate?: (
    exec: SqlExecutor,
    input: CheckAssignmentInput,
  ) => Promise<GateVerdict>;
  /**
   * Trusted scheduling-path mode: skip the per-actor read grant and gate
   * on the employment behind the resource. The dispatcher sees only the
   * verdict for the assignment being made (the refusal names the missing
   * types — that disclosure IS the feature); full ledger reads still
   * need hrm.certifications.read. Never set from user input: only the
   * scheduling write path passes true.
   */
  readonly trusted?: boolean;
}

export interface ScheduleGateResult {
  /** False when the feature is off or nothing resolves to gate. */
  readonly gated: boolean;
  readonly verdict: GateVerdict;
  readonly employmentId: string | null;
  readonly resourceName: string | null;
}

/**
 * The scheduling assignment hook: schedule_task_assignments +
 * schedule_resources call this before inserting when hrmDispatchGating
 * is on. With the feature off the gate is never consulted (the
 * assignment path must not call it — proven by a test double that
 * throws). Resources with no employment behind them (equipment rows,
 * vendor placeholders) have nothing to gate and pass through: the gate
 * answers "can this person be on that job", and there is no person.
 */
export async function gateScheduleAssignment(
  exec: SqlExecutor,
  input: ScheduleGateInput,
): Promise<ScheduleGateResult> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const resourceId = requireId(input.resourceId, "resourceId");
  const passThrough: ScheduleGateResult = {
    gated: false,
    verdict: { ok: true, warnings: [] },
    employmentId: null,
    resourceName: null,
  };
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_DISPATCH_GATING_FEATURE))) {
    return passThrough;
  }
  const resource = (await exec.execute<{ name: string; party_id: string | null; project_id: string | null }>(sql`
    select name, party_id::text, project_id::text
      from schedule_resources
     where org_id = ${orgId}::uuid and id = ${resourceId}::uuid
  `)).rows[0];
  if (!resource) {
    throw new HrmQualificationError(
      "The schedule resource was not found in this organization — refresh the board and try again.",
    );
  }
  if (!resource.party_id) return { ...passThrough, resourceName: resource.name };
  const on = input.on ? requireDate(input.on, "on") : await businessToday(orgId);
  const employment = (await exec.execute<{ id: string }>(sql`
    select id::text as id from worker_employments
     where org_id = ${orgId}::uuid and worker_party_id = ${resource.party_id}::uuid
     order by created_at desc limit 1
  `)).rows[0];
  if (!employment) return { ...passThrough, resourceName: resource.name };
  const projectId = resource.project_id;
  if (!projectId) return { ...passThrough, employmentId: employment.id, resourceName: resource.name };
  if (input.gate) {
    const verdict = await input.gate(exec, {
      orgId,
      actorId,
      employmentId: employment.id,
      subjectKind: "project",
      subjectId: projectId,
      on,
    });
    return { gated: true, verdict, employmentId: employment.id, resourceName: resource.name };
  }
  const verdict = input.trusted === true
    ? await checkAssignmentTrusted(exec, { orgId, employmentId: employment.id, subjectKind: "project", subjectId: projectId, on })
    : await checkAssignment(exec, {
        orgId,
        actorId,
        employmentId: employment.id,
        subjectKind: "project",
        subjectId: projectId,
        on,
      });
  return { gated: true, verdict, employmentId: employment.id, resourceName: resource.name };
}

/**
 * Refuse a blocked dispatch BY NAME with the missing-type list. The
 * scheduling write path calls this after gateScheduleAssignment: a
 * block severity never becomes a silent assignment.
 */
export function refuseBlockedDispatch(
  verdict: GateVerdict,
  resourceName: string | null,
): void {
  if (verdict.ok) return;
  const names = verdict.blocking.map((b) => b.typeName).join(", ");
  const who = resourceName ? `Resource "${resourceName}"` : "The resource";
  throw new HrmQualificationError(
    `${who} cannot be dispatched: missing or unqualified for ${names}. ` +
      verdict.blocking.map((b) => b.detail).join(" ") +
      " Record the qualification first, then assign again.",
  );
}
