import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { actorAllowedSubsidiaryIds } from "../../organization/actor-subsidiaries.ts";
import { assertUnrestrictedScope } from "../../organization/subsidiary-scope.ts";
import { requireHrmRecruitingManageOrg, requireHrmRecruitingReadOrg } from "../authorization.ts";
import { RecruitingError } from "./errors.ts";
import { isUniqueViolation, requireActorId, requireId, requireOrgId } from "./input.ts";
import { pgTextArray, requireDepthFeature } from "./depth.ts";

/**
 * Canonical interview-kit service (HR-18, 0229): structured-interview
 * configuration. Kits carry the org-declared rating scale, attributes
 * carry the focus defaults, questions carry optional attribute pins.
 *
 * Setup-owned: deactivation preserves history. A kit with sittings is
 * history-pinned by the RESTRICT FK — the delete refusal names the
 * deactivation remedy. All writes run in one org transaction; a zero-row
 * write is a refusal, never success.
 */

export const CANONICAL_RATING_KEYS = ["strong_no", "no", "yes", "strong_yes"] as const;

export interface InterviewKitDTO {
  readonly id: string;
  readonly name: string;
  readonly pipelineStageId: string | null;
  readonly instructions: string | null;
  readonly ratingScale: readonly string[];
  readonly isActive: boolean;
}

export type ScorecardAttributeDTO = {
  readonly id: string;
  readonly kitId: string;
  readonly category: string;
  readonly attribute: string;
  readonly description: string | null;
  readonly position: number;
  readonly isFocusDefault: boolean;
}

export type KitQuestionDTO = {
  readonly id: string;
  readonly kitId: string;
  readonly question: string;
  readonly position: number;
  readonly attributeId: string | null;
}

type KitRow = {
  id: string;
  name: string;
  pipelineStageId: string | null;
  instructions: string | null;
  ratingScale: string[];
  isActive: boolean;
};

function requireKitName(name: unknown): string {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "a kit needs a non-blank name — name the interview it structures");
  }
  return name.trim();
}

function requireRatingScale(scale: unknown): string[] {
  if (!Array.isArray(scale) || scale.length < 2) {
    throw new RecruitingError(
      "INVALID_INPUT",
      "a kit declares at least two rating keys from strong_no, no, yes, strong_yes — the scale is what scorecards may use",
    );
  }
  const keys = scale.map(String);
  for (const key of keys) {
    if (!(CANONICAL_RATING_KEYS as readonly string[]).includes(key)) {
      throw new RecruitingError(
        "INVALID_INPUT",
        `rating key ${key} is outside the canonical vocabulary (strong_no, no, yes, strong_yes) — declare the scale from those keys`,
      );
    }
  }
  return [...new Set(keys)];
}

function toKitDTO(row: KitRow): InterviewKitDTO {
  return {
    id: row.id,
    name: row.name,
    pipelineStageId: row.pipelineStageId,
    instructions: row.instructions,
    ratingScale: row.ratingScale,
    isActive: row.isActive,
  };
}

export async function loadKit(
  exec: SqlExecutor,
  orgId: string,
  kitId: string,
): Promise<InterviewKitDTO | null> {
  const row = (await exec.execute<KitRow>(sql`
    select id, name, pipeline_stage_id as "pipelineStageId", instructions,
           rating_scale as "ratingScale", is_active as "isActive"
      from hrm_interview_kits where org_id = ${orgId} and id = ${kitId}
  `)).rows[0];
  return row ? toKitDTO(row) : null;
}

async function requireKit(exec: SqlExecutor, orgId: string, kitId: string): Promise<InterviewKitDTO> {
  const kit = await loadKit(exec, orgId, kitId);
  if (!kit) {
    throw new RecruitingError("NOT_FOUND", "interview kit is not visible in this organization");
  }
  return kit;
}

export async function listKits(query: {
  orgId: string;
  actorId: string;
  includeInactive?: boolean;
}): Promise<readonly InterviewKitDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  return withOrgTransaction(orgId, async () => {
    // Kits are shared configuration: readers read, writers need the manage
    // grant plus canonical unrestricted scope (assertUnrestrictedScope).
    await requireHrmRecruitingReadOrg(db, orgId, actorId);
    await requireDepthFeature(db, orgId, "hrmStructuredInterviews");
    const rows = (await db.execute<KitRow>(sql`
      select id, name, pipeline_stage_id as "pipelineStageId", instructions,
             rating_scale as "ratingScale", is_active as "isActive"
        from hrm_interview_kits
       where org_id = ${orgId}
         and (${query.includeInactive === true} or is_active)
       order by name
    `)).rows;
    return rows.map(toKitDTO);
  });
}

