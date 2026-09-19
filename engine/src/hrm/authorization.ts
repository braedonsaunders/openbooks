import { sql } from "drizzle-orm";
import { actorHasPermission, actorIdentity } from "../actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../actor-subsidiaries.ts";
import type { SqlExecutor } from "../db.ts";

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

// Module-private brand: a real symbol, so a forged record built without
// this module cannot satisfy the type, and loading is the only producer.
const trustedEmploymentSubject = Symbol("trustedEmploymentSubject");

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
  readonly [trustedEmploymentSubject]: true;
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
    [trustedEmploymentSubject]: true,
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
