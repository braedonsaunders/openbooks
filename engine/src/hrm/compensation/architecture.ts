import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import {
  requireHrmCompensationManage,
  requireHrmCompensationRead,
} from "../authorization.ts";
import { CompensationError } from "./errors.ts";
import { requireActorId, requireId, requireOrgId, requireReason } from "../recruiting/input.ts";

/**
 * Job architecture (HR-12, 0221): families and levels plus the
 * compensation settings document.
 *
 * Families are stable per-org craft identity; levels are rungs on one
 * ladder (NULL family = the org-wide ladder). A level never moves
 * ladders — retire and recreate instead — and a family with levels
 * cannot be deleted (RESTRICT), only retired. Every conditional write
 * asserts its affected row count: a zero-row write is a refusal, never
 * a success.
 */

export interface JobFamilyDTO {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly isActive: boolean;
}

export interface EqualValueCriterion {
  readonly criterion: "skills" | "effort" | "responsibility" | "working_conditions";
  readonly weight: string;
}

export interface JobLevelDTO {
  readonly id: string;
  readonly familyId: string | null;
  readonly code: string;
  readonly name: string;
  readonly rank: number;
  readonly equalValueCriteria: readonly EqualValueCriterion[];
  readonly isActive: boolean;
}

export type FteRounding = "up_to_whole" | "nearest_tenth" | "nearest_hundredth";

export interface CompensationSettings {
  /** Declared party custom-field key naming the two comparison groups. Null = not configured (gap snapshots refuse by name). */
  readonly comparisonAttributeKey: string | null;
  /** Unexplained-gap percent at or above which a category flags joint assessment due. Default 5. */
  readonly gapThresholdPct: number;
  /** Days after request when a pay-information answer is due. Null = required setting missing. */
  readonly responseDays: number | null;
  readonly fteRounding: FteRounding;
  /** Declared burden rate (decimal fraction, e.g. "0.18"). Null = resolve from labor-costing percent_of_wage/worker_comp components. */
  readonly burdenRate: string | null;
}

export const DEFAULT_COMPENSATION_SETTINGS: CompensationSettings = {
  comparisonAttributeKey: null,
  gapThresholdPct: 5,
  responseDays: null,
  fteRounding: "up_to_whole",
  burdenRate: null,
};

/** The org's compensation settings document (orgs.settings->'compensation'), with declared defaults. */
export async function compensationSettings(orgId: string): Promise<CompensationSettings> {
  const r = (await db.execute<{ c: Record<string, unknown> | null }>(
    sql`select settings->'compensation' as c from orgs where id = ${orgId}`,
  ));
  const c = r.rows[0]?.c ?? {};
  const gap = c.gapThresholdPct;
  const days = c.responseDays;
  const rounding = c.fteRounding;
  const burden = c.burdenRate;
  const comparison = c.comparisonAttributeKey;
  return {
    comparisonAttributeKey:
      typeof comparison === "string" && comparison.trim().length > 0 ? comparison.trim() : null,
    gapThresholdPct: typeof gap === "number" && Number.isFinite(gap) && gap >= 0 ? gap : 5,
    responseDays:
      typeof days === "number" && Number.isInteger(days) && days > 0 ? days : null,
    fteRounding:
      rounding === "nearest_tenth" || rounding === "nearest_hundredth" ? rounding : "up_to_whole",
    burdenRate: typeof burden === "string" && burden.trim().length > 0 ? burden.trim() : null,
  };
}

/** Walk the driver-error cause chain for a Postgres SQLSTATE (Drizzle wraps the pg error). */
function pgCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === "object"; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause ?? null;
  }
  return null;
}

function requireFamilyCode(code: unknown): string {
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new CompensationError("INVALID_INPUT", "a job family code is required — codes are the stable handle bands and levels cite");
  }
  return code.trim().slice(0, 40);
}

function requireCriteria(input: unknown): EqualValueCriterion[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new CompensationError(
      "REFUSED",
      "a job level needs at least one equal-value criterion (skills, effort, responsibility, working_conditions) with a weight — the directive requires the criteria to be declared, never implied",
    );
  }
  const allowed = ["skills", "effort", "responsibility", "working_conditions"] as const;
  return input.map((entry, i) => {
    const e = entry as Record<string, unknown>;
    if (!e || typeof e !== "object" || !allowed.includes(e.criterion as (typeof allowed)[number])) {
      throw new CompensationError(
        "INVALID_INPUT",
        `criterion ${i + 1} must name one of skills, effort, responsibility, working_conditions — correct the level instead of guessing its basis`,
      );
    }
    const weight = e.weight;
    if (typeof weight !== "string" || !/^-?\d+(\.\d+)?$/.test(weight) || !(Number(weight) > 0)) {
      throw new CompensationError(
        "INVALID_INPUT",
        `criterion ${i + 1} needs a positive weight — weightless criteria cannot order equal value`,
      );
    }
    return { criterion: e.criterion as EqualValueCriterion["criterion"], weight };
  });
}