export async function createKit(query: {
  orgId: string;
  actorId: string;
  name: unknown;
  pipelineStageId?: unknown;
  instructions?: unknown;
  ratingScale?: unknown;
}): Promise<InterviewKitDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const name = requireKitName(query.name);
  const scale = query.ratingScale === undefined ? [...CANONICAL_RATING_KEYS] : requireRatingScale(query.ratingScale);
  const stageId = query.pipelineStageId == null ? null : requireId(query.pipelineStageId, "pipelineStageId");
  const instructions =
    query.instructions == null || String(query.instructions).trim().length === 0
      ? null
      : String(query.instructions);
  return withOrgTransaction(orgId, async () => {
    // Org-wide shared configuration: the manage grant, then the canonical
    // unrestricted-scope assertion (a scoped writer would reinterpret
    // another entity's pipeline).
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    assertUnrestrictedScope(await actorAllowedSubsidiaryIds(db, orgId, actorId));
    await requireDepthFeature(db, orgId, "hrmStructuredInterviews");
    if (stageId) {
      const stage = (await db.execute<{ one: number }>(sql`
        select 1 as one from hrm_pipeline_stages where org_id = ${orgId} and id = ${stageId}
      `)).rows[0];
      if (!stage) {
        throw new RecruitingError(
          "NOT_FOUND",
          "the pinned pipeline stage is not visible in this organization — pin a stage of this org's funnel or leave it unpinned",
        );
      }
    }
    try {
      const row = (await db.execute<KitRow>(sql`
        insert into hrm_interview_kits
          (org_id, name, pipeline_stage_id, instructions, rating_scale, created_by, updated_by)
        values (${orgId}, ${name}, ${stageId}, ${instructions}, ${pgTextArray(scale)}::text[], ${actorId}, ${actorId})
        returning id, name, pipeline_stage_id as "pipelineStageId", instructions,
                  rating_scale as "ratingScale", is_active as "isActive"
      `)).rows[0];
      if (!row) throw new RecruitingError("REFUSED", "the kit was not stored — no row was written; retry the request");
      return toKitDTO(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RecruitingError(
          "REFUSED",
          `an interview kit named ${name} already exists — rename the kit or reactivate the existing one`,
        );
      }
      throw error;
    }
  });
}

export async function setKitActive(query: {
  orgId: string;
  actorId: string;
  kitId: string;
  isActive: boolean;
}): Promise<InterviewKitDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const kitId = requireId(query.kitId, "kitId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    assertUnrestrictedScope(await actorAllowedSubsidiaryIds(db, orgId, actorId));
    await requireDepthFeature(db, orgId, "hrmStructuredInterviews");
    const row = (await db.execute<KitRow>(sql`
      update hrm_interview_kits
         set is_active = ${query.isActive}, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${kitId}
      returning id, name, pipeline_stage_id as "pipelineStageId", instructions,
                rating_scale as "ratingScale", is_active as "isActive"
    `)).rows[0];
    if (!row) {
      throw new RecruitingError("NOT_FOUND", "interview kit is not visible in this organization — it may belong to another org");
    }
    return toKitDTO(row);
  });
}

/** Delete a kit with no sittings. A kit with interviews is refused by name: deactivate it instead. */
export async function deleteKit(query: { orgId: string; actorId: string; kitId: string }): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const kitId = requireId(query.kitId, "kitId");
  await withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    assertUnrestrictedScope(await actorAllowedSubsidiaryIds(db, orgId, actorId));
    await requireDepthFeature(db, orgId, "hrmStructuredInterviews");
    const sittings = (await db.execute<{ count: string }>(sql`
      select count(*)::text as count from hrm_interviews where org_id = ${orgId} and kit_id = ${kitId}
    `)).rows[0];
    if (sittings && Number(sittings.count) > 0) {
      throw new RecruitingError(
        "REFUSED",
        `this kit structured ${sittings.count} interview(s) and is retained as history — set is_active = false to retire it instead of deleting it`,
      );
    }
    const deleted = (await db.execute<{ id: string }>(sql`
      delete from hrm_interview_kits where org_id = ${orgId} and id = ${kitId} returning id
    `)).rows[0];
    if (!deleted) {
      throw new RecruitingError("NOT_FOUND", "interview kit is not visible in this organization — it may belong to another org");
    }
  });
}

function requireAttributeInput(body: { category: unknown; attribute: unknown; position: unknown }): {
  category: string;
  attribute: string;
  position: number;
} {
  const category = typeof body.category === "string" && body.category.trim().length > 0 ? body.category.trim() : null;
  const attribute =
    typeof body.attribute === "string" && body.attribute.trim().length > 0 ? body.attribute.trim() : null;
  if (!category || !attribute) {
    throw new RecruitingError("INVALID_INPUT", "an attribute needs a non-blank category and attribute — name what is being rated");
  }
  if (typeof body.position !== "number" || !Number.isInteger(body.position) || body.position < 0) {
    throw new RecruitingError("INVALID_INPUT", "an attribute needs a non-negative integer position — order the kit explicitly");
  }
  return { category, attribute, position: body.position };
}

