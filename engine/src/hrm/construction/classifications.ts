import { sql } from "drizzle-orm";
import { HrmConstructionError } from "./errors.ts";
import {
  requireConstructionScope,
  requireHrmConstructionRead,
  requireUnrestrictedHrmScope,
} from "../authorization.ts";
import {
  HRM_CONSTRUCTION_FEATURE,
  assertConstructionFeature,
  assertEmploymentInScope,
  assertScheduleReferenceInScope,
  requireDate,
  requireId,
  requireText,
  withOrgTransaction,
  type SqlExecutor,
} from "./shared.ts";

/**
 * Work classifications (HR-13, migration 0223): the org's trade taxonomy
 * in the Setup registry, plus bitemporal employment assignments with
 * history. Assigning closes the active row and opens a new one from the
 * change date — never an in-place rewrite, so the as-of classification
 * the resolver priced a past day with stays readable.
 */

export interface WorkClassification {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly trade: string;
  readonly isApprentice: boolean;
  readonly apprenticeProgramRef: string | null;
  readonly journeyClassificationId: string | null;
  readonly isActive: boolean;
}

export interface EmploymentClassification {
  readonly id: string;
  readonly employmentId: string;
  readonly classificationId: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly homeScheduleId: string | null;
}

export async function listClassifications(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<readonly WorkClassification[]> {
  await assertConstructionFeature(exec, orgId, HRM_CONSTRUCTION_FEATURE, "Work classifications");
  requireId(actorId, "actorId");
  await requireHrmConstructionRead(exec, orgId, actorId);
  const rows = (
    await exec.execute<{
      id: string;
      code: string;
      name: string;
      trade: string;
      isApprentice: boolean;
      apprenticeProgramRef: string | null;
      journeyClassificationId: string | null;
      isActive: boolean;
    }>(sql`
      select id::text as id, code, name, trade,
             is_apprentice as "isApprentice",
             apprentice_program_ref as "apprenticeProgramRef",
             journey_classification_id::text as "journeyClassificationId",
             is_active as "isActive"
        from hrm_work_classifications
       where org_id = ${orgId}::uuid
       order by code
    `)
  ).rows;
  return rows;
}

export async function createClassification(
  exec: SqlExecutor,
  input: {
  orgId: string;
  actorId: string;
  code: string;
  name: string;
  trade: string;
  isApprentice?: boolean;
  apprenticeProgramRef?: string | null;
  journeyClassificationId?: string | null;
}): Promise<WorkClassification> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const code = requireText(input.code, "code");
  const name = requireText(input.name, "name");
  const trade = requireText(input.trade, "trade");
  const isApprentice = input.isApprentice ?? false;
  const journeyClassificationId = input.journeyClassificationId ?? null;
  if (journeyClassificationId) requireId(journeyClassificationId, "journeyClassificationId");
  if (!isApprentice && journeyClassificationId) {
    throw new HrmConstructionError(
      `Classification ${code} is not an apprentice class but names a journey class — only apprentice classes count against a journey class.`,
    );
  }
  if (isApprentice && !journeyClassificationId) {
    throw new HrmConstructionError(
      `Apprentice classification ${code} names no journey class — every apprentice ratio counts against a journey class, so name one.`,
    );
  }
  return withOrgTransaction(orgId, async () => {
    await assertConstructionFeature(exec, orgId, HRM_CONSTRUCTION_FEATURE, "Work classifications");
    // The trade taxonomy is org-wide reference: creating a class needs
    // unrestricted scope (named 403).
    await requireConstructionScope(exec, orgId, actorId, "hrm.construction.manage");
    await requireUnrestrictedHrmScope(exec, orgId, actorId);
    try {
      const created = (
        await exec.execute<{ id: string }>(sql`
          insert into hrm_work_classifications
            (org_id, code, name, trade, is_apprentice, apprentice_program_ref,
             journey_classification_id, created_by, updated_by)
          values (${orgId}::uuid, ${code}, ${name}, ${trade}, ${isApprentice},
                  ${input.apprenticeProgramRef ?? null}, ${journeyClassificationId}::uuid,
                  ${actorId}::uuid, ${actorId}::uuid)
          returning id::text as id
        `)
      ).rows[0];
      if (!created) throw new HrmConstructionError(`Classification ${code} was not created — no row was written.`);
      const rows = await listClassifications(exec, orgId, actorId);
      const found = rows.find((row) => row.id === created.id);
      if (!found) throw new HrmConstructionError(`Classification ${code} was not created — it cannot be read back.`);
      return found;
    } catch (error) {
      if (error instanceof HrmConstructionError) throw error;
      throw new HrmConstructionError(
        `Classification ${code} cannot be saved — its code is already in use in this organization.`,
      );
    }
  });
}