type FamilyRow = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  is_active: boolean;
};

function toFamilyDTO(row: FamilyRow): JobFamilyDTO {
  return { id: row.id, code: row.code, name: row.name, description: row.description, isActive: row.is_active };
}

type LevelRow = {
  id: string;
  family_id: string | null;
  code: string;
  name: string;
  rank: number;
  equal_value_criteria: EqualValueCriterion[];
  is_active: boolean;
};

function toLevelDTO(row: LevelRow): JobLevelDTO {
  return {
    id: row.id,
    familyId: row.family_id,
    code: row.code,
    name: row.name,
    rank: row.rank,
    equalValueCriteria: row.equal_value_criteria,
    isActive: row.is_active,
  };
}

export interface CreateJobFamilyQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly code: string;
  readonly name: string;
  readonly description?: string | null;
}

export async function createJobFamily(query: CreateJobFamilyQuery): Promise<JobFamilyDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const code = requireFamilyCode(query.code);
  if (typeof query.name !== "string" || query.name.trim().length === 0) {
    throw new CompensationError("INVALID_INPUT", "a job family name is required");
  }
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    try {
      const row = (await db.execute<FamilyRow>(sql`
        insert into hrm_job_families (org_id, code, name, description, created_by, updated_by)
        values (${orgId}, ${code}, ${query.name.trim().slice(0, 160)},
                ${query.description?.trim().slice(0, 2000) ?? null}, ${actorId}, ${actorId})
        returning id, code, name, description, is_active`)).rows[0];
      if (!row) throw new CompensationError("REFUSED", "the family insert matched no row — the save is refused, never a silent success");
      return toFamilyDTO(row);
    } catch (e) {
      if (e instanceof CompensationError) throw e;
      if (pgCode(e) === "23505") {
        throw new CompensationError(
          "REFUSED",
          `job family code ${JSON.stringify(code)} already exists in this organization — codes are unique per org; rename or reactivate the existing family`,
        );
      }
      throw e;
    }
  });
}

export interface UpdateJobFamilyQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly familyId: string;
  readonly name?: string | null;
  readonly description?: string | null;
  readonly isActive?: boolean | null;
  readonly reason: string;
}

export async function updateJobFamily(query: UpdateJobFamilyQuery): Promise<JobFamilyDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const familyId = requireId(query.familyId, "familyId");
  const reason = requireReason(query.reason);
  void reason;
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    const row = (await db.execute<FamilyRow>(sql`
      update hrm_job_families
         set name = coalesce(${query.name?.trim().slice(0, 160) ?? null}, name),
             description = coalesce(${query.description?.trim().slice(0, 2000) ?? null}, description),
             is_active = coalesce(${query.isActive ?? null}, is_active),
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${familyId}
       returning id, code, name, description, is_active`)).rows[0];
    if (!row) {
      throw new CompensationError("NOT_FOUND", "job family is not visible in this organization");
    }
    return toFamilyDTO(row);
  });
}

export async function listJobFamilies(query: { orgId: string; actorId: string; includeInactive?: boolean }): Promise<readonly JobFamilyDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  await requireHrmCompensationRead(db, orgId, actorId);
  const rows = (await db.execute<FamilyRow>(sql`
    select id, code, name, description, is_active
      from hrm_job_families
     where org_id = ${orgId} and (${query.includeInactive === true} or is_active)
     order by code`)).rows;
  return rows.map(toFamilyDTO);
}

export interface CreateJobLevelQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly familyId?: string | null;
  readonly code: string;
  readonly name: string;
  readonly rank: number;
  readonly equalValueCriteria: unknown;
}