export async function addKitAttribute(query: {
  orgId: string;
  actorId: string;
  kitId: string;
  category: unknown;
  attribute: unknown;
  description?: unknown;
  position: unknown;
  isFocusDefault?: boolean;
}): Promise<ScorecardAttributeDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const kitId = requireId(query.kitId, "kitId");
  const input = requireAttributeInput(query);
  const description =
    query.description == null || String(query.description).trim().length === 0 ? null : String(query.description);
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    assertUnrestrictedScope(await actorAllowedSubsidiaryIds(db, orgId, actorId));
    await requireDepthFeature(db, orgId, "hrmStructuredInterviews");
    await requireKit(db, orgId, kitId);
    try {
      const row = (await db.execute<ScorecardAttributeDTO>(sql`
        insert into hrm_scorecard_attributes
          (org_id, kit_id, category, attribute, description, position, is_focus_default, created_by, updated_by)
        values (${orgId}, ${kitId}, ${input.category}, ${input.attribute}, ${description},
                ${input.position}, ${query.isFocusDefault === true}, ${actorId}, ${actorId})
        returning id, kit_id as "kitId", category, attribute, description, position,
                  is_focus_default as "isFocusDefault"
      `)).rows[0];
      if (!row) throw new RecruitingError("REFUSED", "the attribute was not stored — no row was written; retry the request");
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RecruitingError(
          "REFUSED",
          `position ${input.position} is already taken on this kit — order the attributes explicitly instead of stacking them`,
        );
      }
      throw error;
    }
  });
}

export async function listKitAttributes(
  exec: SqlExecutor,
  orgId: string,
  kitId: string,
): Promise<readonly ScorecardAttributeDTO[]> {
  const rows = (await exec.execute<ScorecardAttributeDTO>(sql`
    select id, kit_id as "kitId", category, attribute, description, position,
           is_focus_default as "isFocusDefault"
      from hrm_scorecard_attributes
     where org_id = ${orgId} and kit_id = ${kitId}
     order by position
  `)).rows;
  return rows;
}

export async function addKitQuestion(query: {
  orgId: string;
  actorId: string;
  kitId: string;
  question: unknown;
  position: unknown;
  attributeId?: unknown;
}): Promise<KitQuestionDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const kitId = requireId(query.kitId, "kitId");
  if (typeof query.question !== "string" || query.question.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "a kit question needs non-blank text — write the question interviewers ask");
  }
  if (typeof query.position !== "number" || !Number.isInteger(query.position) || query.position < 0) {
    throw new RecruitingError("INVALID_INPUT", "a kit question needs a non-negative integer position — order the kit explicitly");
  }
  const attributeId = query.attributeId == null ? null : requireId(query.attributeId, "attributeId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    assertUnrestrictedScope(await actorAllowedSubsidiaryIds(db, orgId, actorId));
    await requireDepthFeature(db, orgId, "hrmStructuredInterviews");
    await requireKit(db, orgId, kitId);
    if (attributeId) {
      const attr = (await db.execute<{ one: number }>(sql`
        select 1 as one from hrm_scorecard_attributes
         where org_id = ${orgId} and id = ${attributeId} and kit_id = ${kitId}
      `)).rows[0];
      if (!attr) {
        throw new RecruitingError(
          "NOT_FOUND",
          "the pinned attribute is not on this kit — pin an attribute of this kit or leave the question unpinned",
        );
      }
    }
    try {
      const row = (await db.execute<KitQuestionDTO>(sql`
        insert into hrm_interview_kit_questions
          (org_id, kit_id, question, position, attribute_id, created_by, updated_by)
        values (${orgId}, ${kitId}, ${query.question}, ${query.position}, ${attributeId}, ${actorId}, ${actorId})
        returning id, kit_id as "kitId", question, position, attribute_id as "attributeId"
      `)).rows[0];
      if (!row) throw new RecruitingError("REFUSED", "the question was not stored — no row was written; retry the request");
      return row;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new RecruitingError(
          "REFUSED",
          `position ${query.position} is already taken on this kit — order the questions explicitly instead of stacking them`,
        );
      }
      throw error;
    }
  });
}

export async function listKitQuestions(
  exec: SqlExecutor,
  orgId: string,
  kitId: string,
): Promise<readonly KitQuestionDTO[]> {
  const rows = (await exec.execute<KitQuestionDTO>(sql`
    select id, kit_id as "kitId", question, position, attribute_id as "attributeId"
      from hrm_interview_kit_questions
     where org_id = ${orgId} and kit_id = ${kitId}
     order by position
  `)).rows;
  return rows;
}
