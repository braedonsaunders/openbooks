import { sql } from "drizzle-orm";
import { actorHasPermission, actorIdentity } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import type { SqlExecutor } from "../platform/db.ts";

/**
 * Foundational HRM employment authorization.
 *
 * Lives behind the service layer: every exported gate takes the caller's
 * trusted runner (`db` for reads, the write transaction's runner for writes)
 * plus opaque IDs only — never caller-supplied parties, booleans, or scope.
 * Subjects are always loaded from worker_employments on that runner inside
 * the gate, so a caller cannot forge employer/worker identity.
 *
 * Read gates accept any runner; write paths MUST pass their own transaction
 * runner so the permission/scope check and the write are atomic.
 *
 * Separation of duties for approvals is split in two until the
 * change-request schema lands: requireHrmEmploymentApprove gates the
 * permission/scope half, and the pure checkApprovalIdentitySeparation
 * invariant decides the identity half over trusted-DB-loaded parties. The
 * future approval service owns loading its persisted request revision
 * itself and calling both; no exported gate accepts a caller-supplied
 * subject or submitter.
 */

export class HrmAuthorizationError extends Error {}

/** Foundation employment duties. No future capabilities are granted here. */
export const HRM_EMPLOYMENT_PERMISSIONS = [
  "hrm.employment.read",
  "hrm.employment.manage",
  "hrm.employment.approve",
] as const;

export type HrmEmploymentPermission = (typeof HRM_EMPLOYMENT_PERMISSIONS)[number];

/**
 * Headcount-plan duties (0192). read = see positions, funding and vacancy;
 * manage = create, revise, fund and close positions. Assignment of an
 * employment onto a position rides the employment change-request path, so
 * its approval stays hrm.employment.approve — there is deliberately no
 * position approve key.
 */
export const HRM_POSITION_PERMISSIONS = [
  "hrm.position.read",
  "hrm.position.manage",
] as const;

export type HrmPositionPermission = (typeof HRM_POSITION_PERMISSIONS)[number];

/**
 * Process checklist duties (0193): read sees processes and steps, manage
 * opens, completes, and cancels them. Granted to the same built-in roles as
 * the employment read/manage keys (admin only, via the catalogue spread —
 * the permission-role sync rule re-seeds on deploy). Skipping a required
 * step is NOT covered here: it needs hrm.employment.manage.
 */
export const HRM_PROCESS_PERMISSIONS = ["hrm.process.read", "hrm.process.manage"] as const;

export type HrmProcessPermission = (typeof HRM_PROCESS_PERMISSIONS)[number];

// Module-private brand: a real symbol, so a forged record built without
// this module cannot satisfy the type, and loading is the only producer.
// One brand for every HRM subject (employments and positions alike).
const trustedHrmSubject = Symbol("trustedHrmSubject");

/**
 * Employment identity loaded from worker_employments on the trusted runner,
 * org-scoped. The brand marks records no caller could have forged; gates
 * return it so the service reuses the checked record in-transaction.
 *
 * Assumes the coordinator-selected identity columns (id, org_id,
 * worker_party_id, employer_subsidiary_id non-null, revision). If the
 * schema worker renames them, loadTrustedEmploymentSubject is the one
 * place to update. Minimal stable fields only — versions and terms are
 * the schema worker's domain, not authorization's.
 */
export interface TrustedEmploymentSubject {
  readonly id: string;
  readonly orgId: string;
  readonly workerPartyId: string;
  readonly employerSubsidiaryId: string;
  readonly revision: number;
  readonly [trustedHrmSubject]: true;
}

async function loadTrustedEmploymentSubject(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
): Promise<TrustedEmploymentSubject> {
  const rows = (await exec.execute<{
    id: string;
    orgId: string;
    workerPartyId: string;
    employerSubsidiaryId: string | null;
    revision: number;
  }>(sql`
    select id,
           org_id as "orgId",
           worker_party_id as "workerPartyId",
           employer_subsidiary_id as "employerSubsidiaryId",
           revision
      from worker_employments
     where org_id = ${orgId} and id = ${employmentId}
  `)).rows[0];
  // Zero rows is a failure: unknown id, or an id from another organization
  // (the org_id predicate is the org-isolation enforcement).
  if (!rows) {
    throw new HrmAuthorizationError(
      "Employment is not visible in this organization and legal-entity scope.",
    );
  }
  if (!rows.employerSubsidiaryId) {
    throw new HrmAuthorizationError(
      "Employment is not visible in this organization and legal-entity scope.",
    );
  }
  return {
    id: rows.id,
    orgId: rows.orgId,
    workerPartyId: rows.workerPartyId,
    employerSubsidiaryId: rows.employerSubsidiaryId,
    revision: rows.revision,
    [trustedHrmSubject]: true,
  };
}

