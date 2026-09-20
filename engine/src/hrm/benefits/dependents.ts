import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { requireHrmBenefitsManageOnEmployment } from "../authorization.ts";
import { BenefitsError } from "./errors.ts";
import {
  assertHrmEnabled,
  requireActorId,
  requireCivilDate,
  requireId,
  requireOneRow,
  requireOrgId,
} from "./shared.ts";

/**
 * HRM covered-dependent service (HR-8).
 *
 * Dependents belong to an employment; elections link them for coverage.
 * A link is validated against the SUBJECT (both rows' employment ids must
 * match in this org), never against the declaration alone — a dependent of
 * one worker can never be attached to another worker's election.
 */

export type DependentRelationship = "spouse" | "partner" | "child" | "other";

export interface DependentDTO {
  readonly id: string;
  readonly employmentId: string;
  readonly relationship: DependentRelationship;
  readonly displayName: string;
  readonly birthDate: string | null;
  readonly isActive: boolean;
}

const DEPENDENT_COLUMNS = sql`id, employment_id as "employmentId", relationship,
  display_name as "displayName", birth_date::text as "birthDate", is_active as "isActive"`;

function toDependentDTO(row: Record<string, unknown>): DependentDTO {
  const relationship = String(row.relationship);
  if (relationship !== "spouse" && relationship !== "partner" && relationship !== "child" && relationship !== "other") {
    throw new BenefitsError("REFUSED", "dependent carries an unknown relationship — re-save it as spouse, partner, child, or other");
  }
  return {
    id: String(row.id),
    employmentId: String(row.employmentId),
    relationship,
    displayName: String(row.displayName),
    birthDate: row.birthDate != null ? String(row.birthDate).slice(0, 10) : null,
    isActive: row.isActive === true,
  };
}

function requireRelationship(value: unknown): DependentRelationship {
  if (value === "spouse" || value === "partner" || value === "child" || value === "other") return value;
  throw new BenefitsError(
    "INVALID_INPUT",
    "relationship is one of spouse, partner, child, other — the plan's eligibility rules read this value",
  );
}

export interface SaveDependentQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly relationship: string;
  readonly displayName: string;
  readonly birthDate?: string | null;
}