export async function createJobLevel(query: CreateJobLevelQuery): Promise<JobLevelDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const code = requireFamilyCode(query.code);
  if (typeof query.name !== "string" || query.name.trim().length === 0) {
    throw new CompensationError("INVALID_INPUT", "a job level name is required");
  }
  if (!Number.isInteger(query.rank) || query.rank < 1) {
    throw new CompensationError("INVALID_INPUT", "a job level rank is a positive integer ordering the ladder — rank 1 is entry");
  }
  const criteria = requireCriteria(query.equalValueCriteria);
  const familyId = query.familyId ?? null;
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    if (familyId !== null) {
      const family = (await db.execute<{ id: string }>(sql`
        select id from hrm_job_families where org_id = ${orgId} and id = ${familyId}`)).rows[0];
      if (!family) {
        throw new CompensationError(
          "NOT_FOUND",
          "the named family is not visible in this organization — create the rung on a family you can see, or on the org-wide ladder",
        );
      }
    }
    try {
      const row = (await db.execute<LevelRow>(sql`
        insert into hrm_job_levels (org_id, family_id, code, name, rank, equal_value_criteria, created_by, updated_by)
        values (${orgId}, ${familyId}, ${code}, ${query.name.trim().slice(0, 160)},
                ${query.rank}, ${JSON.stringify(criteria)}::jsonb, ${actorId}, ${actorId})
        returning id, family_id, code, name, rank, equal_value_criteria, is_active`)).rows[0];
      if (!row) throw new CompensationError("REFUSED", "the level insert matched no row — the save is refused, never a silent success");
      return toLevelDTO(row as LevelRow);
    } catch (e) {
      if (e instanceof CompensationError) throw e;
      if (pgCode(e) === "23505") {
        throw new CompensationError(
          "REFUSED",
          `level code ${JSON.stringify(code)} at rank ${query.rank} collides in this ladder — one code and one rank per ladder; rename or re-rank instead of duplicating`,
        );
      }
      throw e;
    }
  });
}

export interface UpdateJobLevelQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly levelId: string;
  readonly name?: string | null;
  readonly rank?: number | null;
  readonly equalValueCriteria?: unknown;
  readonly isActive?: boolean | null;
  readonly reason: string;
}

/**
 * Retire, rename, re-rank or re-declare a level. The ladder (family_id)
 * is deliberately NOT updatable: a level never moves ladders — retire
 * it and recreate on the right one, so band scopes citing it keep
 * meaning what they meant.
 */
export async function updateJobLevel(query: UpdateJobLevelQuery): Promise<JobLevelDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const levelId = requireId(query.levelId, "levelId");
  const reason = requireReason(query.reason);
  void reason;
  const criteria = query.equalValueCriteria === undefined ? null : requireCriteria(query.equalValueCriteria);
  if (query.rank !== undefined && query.rank !== null && (!Number.isInteger(query.rank) || query.rank < 1)) {
    throw new CompensationError("INVALID_INPUT", "a job level rank is a positive integer ordering the ladder — rank 1 is entry");
  }
  return withOrgTransaction(orgId, async () => {
    await requireHrmCompensationManage(db, orgId, actorId);
    try {
      const row = (await db.execute<LevelRow>(sql`
        update hrm_job_levels
           set name = coalesce(${query.name?.trim().slice(0, 160) ?? null}, name),
               rank = coalesce(${query.rank ?? null}, rank),
               equal_value_criteria = coalesce(${criteria === null ? null : JSON.stringify(criteria)}::jsonb, equal_value_criteria),
               is_active = coalesce(${query.isActive ?? null}, is_active),
               updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${levelId}
         returning id, family_id, code, name, rank, equal_value_criteria, is_active`)).rows[0];
      if (!row) {
        throw new CompensationError("NOT_FOUND", "job level is not visible in this organization");
      }
      return toLevelDTO(row as LevelRow);
    } catch (e) {
      if (e instanceof CompensationError) throw e;
      if (pgCode(e) === "23505") {
        throw new CompensationError(
          "REFUSED",
          "the new rank is already taken in this ladder — two rungs cannot both be the same rung; re-rank instead of duplicating",
        );
      }
      throw e;
    }
  });
}

export async function listJobLevels(query: {
  orgId: string;
  actorId: string;
  familyId?: string | null;
  includeInactive?: boolean;
}): Promise<readonly JobLevelDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  await requireHrmCompensationRead(db, orgId, actorId);
  const rows = (await db.execute<LevelRow>(sql`
    select l.id, l.family_id, l.code, l.name, l.rank, l.equal_value_criteria, l.is_active
      from hrm_job_levels l
     where l.org_id = ${orgId}
       and (${query.familyId === undefined} or l.family_id is not distinct from ${query.familyId ?? null})
       and (${query.includeInactive === true} or l.is_active)
     order by l.family_id nulls first, l.rank`)).rows;
  return rows.map((row) => toLevelDTO(row as LevelRow));
}

/** True when the actor holds the org-wide compensation read (for aggregate surfaces). */
export async function actorCanReadCompensation(exec: SqlExecutor, orgId: string, actorId: string): Promise<boolean> {
  return actorHasPermission(exec, orgId, actorId, "hrm.compensation.read");
}