/** Employer-scope half of every gate: the actor must see the employer entity. */
async function assertEmployerScope(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  subject: TrustedEmploymentSubject,
): Promise<void> {
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  if (allowed === null) return;
  if (!allowed.has(subject.employerSubsidiaryId)) {
    throw new HrmAuthorizationError(
      "Employment is not visible in this organization and legal-entity scope.",
    );
  }
}

async function requireHrmEmploymentAccess(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
  permission: HrmEmploymentPermission,
): Promise<TrustedEmploymentSubject> {
  // actorHasPermission fails closed for unknown/inactive actors and enforces
  // the live grant set — no parallel role system, no trusted booleans.
  if (!(await actorHasPermission(exec, orgId, actorId, permission))) {
    throw new HrmAuthorizationError(
      `Employment access requires the ${permission} permission — ask an administrator to grant it in /admin/roles.`,
    );
  }
  const subject = await loadTrustedEmploymentSubject(exec, orgId, employmentId);
  await assertEmployerScope(exec, orgId, actorId, subject);
  return subject;
}

async function requireHrmProcessAccess(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
  permission: HrmProcessPermission,
): Promise<TrustedEmploymentSubject> {
  // Same shape as the employment gates: the live grant set decides, then
  // the trusted subject plus the employer scope. No caller-supplied parties,
  // booleans, or scope at any boundary.
  if (!(await actorHasPermission(exec, orgId, actorId, permission))) {
    throw new HrmAuthorizationError(
      `Process access requires the ${permission} permission — ask an administrator to grant it in /admin/roles.`,
    );
  }
  const subject = await loadTrustedEmploymentSubject(exec, orgId, employmentId);
  await assertEmployerScope(exec, orgId, actorId, subject);
  return subject;
}