export async function assignClassification(
  exec: SqlExecutor,
  input: {
  orgId: string;
  actorId: string;
  employmentId: string;
  classificationId: string;
  effectiveFrom: string;
  homeScheduleId?: string | null;
}): Promise<EmploymentClassification> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const employmentId = requireId(input.employmentId, "employmentId");
  const classificationId = requireId(input.classificationId, "classificationId");
  const effectiveFrom = requireDate(input.effectiveFrom, "effectiveFrom");
  return withOrgTransaction(orgId, async () => {
    await assertConstructionFeature(exec, orgId, HRM_CONSTRUCTION_FEATURE, "Work classifications");
    // The assignment prices one employment's hours: the employment's
    // employer must sit inside the lens, locked shared so a concurrent
    // rehome waits for the check. Missing and out-of-scope employments
    // refuse identically.
    const allowed = await requireConstructionScope(exec, orgId, actorId, "hrm.construction.manage");
    await assertEmploymentInScope(exec, orgId, employmentId, allowed, true);
    const classification = (
      await exec.execute<{ id: string }>(sql`
        select id from hrm_work_classifications
         where org_id = ${orgId}::uuid and id = ${classificationId}::uuid and is_active
      `)
    ).rows[0];
    if (!classification) {
      throw new HrmConstructionError(
        `Classification ${classificationId} does not exist or is retired in this organization — activate it before assigning.`,
      );
    }
    const homeScheduleId = input.homeScheduleId ?? null;
    if (homeScheduleId) {
      // The home local prices this worker's hours by reciprocity: it must
      // sit inside the lens, or the assignment subscribes the worker to
      // another entity's rates. Missing and out-of-scope refuse
      // identically.
      await assertScheduleReferenceInScope(exec, orgId, actorId, homeScheduleId, allowed);
    }
    // Close the row the new assignment supersedes; history stays readable.
    await exec.execute(sql`
      update hrm_employment_classifications
         set effective_to = (${effectiveFrom}::date - interval '1 day')::date,
             updated_by = ${actorId}::uuid, updated_at = now()
       where org_id = ${orgId}::uuid and employment_id = ${employmentId}::uuid
         and effective_from <= ${effectiveFrom}::date
         and (effective_to is null or effective_to >= ${effectiveFrom}::date)
    `);
    const created = (
      await exec.execute<{ id: string }>(sql`
        insert into hrm_employment_classifications
          (org_id, employment_id, classification_id, effective_from, home_schedule_id, created_by, updated_by)
        values (${orgId}::uuid, ${employmentId}::uuid, ${classificationId}::uuid,
                ${effectiveFrom}::date, ${homeScheduleId}::uuid,
                ${actorId}::uuid, ${actorId}::uuid)
        returning id::text as id
      `)
    ).rows[0];
    if (!created) {
      throw new HrmConstructionError(
        `The classification assignment for employment ${employmentId} was not written — no row was created.`,
      );
    }
    return {
      id: String(created.id),
      employmentId,
      classificationId,
      effectiveFrom,
      effectiveTo: null,
      homeScheduleId,
    };
  });
}

/** The employment's classification as of a date, with the apprentice flag and journey class. */
export async function classificationAsOf(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  workedOn: string,
): Promise<{
  classificationId: string;
  isApprentice: boolean;
  journeyClassificationId: string | null;
  homeScheduleId: string | null;
} | null> {
  const row = (
    await exec.execute<{
      classificationId: string;
      isApprentice: boolean;
      journeyClassificationId: string | null;
      homeScheduleId: string | null;
    }>(sql`
      select ec.classification_id::text as "classificationId",
             c.is_apprentice as "isApprentice",
             c.journey_classification_id::text as "journeyClassificationId",
             ec.home_schedule_id::text as "homeScheduleId"
        from hrm_employment_classifications ec
        join hrm_work_classifications c
          on c.org_id = ec.org_id and c.id = ec.classification_id
       where ec.org_id = ${orgId}::uuid and ec.employment_id = ${employmentId}::uuid
         and ec.effective_from <= ${workedOn}::date
         and (ec.effective_to is null or ec.effective_to >= ${workedOn}::date)
       order by ec.effective_from desc limit 1
    `)
  ).rows[0];
  return row ?? null;
}