/** Create a covered dependent on an employment. */
export async function createDependent(query: SaveDependentQuery): Promise<DependentDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const employmentId = requireId(query.employmentId, "employmentId");
  const relationship = requireRelationship(query.relationship);
  const displayName =
    typeof query.displayName === "string" && query.displayName.trim().length > 0
      ? query.displayName.trim()
      : null;
  if (!displayName) {
    throw new BenefitsError("INVALID_INPUT", "a dependent carries a name — record who is covered");
  }
  const birthDate =
    query.birthDate === undefined || query.birthDate === null
      ? null
      : requireCivilDate(query.birthDate, "birthDate");
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, employmentId);
    await assertHrmEnabled(db, orgId);
    const inserted = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          insert into hrm_benefit_dependents
            (org_id, employment_id, relationship, display_name, birth_date, created_by, updated_by)
          values (${orgId}, ${employmentId}, ${relationship}, ${displayName},
                  ${birthDate}::date, ${actorId}, ${actorId})
          returning ${DEPENDENT_COLUMNS}
        `)
      ).rows,
      "recording the dependent",
    );
    return toDependentDTO(inserted);
  });
}

/** Edit a dependent's descriptors (never its employment — identity is immutable). */
export async function updateDependent(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly dependentId: string;
  readonly relationship?: string;
  readonly displayName?: string;
  readonly birthDate?: string | null;
}): Promise<DependentDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const dependentId = requireId(query.dependentId, "dependentId");
  return withOrgTransaction(orgId, async () => {
    const current = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          select ${DEPENDENT_COLUMNS} from hrm_benefit_dependents
           where org_id = ${orgId} and id = ${dependentId}
        `)
      ).rows,
      "dependent",
    );
    const dto = toDependentDTO(current);
    await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, dto.employmentId);
    await assertHrmEnabled(db, orgId);
    const relationship = query.relationship === undefined ? dto.relationship : requireRelationship(query.relationship);
    const displayName =
      query.displayName === undefined ? dto.displayName : query.displayName.trim().length > 0 ? query.displayName.trim() : null;
    if (!displayName) {
      throw new BenefitsError("INVALID_INPUT", "a dependent carries a name — record who is covered");
    }
    const birthDate =
      query.birthDate === undefined ? dto.birthDate : query.birthDate === null ? null : requireCivilDate(query.birthDate, "birthDate");
    const updated = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          update hrm_benefit_dependents
             set relationship = ${relationship}, display_name = ${displayName},
                 birth_date = ${birthDate}::date, updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${dependentId}
          returning ${DEPENDENT_COLUMNS}
        `)
      ).rows,
      "updating the dependent",
    );
    return toDependentDTO(updated);
  });
}

/** Retire a dependent (rows are retained; coverage links stay evidenced). */
export async function deactivateDependent(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly dependentId: string;
}): Promise<DependentDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const dependentId = requireId(query.dependentId, "dependentId");
  return withOrgTransaction(orgId, async () => {
    const current = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          select ${DEPENDENT_COLUMNS} from hrm_benefit_dependents
           where org_id = ${orgId} and id = ${dependentId}
        `)
      ).rows,
      "dependent",
    );
    const dto = toDependentDTO(current);
    await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, dto.employmentId);
    await assertHrmEnabled(db, orgId);
    const updated = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          update hrm_benefit_dependents
             set is_active = false, updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${dependentId}
          returning ${DEPENDENT_COLUMNS}
        `)
      ).rows,
      "deactivating the dependent",
    );
    return toDependentDTO(updated);
  });
}

async function requireSameEmployment(
  exec: SqlExecutor,
  orgId: string,
  enrollmentId: string,
  dependentId: string,
): Promise<{ employmentId: string }> {
  const enrollment = requireOneRow(
    (
      await exec.execute<{ employment_id: string }>(sql`
        select employment_id from hrm_benefit_enrollments
         where org_id = ${orgId} and id = ${enrollmentId}
      `)
    ).rows,
    "benefit enrollment",
  );
  const dependent = requireOneRow(
    (
      await exec.execute<{ employment_id: string }>(sql`
        select employment_id from hrm_benefit_dependents
         where org_id = ${orgId} and id = ${dependentId}
      `)
    ).rows,
    "dependent",
  );
  if (String(enrollment.employment_id) !== String(dependent.employment_id)) {
    throw new BenefitsError(
      "REFUSED",
      "the dependent belongs to a different employment than the election — cover a worker's own dependents on their own elections",
    );
  }
  return { employmentId: String(enrollment.employment_id) };
}

/** Cover a dependent on an election (same employment, proven from storage). */
export async function linkDependent(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly enrollmentId: string;
  readonly dependentId: string;
}): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const enrollmentId = requireId(query.enrollmentId, "enrollmentId");
  const dependentId = requireId(query.dependentId, "dependentId");
  return withOrgTransaction(orgId, async () => {
    const { employmentId } = await requireSameEmployment(db, orgId, enrollmentId, dependentId);
    await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, employmentId);
    await assertHrmEnabled(db, orgId);
    // Idempotent by the (org, enrollment, dependent) unique: re-linking the
    // same pair restates the same coverage fact, so a conflict is expected
    // and benign — the write below is a no-op for it, never a dropped row.
    await db.execute(sql`
      insert into hrm_enrollment_dependents (org_id, enrollment_id, dependent_id, created_by)
      values (${orgId}, ${enrollmentId}, ${dependentId}, ${actorId})
      on conflict do nothing
    `);
  });
}

/** End a dependent's coverage on an election. */
export async function unlinkDependent(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly enrollmentId: string;
  readonly dependentId: string;
}): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  // actorId authenticates through the manage gate below; the link table
  // carries no actor column to stamp (created_by only, set at link time).
  const actorId = requireActorId(query.actorId);
  const enrollmentId = requireId(query.enrollmentId, "enrollmentId");
  const dependentId = requireId(query.dependentId, "dependentId");
  return withOrgTransaction(orgId, async () => {
    const { employmentId } = await requireSameEmployment(db, orgId, enrollmentId, dependentId);
    await requireHrmBenefitsManageOnEmployment(db, orgId, actorId, employmentId);
    await assertHrmEnabled(db, orgId);
    const deleted = (
      await db.execute(sql`
        delete from hrm_enrollment_dependents
         where org_id = ${orgId} and enrollment_id = ${enrollmentId} and dependent_id = ${dependentId}
        returning id
      `)
    ).rows;
    if (deleted.length !== 1) {
      throw new BenefitsError(
        "REFUSED",
        "that dependent is not covered on that election — nothing was unlinked",
      );
    }
  });
}