/** See a process checklist. Read-only; accepts `db` or a transaction runner. */
export async function requireHrmProcessRead(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<TrustedEmploymentSubject> {
  return requireHrmProcessAccess(exec, orgId, actorId, employmentId, "hrm.process.read");
}

/**
 * Open, complete, or cancel a process checklist. The caller MUST pass its
 * write transaction's runner so this check and the subsequent write are
 * atomic. Skipping a required step additionally needs
 * requireHrmEmploymentManage; completing one's own employee-owned steps
 * needs neither key (see resolveStepActor in processes.ts).
 */
export async function requireHrmProcessManage(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<TrustedEmploymentSubject> {
  return requireHrmProcessAccess(exec, orgId, actorId, employmentId, "hrm.process.manage");
}

/**
 * Configuration-only process gate (templates have no employment subject):
 * the live hrm.process.manage grant, no subsidiary scope to check. The
 * Setup registry UI fences the same writes behind admin.setup.manage; this
 * is the engine-service boundary for direct callers.
 */
export async function requireHrmProcessConfig(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<void> {
  if (!(await actorHasPermission(exec, orgId, actorId, "hrm.process.manage"))) {
    throw new HrmAuthorizationError(
      "Process access requires the hrm.process.manage permission — ask an administrator to grant it in /admin/roles.",
    );
  }
}

/** See an employment record. Read-only; accepts `db` or a transaction runner. */
export async function requireHrmEmploymentRead(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<TrustedEmploymentSubject> {
  return requireHrmEmploymentAccess(exec, orgId, actorId, employmentId, "hrm.employment.read");
}

/**
 * Author an employment change. The caller MUST pass its write transaction's
 * runner so this check and the subsequent write are atomic.
 */
export async function requireHrmEmploymentManage(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<TrustedEmploymentSubject> {
  return requireHrmEmploymentAccess(exec, orgId, actorId, employmentId, "hrm.employment.manage");
}

/**
 * Permission/scope half of employment-change approval. Full approval
 * authorization additionally requires the identity invariant below over the
 * persisted request revision — owned by the future approval service, which
 * loads that revision itself. Deliberately takes no submitter: until the
 * request table exists any caller-supplied submitter ID would be forgeable.
 */
export async function requireHrmEmploymentApprove(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<TrustedEmploymentSubject> {
  return requireHrmEmploymentAccess(exec, orgId, actorId, employmentId, "hrm.employment.approve");
}

/** Resolved person identity behind a user login, for the SoD invariant. */
export interface ApprovalPerson {
  readonly userId: string;
  /** users.party_id as loaded on the trusted runner; null = unresolved. */
  readonly partyId: string | null;
}

/** Load one user's person identity on the trusted runner; missing fails closed. */
export async function loadApprovalPerson(
  exec: SqlExecutor,
  orgId: string,
  userId: string,
): Promise<ApprovalPerson> {
  const row = (await exec.execute<{ id: string; partyId: string | null }>(sql`
    select id, party_id as "partyId" from users where org_id = ${orgId} and id = ${userId}
  `)).rows[0];
  if (!row) {
    throw new HrmAuthorizationError(
      "Employment approval refused: the identity behind this action is not established in this organization.",
    );
  }
  return { userId: row.id, partyId: row.partyId };
}

/**
 * Position identity loaded from positions on the trusted runner,
 * org-scoped, with the employer of the CURRENT live version (highest
 * version_no among recorded-live rows). The establishment code is stable
 * but carries no legal entity; scope must come from a version, and the
 * current one is the only defensible choice for a gate that names no
 * as-of date. A position with no live version has no employer to scope
 * by and is refused outright — never treated as globally visible.
 */
export interface TrustedPositionSubject {
  readonly id: string;
  readonly orgId: string;
  readonly positionCode: string;
  readonly employerSubsidiaryId: string;
  readonly revision: number;
  readonly [trustedHrmSubject]: true;
}

async function loadTrustedPositionSubject(
  exec: SqlExecutor,
  orgId: string,
  positionId: string,
): Promise<TrustedPositionSubject> {
  const rows = (await exec.execute<{
    id: string;
    orgId: string;
    positionCode: string;
    employerSubsidiaryId: string | null;
    revision: number;
  }>(sql`
    select p.id,
           p.org_id as "orgId",
           p.position_code as "positionCode",
           (select v.employer_subsidiary_id
              from position_versions v
             where v.org_id = p.org_id and v.position_id = p.id
               and v.recorded_until is null
             order by v.version_no desc
             limit 1) as "employerSubsidiaryId",
           p.revision
      from positions p
     where p.org_id = ${orgId} and p.id = ${positionId}
  `)).rows[0];
  // Zero rows is a failure: unknown id, or an id from another organization
  // (the org_id predicate is the org-isolation enforcement).
  if (!rows) {
    throw new HrmAuthorizationError(
      "Position is not visible in this organization and legal-entity scope.",
    );
  }
  if (!rows.employerSubsidiaryId) {
    throw new HrmAuthorizationError(
      "Position is not visible in this organization and legal-entity scope.",
    );
  }
  return {
    id: rows.id,
    orgId: rows.orgId,
    positionCode: rows.positionCode,
    employerSubsidiaryId: rows.employerSubsidiaryId,
    revision: rows.revision,
    [trustedHrmSubject]: true,
  };
}

async function requireHrmPositionAccess(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  positionId: string,
  permission: HrmPositionPermission,
): Promise<TrustedPositionSubject> {
  if (!(await actorHasPermission(exec, orgId, actorId, permission))) {
    throw new HrmAuthorizationError(
      `Position access requires the ${permission} permission — ask an administrator to grant it in /admin/roles.`,
    );
  }
  const subject = await loadTrustedPositionSubject(exec, orgId, positionId);
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  if (allowed !== null && !allowed.has(subject.employerSubsidiaryId)) {
    throw new HrmAuthorizationError(
      "Position is not visible in this organization and legal-entity scope.",
    );
  }
  return subject;
}

/** See a position, its funding and its vacancy. Read-only. */
export async function requireHrmPositionRead(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  positionId: string,
): Promise<TrustedPositionSubject> {
  return requireHrmPositionAccess(exec, orgId, actorId, positionId, "hrm.position.read");
}

/**
 * Create, revise, fund or close a position. The caller MUST pass its write
 * transaction's runner so this check and the subsequent write are atomic.
 */
export async function requireHrmPositionManage(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  positionId: string,
): Promise<TrustedPositionSubject> {
  return requireHrmPositionAccess(exec, orgId, actorId, positionId, "hrm.position.manage");
}

/**
 * The aggregate half of position authority for creates (which name no
 * position yet) and list-shaped reads: the hrm.position.manage/read grant,
 * then the employer-subsidiary scope. Creation validates against the
 * DECLARED employer — the subsidiary the new position will belong to — so
 * a caller cannot plant headcount in a legal entity they cannot see.
 */
export async function requirePositionManageForEmployer(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employerSubsidiaryId: string,
): Promise<Set<string> | null> {
  if (!(await actorHasPermission(exec, orgId, actorId, "hrm.position.manage"))) {
    throw new HrmAuthorizationError(
      "Position access requires the hrm.position.manage permission — ask an administrator to grant it in /admin/roles.",
    );
  }
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  if (allowed !== null && !allowed.has(employerSubsidiaryId)) {
    throw new HrmAuthorizationError(
      "Position is not visible in this organization and legal-entity scope.",
    );
  }
  return allowed;
}

/**
 * The aggregate half of position read authority, lifted to list-shaped
 * reads that name no single position. Returns the allowed employer set
 * (null = unrestricted) for the caller to filter by, never a boolean.
 */
export async function requireAggregatePositionRead(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<Set<string> | null> {
  if (!(await actorHasPermission(exec, orgId, actorId, "hrm.position.read"))) {
    throw new HrmAuthorizationError(
      "Position access requires the hrm.position.read permission — ask an administrator to grant it in /admin/roles.",
    );
  }
  return actorAllowedSubsidiaryIds(exec, orgId, actorId);
}

/** Actor identity as the SoD legs see it: super-admin flag travels with the login. */
export async function loadActorPerson(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<ApprovalPerson & { isSuperAdmin: boolean }> {
  const identity = await actorIdentity(exec, orgId, actorId);
  if (!identity?.isActive) {
    throw new HrmAuthorizationError(
      "Employment approval refused: the identity behind this action is not established in this organization.",
    );
  }
  const person = await loadApprovalPerson(exec, orgId, actorId);
  return { ...person, isSuperAdmin: identity.isSuperAdmin };
}

/**
 * Pure separation-of-duties invariant over trusted-DB-loaded identities.
 * All parties must come from the service's transaction (users.party_id for
 * approver/submitter, worker_party_id for the subject) — never from caller
 * input. Throws HrmAuthorizationError naming the refused shape.
 *
 * An approver whose person identity is unresolved (partyId null) is
 * refused outright: without a resolved person the subject self-approval
 * leg cannot be evaluated, and no protection may be implied. Super admins
 * are bound by every leg below — platform scope is not personhood.
 */
export function checkApprovalIdentitySeparation(args: {
  approver: ApprovalPerson;
  submitter: ApprovalPerson;
  subjectWorkerPartyId: string;
}): void {
  if (!args.approver.partyId) {
    throw new HrmAuthorizationError(
      "Employment approval refused: the approver has no resolved person identity, so independence from the affected worker cannot be established.",
    );
  }
  if (args.approver.userId === args.submitter.userId) {
    throw new HrmAuthorizationError(
      "Employment approval refused: the submitter cannot approve their own change — route it to an independent approver.",
    );
  }
  if (args.approver.partyId === args.subjectWorkerPartyId) {
    throw new HrmAuthorizationError(
      "Employment approval refused: the affected worker cannot approve their own employment change — route it to an independent approver.",
    );
  }
  if (args.submitter.partyId !== null && args.approver.partyId === args.submitter.partyId) {
    throw new HrmAuthorizationError(
      "Employment approval refused: the submitter cannot approve their own change — route it to an independent approver.",
    );
  }
}

/** Leave and attendance duties (HR-5). Confidential like employment. */
export const HRM_LEAVE_PERMISSIONS = [
  "hrm.leave.read",
  "hrm.leave.request",
  "hrm.leave.approve",
  "hrm.leave.manage",
] as const;

export type HrmLeavePermission = (typeof HRM_LEAVE_PERMISSIONS)[number];

async function requireHrmLeaveAccess(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
  permission: HrmLeavePermission,
): Promise<TrustedEmploymentSubject> {
  // Same hardwiring as employment: live grant set, subject loaded from
  // worker_employments on the trusted runner, employer scope enforced.
  if (!(await actorHasPermission(exec, orgId, actorId, permission))) {
    throw new HrmAuthorizationError(
      `Leave access requires the ${permission} permission — ask an administrator to grant it in /admin/roles.`,
    );
  }
  const subject = await loadTrustedEmploymentSubject(exec, orgId, employmentId);
  await assertEmployerScope(exec, orgId, actorId, subject);
  return subject;
}

/** See leave records scoped to an employment. */
export async function requireHrmLeaveRead(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<TrustedEmploymentSubject> {
  return requireHrmLeaveAccess(exec, orgId, actorId, employmentId, "hrm.leave.read");
}

/** File a leave request against an employment. */
export async function requireHrmLeaveRequest(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<TrustedEmploymentSubject> {
  return requireHrmLeaveAccess(exec, orgId, actorId, employmentId, "hrm.leave.request");
}

/** Permission/scope half of leave approval; identity half is the shared SoD invariant. */
export async function requireHrmLeaveApprove(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<TrustedEmploymentSubject> {
  return requireHrmLeaveAccess(exec, orgId, actorId, employmentId, "hrm.leave.approve");
}

/**
 * Org-level leave configuration (types, policies): permission only, no
 * subsidiary scope — a type or policy is org configuration, and scoping it
 * by one employer would let two managers define the same code differently.
 */
export async function requireHrmLeaveManage(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<void> {
  if (!(await actorHasPermission(exec, orgId, actorId, "hrm.leave.manage"))) {
    throw new HrmAuthorizationError(
      "Leave configuration requires the hrm.leave.manage permission — ask an administrator to grant it in /admin/roles.",
    );
  }
}

/**
 * The actor's own employments, resolved from users.party_id on the trusted
 * runner. The second self-service touch: an employee files and reads only
 * through these ids — the service never accepts a caller-supplied worker.
 */
export async function loadOwnEmploymentIds(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<string[]> {
  const person = await loadApprovalPerson(exec, orgId, actorId);
  if (!person.partyId) return [];
  const rows = (await exec.execute<{ id: string }>(sql`
    select id from worker_employments
     where org_id = ${orgId} and worker_party_id = ${person.partyId}
  `)).rows;
  return rows.map((row) => row.id);
}

/**
 * Manager file gate: hrm.leave.manage plus the same employer scope as every
 * employment gate, for filing on behalf of another worker. The short-notice
 * override lives here: a manager files with a reason where the worker is
 * refused.
 */
export async function requireHrmLeaveManageOnEmployment(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<TrustedEmploymentSubject> {
  if (!(await actorHasPermission(exec, orgId, actorId, "hrm.leave.manage"))) {
    throw new HrmAuthorizationError(
      "Leave access requires the hrm.leave.manage permission — ask an administrator to grant it in /admin/roles.",
    );
  }
  const subject = await loadTrustedEmploymentSubject(exec, orgId, employmentId);
  await assertEmployerScope(exec, orgId, actorId, subject);
  return subject;
}

/**
 * Self-service file gate: hrm.leave.request plus proof the employment is
 * the actor's own. Throws HrmAuthorizationError naming the refused shape —
 * the caller must not learn whether the id exists elsewhere.
 */
export async function requireOwnEmploymentForRequest(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<TrustedEmploymentSubject> {
  const subject = await requireHrmLeaveRequest(exec, orgId, actorId, employmentId);
  const own = await loadOwnEmploymentIds(exec, orgId, actorId);
  if (!own.includes(employmentId)) {
    throw new HrmAuthorizationError(
      "Leave requests file only against your own employment — ask a manager holding hrm.leave.manage to file on your behalf.",
    );
  }
  return subject;
}

/** Recruiting duties (HR-6). Confidential like employment. */
export const HRM_RECRUITING_PERMISSIONS = ["hrm.recruiting.read", "hrm.recruiting.manage"] as const;

export type HrmRecruitingPermission = (typeof HRM_RECRUITING_PERMISSIONS)[number];

/**
 * Requisition identity loaded from hrm_requisitions on the trusted runner,
 * org-scoped. The brand marks records no caller could have forged; gates
 * return it so the service reuses the checked record in-transaction.
 */
export interface TrustedRequisitionSubject {
  readonly id: string;
  readonly orgId: string;
  readonly requisitionNumber: string;
  readonly employerSubsidiaryId: string;
  readonly status: string;
  readonly hiringManagerPartyId: string | null;
  readonly revision: number;
  readonly [trustedHrmSubject]: true;
}

async function loadTrustedRequisitionSubject(
  exec: SqlExecutor,
  orgId: string,
  requisitionId: string,
): Promise<TrustedRequisitionSubject> {
  const rows = (await exec.execute<{
    id: string;
    orgId: string;
    requisitionNumber: string;
    employerSubsidiaryId: string | null;
    status: string;
    hiringManagerPartyId: string | null;
    revision: number;
  }>(sql`
    select id,
           org_id as "orgId",
           requisition_number as "requisitionNumber",
           employer_subsidiary_id as "employerSubsidiaryId",
           status,
           hiring_manager_party_id as "hiringManagerPartyId",
           revision
      from hrm_requisitions
     where org_id = ${orgId} and id = ${requisitionId}
  `)).rows[0];
  // Zero rows is a failure: unknown id, or an id from another organization
  // (the org_id predicate is the org-isolation enforcement).
  if (!rows) {
    throw new HrmAuthorizationError(
      "Requisition is not visible in this organization and legal-entity scope.",
    );
  }
  if (!rows.employerSubsidiaryId) {
    throw new HrmAuthorizationError(
      "Requisition is not visible in this organization and legal-entity scope.",
    );
  }
  return {
    id: rows.id,
    orgId: rows.orgId,
    requisitionNumber: rows.requisitionNumber,
    employerSubsidiaryId: rows.employerSubsidiaryId,
    status: rows.status,
    hiringManagerPartyId: rows.hiringManagerPartyId,
    revision: rows.revision,
    [trustedHrmSubject]: true,
  };
}

async function requireHrmRecruitingAccess(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  requisitionId: string,
  permission: HrmRecruitingPermission,
): Promise<TrustedRequisitionSubject> {
  // The live grant set decides, then the trusted subject plus the employer
  // scope. No caller-supplied parties, booleans, or scope at any boundary.
  if (!(await actorHasPermission(exec, orgId, actorId, permission))) {
    throw new HrmAuthorizationError(
      `Recruiting access requires the ${permission} permission — ask an administrator to grant it in /admin/roles.`,
    );
  }
  const subject = await loadTrustedRequisitionSubject(exec, orgId, requisitionId);
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  if (allowed !== null && !allowed.has(subject.employerSubsidiaryId)) {
    throw new HrmAuthorizationError(
      "Requisition is not visible in this organization and legal-entity scope.",
    );
  }
  return subject;
}

/** See a requisition, its funnel, interviews and offers. Read-only. */
export async function requireHrmRecruitingRead(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  requisitionId: string,
): Promise<TrustedRequisitionSubject> {
  return requireHrmRecruitingAccess(exec, orgId, actorId, requisitionId, "hrm.recruiting.read");
}

/**
 * Author a recruiting write on a requisition. The caller MUST pass its write
 * transaction's runner so this check and the subsequent write are atomic.
 */
export async function requireHrmRecruitingManage(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  requisitionId: string,
): Promise<TrustedRequisitionSubject> {
  return requireHrmRecruitingAccess(exec, orgId, actorId, requisitionId, "hrm.recruiting.manage");
}

/**
 * The aggregate half of recruiting authority for creates (which name no
 * requisition yet): the hrm.recruiting.manage grant, then the
 * employer-subsidiary scope. Creation validates against the DECLARED
 * employer — the subsidiary the opening will belong to — so a caller cannot
 * plant vacancies in a legal entity they cannot see.
 */
export async function requireRecruitingManageForEmployer(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  employerSubsidiaryId: string,
): Promise<Set<string> | null> {
  if (!(await actorHasPermission(exec, orgId, actorId, "hrm.recruiting.manage"))) {
    throw new HrmAuthorizationError(
      "Recruiting access requires the hrm.recruiting.manage permission — ask an administrator to grant it in /admin/roles.",
    );
  }
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  if (allowed !== null && !allowed.has(employerSubsidiaryId)) {
    throw new HrmAuthorizationError(
      "Requisition is not visible in this organization and legal-entity scope.",
    );
  }
  return allowed;
}

/**
 * The aggregate half of recruiting read authority, lifted to list-shaped
 * reads that name no single requisition. Returns the allowed employer set
 * (null = unrestricted) for the caller to filter by, never a boolean.
 */
export async function requireAggregateRecruitingRead(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<Set<string> | null> {
  if (!(await actorHasPermission(exec, orgId, actorId, "hrm.recruiting.read"))) {
    throw new HrmAuthorizationError(
      "Recruiting access requires the hrm.recruiting.read permission — ask an administrator to grant it in /admin/roles.",
    );
  }
  return actorAllowedSubsidiaryIds(exec, orgId, actorId);
}

/**
 * Whether the actor holds an org-wide recruiting grant (either key). The
 * PII rule keys off this, not off the hiring-manager override: a manager
 * sees their own funnel, never the contact PII inside it.
 */
export async function actorHoldsRecruitingRead(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<boolean> {
  return actorHasPermission(exec, orgId, actorId, "hrm.recruiting.read");
}

/**
 * The hiring-manager override: the actor whose person identity
 * (users.party_id, loaded on the trusted runner) equals the requisition's
 * hiring_manager_party_id reads and moves candidates on their OWN
 * requisitions without the org-wide grant. The manager sees the funnel —
 * names, stages, interviews, offers — but never candidate contact PII
 * (email, phone, resume), which stays behind hrm.recruiting.read.
 *
 * Returns the trusted subject so the service reuses the checked record
 * in-transaction; throws HrmAuthorizationError otherwise. The employer
 * scope still applies: a manager scoped away from the requisition's legal
 * entity cannot reach it through this path either.
 */
export async function requireOwnRequisitionForHiringManager(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  requisitionId: string,
): Promise<TrustedRequisitionSubject> {
  const subject = await loadTrustedRequisitionSubject(exec, orgId, requisitionId);
  const person = await loadApprovalPerson(exec, orgId, actorId);
  if (!person.partyId || subject.hiringManagerPartyId === null || person.partyId !== subject.hiringManagerPartyId) {
    throw new HrmAuthorizationError(
      "Recruiting access requires the hrm.recruiting.read permission — ask an administrator to grant it in /admin/roles.",
    );
  }
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  if (allowed !== null && !allowed.has(subject.employerSubsidiaryId)) {
    throw new HrmAuthorizationError(
      "Requisition is not visible in this organization and legal-entity scope.",
    );
  }
  return subject;
}

/**
 * Whether the actor sits on an interview's panel (panel membership loaded
 * on the trusted runner from hrm_interview_panel). An interviewer sees the
 * candidate NAME and the interview — nothing else: no contact PII, no other
 * applications, no offers. Never caller-supplied membership.
 */
export async function actorOnInterviewPanel(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  interviewId: string,
): Promise<boolean> {
  const person = await loadApprovalPerson(exec, orgId, actorId);
  if (!person.partyId) return false;
  const rows = (await exec.execute<{ one: number }>(sql`
    select 1 as one
      from hrm_interview_panel p
      join hrm_interviews i on i.org_id = p.org_id and i.id = p.interview_id
     where p.org_id = ${orgId} and p.interview_id = ${interviewId}
       and p.party_id = ${person.partyId}
     limit 1
  `)).rows;
  return rows.length > 0;
}

/**
 * Org-level recruiting configuration gate (pipeline templates and candidate
 * authoring name no requisition): the live hrm.recruiting.manage grant, no
 * subsidiary scope to check. Write paths MUST pass their own transaction
 * runner so this check and the subsequent write are atomic.
 */
export async function requireHrmRecruitingManageOrg(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<void> {
  if (!(await actorHasPermission(exec, orgId, actorId, "hrm.recruiting.manage"))) {
    throw new HrmAuthorizationError(
      "Recruiting access requires the hrm.recruiting.manage permission — ask an administrator to grant it in /admin/roles.",
    );
  }
}
