import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { businessToday } from "../../platform/business-date.ts";
import {
  loadApprovalPerson,
  loadManagedEmploymentIds,
  requireAggregatePerformanceManage,
  requireAggregatePerformanceRead,
  requireHrmPerformanceOnEmployment,
} from "../authorization.ts";
import { HRM_FEATURE_KEY } from "../employment-read.ts";
import { HrmPerformanceError, isUniqueViolationOn } from "./errors.ts";
import { HRM_PERFORMANCE_CONTINUOUS_KEY } from "./one-on-ones.ts";

/**
 * Governed HRM competency frameworks (0228, HR-17): frameworks,
 * competencies, ranked levels, and links.
 *
 * The same competency is what a review section asks about, what a job
 * level expects, and what a career path shows: hrm_competency_links
 * attaches one competency to job_level, position, or
 * review_template_section targets. Writes verify the target row exists
 * in this org (a link to a missing job level is refused by name, never
 * stored dangling). Review template sections carry a nullable
 * competency_id (0228 additive column) so the review renders the level
 * expectations inline at drafting time.
 *
 * Frameworks are Setup-registry configuration (HR manage writes,
 * performance read lists); deactivation preserves history, never
 * deletes it.
 *
 * Do not touch packages/payroll. Existing refusal classes are untouched.
 */

export const HRM_COMPETENCIES_KEY = "hrmCompetencies" as const;

export type CompetencyLinkKind = "job_level" | "position" | "review_template_section";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function requireId(field: string, value: unknown): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new HrmPerformanceError("INVALID_INPUT", `${field} must be a uuid`);
  }
  return value;
}

async function assertCompetenciesFeature(db: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, HRM_FEATURE_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrm feature is disabled: enable it on Company Settings → Features before opening competency frameworks",
    );
  }
  if (!(await lockAndCheckOrgFeature(db, orgId, HRM_PERFORMANCE_CONTINUOUS_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrmPerformance feature is disabled: enable it on Company Settings → Features before opening competency frameworks",
    );
  }
  if (!(await lockAndCheckOrgFeature(db, orgId, HRM_COMPETENCIES_KEY))) {
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "hrmCompetencies feature is disabled: enable it on Company Settings → Features before opening competency frameworks",
    );
  }
}

/**
 * The actor's HR scope for competency reads: the allowed employer set
 * (null = unrestricted), or undefined when the actor holds no HR grant
 * at all. The grant alone is never the whole answer — every caller
 * applies the returned Set to the subject it reads.
 */
async function performanceReadScope(
  db: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<Set<string> | null | undefined> {
  try {
    return await requireAggregatePerformanceRead(db, orgId, actorId);
  } catch {
    return undefined;
  }
}

async function requireCompetenciesRead(
  db: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<Set<string> | null> {
  // Framework and level reads are org configuration with no per-subject
  // rows, so those callers await the grant and ignore the scope;
  // per-subject reads (the profile below) must apply it.
  const scope = await performanceReadScope(db, orgId, actorId);
  if (scope === undefined) {
    throw new HrmPerformanceError(
      "FORBIDDEN",
      "competency frameworks need hrm.performance.read — ask an administrator to grant it in /admin/roles",
    );
  }
  return scope;
}

export interface CompetencyLevelDTO {
  readonly id: string;
  readonly levelRank: number;
  readonly label: string;
  readonly expectation: string;
}

export interface CompetencyDTO {
  readonly id: string;
  readonly frameworkId: string;
  readonly code: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
  readonly position: number;
  readonly levels: readonly CompetencyLevelDTO[];
}

export interface CompetencyFrameworkDTO {
  readonly id: string;
  readonly name: string;
  readonly appliesTo: Record<string, unknown>;
  readonly isActive: boolean;
  readonly competencies: readonly CompetencyDTO[];
}

export async function createFramework(args: {
  orgId: string;
  actorId: string;
  name: string;
  appliesTo?: Record<string, unknown> | null;
}): Promise<CompetencyFrameworkDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  if (typeof args.name !== "string" || args.name.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "a competency framework needs a name — say which workforce it describes");
  }
  return withOrgTransaction(orgId, async () => {
    await assertCompetenciesFeature(db, orgId);
    await requireAggregatePerformanceManage(db, orgId, actorId);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into hrm_competency_frameworks (org_id, name, applies_to, created_by, updated_by)
      values (${orgId}, ${args.name.trim()}, ${JSON.stringify(args.appliesTo ?? {})}::jsonb, ${actorId}, ${actorId})
      returning id
    `)).rows[0];
    if (!inserted) throw new HrmPerformanceError("REFUSED", "the framework was not stored — no row was written; retry the action");
    const framework = await getFramework({ orgId, actorId, id: inserted.id });
    if (!framework) throw new HrmPerformanceError("REFUSED", "the framework was not stored — no row can be read back; retry the action");
    return framework;
  });
}

export async function setFrameworkActive(args: {
  orgId: string;
  actorId: string;
  id: string;
  isActive: boolean;
}): Promise<void> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const id = requireId("id", args.id);
  await withOrgTransaction(orgId, async () => {
    await assertCompetenciesFeature(db, orgId);
    await requireAggregatePerformanceManage(db, orgId, actorId);
    const updated = (await db.execute<{ id: string }>(sql`
      update hrm_competency_frameworks set is_active = ${args.isActive}, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${id}
      returning id
    `)).rows;
    if (updated.length !== 1) {
      throw new HrmPerformanceError("NOT_FOUND", "competency framework was not found — it may belong to another organization");
    }
  });
}

export async function getFramework(args: {
  orgId: string;
  actorId: string;
  id: string;
}): Promise<CompetencyFrameworkDTO | null> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const id = requireId("id", args.id);
  return withOrgTransaction(orgId, async () => {
    await assertCompetenciesFeature(db, orgId);
    await requireCompetenciesRead(db, orgId, actorId);
    const frameworks = (await db.execute<{ id: string; name: string; applies_to: unknown; is_active: boolean }>(sql`
      select id, name, applies_to, is_active from hrm_competency_frameworks where org_id = ${orgId} and id = ${id}
    `)).rows;
    const framework = frameworks[0];
    if (!framework) return null;
    return {
      id: framework.id,
      name: framework.name,
      appliesTo: (framework.applies_to ?? {}) as Record<string, unknown>,
      isActive: framework.is_active,
      competencies: await loadCompetencies(db, orgId, framework.id),
    };
  });
}

export async function listFrameworks(args: { orgId: string; actorId: string }): Promise<readonly CompetencyFrameworkDTO[]> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  return withOrgTransaction(orgId, async () => {
    await assertCompetenciesFeature(db, orgId);
    await requireCompetenciesRead(db, orgId, actorId);
    const frameworks = (await db.execute<{ id: string; name: string; applies_to: unknown; is_active: boolean }>(sql`
      select id, name, applies_to, is_active from hrm_competency_frameworks where org_id = ${orgId} order by name
    `)).rows;
    const out: CompetencyFrameworkDTO[] = [];
    for (const framework of frameworks) {
      out.push({
        id: framework.id,
        name: framework.name,
        appliesTo: (framework.applies_to ?? {}) as Record<string, unknown>,
        isActive: framework.is_active,
        competencies: await loadCompetencies(db, orgId, framework.id),
      });
    }
    return out;
  });
}

async function loadCompetencies(db: SqlExecutor, orgId: string, frameworkId: string): Promise<CompetencyDTO[]> {
  const rows = (await db.execute<{
    id: string; framework_id: string; code: string; name: string;
    description: string | null; category: string | null; position: number;
  }>(sql`
    select id, framework_id, code, name, description, category, position
      from hrm_competencies where org_id = ${orgId} and framework_id = ${frameworkId}
     order by position, name
  `)).rows;
  const out: CompetencyDTO[] = [];
  for (const row of rows) {
    const levels = (await db.execute<{ id: string; level_rank: number; label: string; expectation: string }>(sql`
      select id, level_rank, label, expectation from hrm_competency_levels
       where org_id = ${orgId} and competency_id = ${row.id} order by level_rank
    `)).rows;
    out.push({
      id: row.id, frameworkId: row.framework_id, code: row.code, name: row.name,
      description: row.description, category: row.category, position: row.position,
      levels: levels.map((level) => ({ id: level.id, levelRank: level.level_rank, label: level.label, expectation: level.expectation })),
    });
  }
  return out;
}

export async function createCompetency(args: {
  orgId: string;
  actorId: string;
  frameworkId: string;
  code: string;
  name: string;
  description?: string | null;
  category?: string | null;
}): Promise<CompetencyDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const frameworkId = requireId("frameworkId", args.frameworkId);
  if (typeof args.code !== "string" || args.code.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "a competency needs a code — say which shorthand reviews and job levels use");
  }
  if (typeof args.name !== "string" || args.name.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "a competency needs a name — say what the skill is");
  }
  return withOrgTransaction(orgId, async () => {
    await assertCompetenciesFeature(db, orgId);
    await requireAggregatePerformanceManage(db, orgId, actorId);
    const framework = (await db.execute<{ id: string }>(sql`
      select id from hrm_competency_frameworks where org_id = ${orgId} and id = ${frameworkId}
    `)).rows[0];
    if (!framework) {
      throw new HrmPerformanceError("NOT_FOUND", "competency framework was not found — create the competency under an existing framework");
    }
    const maxPos = (await db.execute<{ max: number }>(sql`
      select coalesce(max(position), -1) as max from hrm_competencies where org_id = ${orgId} and framework_id = ${frameworkId}
    `)).rows[0]?.max ?? -1;
    try {
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into hrm_competencies (org_id, framework_id, code, name, description, category, position, created_by, updated_by)
        values (${orgId}, ${frameworkId}, ${args.code.trim()}, ${args.name.trim()},
                ${args.description ?? null}, ${args.category ?? null}, ${maxPos + 1}, ${actorId}, ${actorId})
        returning id
      `)).rows[0];
      if (!inserted) throw new HrmPerformanceError("REFUSED", "the competency was not stored — no row was written; retry the action");
      const all = await loadCompetencies(db, orgId, frameworkId);
      const created = all.find((c) => c.id === inserted.id);
      if (!created) throw new HrmPerformanceError("REFUSED", "the competency was not stored — no row can be read back; retry the action");
      return created;
    } catch (e) {
      if (isUniqueViolationOn(e, "hrm_competencies_unique_code")) {
        throw new HrmPerformanceError("DUPLICATE", `code ${JSON.stringify(args.code.trim())} already exists in this framework — reuse it or pick another code`);
      }
      throw e;
    }
  });
}

export async function addCompetencyLevel(args: {
  orgId: string;
  actorId: string;
  competencyId: string;
  levelRank: number;
  label: string;
  expectation: string;
}): Promise<CompetencyLevelDTO> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const competencyId = requireId("competencyId", args.competencyId);
  if (!Number.isInteger(args.levelRank) || args.levelRank < 1) {
    throw new HrmPerformanceError("INVALID_INPUT", "level rank must be a positive integer — rank 1 is the entry expectation");
  }
  if (typeof args.label !== "string" || args.label.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "a competency level needs a label — say what this rank is called");
  }
  if (typeof args.expectation !== "string" || args.expectation.trim().length === 0) {
    throw new HrmPerformanceError("INVALID_INPUT", "a competency level needs an expectation — say what good looks like at this rank");
  }
  return withOrgTransaction(orgId, async () => {
    await assertCompetenciesFeature(db, orgId);
    await requireAggregatePerformanceManage(db, orgId, actorId);
    const competency = (await db.execute<{ id: string }>(sql`
      select id from hrm_competencies where org_id = ${orgId} and id = ${competencyId}
    `)).rows[0];
    if (!competency) {
      throw new HrmPerformanceError("NOT_FOUND", "competency was not found — add the level under an existing competency");
    }
    try {
      const inserted = (await db.execute<{ id: string }>(sql`
        insert into hrm_competency_levels (org_id, competency_id, level_rank, label, expectation)
        values (${orgId}, ${competencyId}, ${args.levelRank}, ${args.label.trim()}, ${args.expectation.trim()})
        returning id
      `)).rows[0];
      if (!inserted) throw new HrmPerformanceError("REFUSED", "the level was not stored — no row was written; retry the action");
      return { id: inserted.id, levelRank: args.levelRank, label: args.label.trim(), expectation: args.expectation.trim() };
    } catch (e) {
      if (isUniqueViolationOn(e, "hrm_competency_levels_unique_rank")) {
        throw new HrmPerformanceError(
          "DUPLICATE",
          `rank ${args.levelRank} already exists on this competency — edit that level instead of adding a second`,
        );
      }
      throw e;
    }
  });
}

export async function linkCompetency(args: {
  orgId: string;
  actorId: string;
  competencyId: string;
  targetKind: CompetencyLinkKind;
  targetId: string;
}): Promise<void> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const competencyId = requireId("competencyId", args.competencyId);
  const targetId = requireId("targetId", args.targetId);
  if (!["job_level", "position", "review_template_section"].includes(args.targetKind)) {
    throw new HrmPerformanceError("INVALID_INPUT", "link target must be job_level, position, or review_template_section");
  }
  await withOrgTransaction(orgId, async () => {
    await assertCompetenciesFeature(db, orgId);
    await requireAggregatePerformanceManage(db, orgId, actorId);
    const competency = (await db.execute<{ id: string }>(sql`
      select id from hrm_competencies where org_id = ${orgId} and id = ${competencyId}
    `)).rows[0];
    if (!competency) {
      throw new HrmPerformanceError("NOT_FOUND", "competency was not found — link an existing competency");
    }
    // Feature-tolerant links: the target row must exist in this org, or
    // the link is refused by name — never stored dangling. One static
    // query per kind (no dynamic table names cross this boundary).
    const target =
      args.targetKind === "job_level"
        ? (await db.execute<{ id: string }>(sql`select id from hrm_job_levels where org_id = ${orgId} and id = ${targetId}`)).rows[0]
        : args.targetKind === "position"
          ? (await db.execute<{ id: string }>(sql`select id from positions where org_id = ${orgId} and id = ${targetId}`)).rows[0]
          : (await db.execute<{ id: string }>(sql`select id from hrm_review_template_sections where org_id = ${orgId} and id = ${targetId}`)).rows[0];
    if (!target) {
      const remedy =
        args.targetKind === "job_level"
          ? "pick a job level from the compensation job architecture"
          : args.targetKind === "position"
            ? "pick a position from the directory"
            : "pick a section from an existing review template";
      throw new HrmPerformanceError("NOT_FOUND", `${args.targetKind} was not found in this organization — ${remedy}`);
    }
    const person = await loadApprovalPerson(db, orgId, actorId);
    await db.execute(sql`
      insert into hrm_competency_links (org_id, competency_id, target_kind, target_id, created_by)
      values (${orgId}, ${competencyId}, ${args.targetKind}, ${targetId}, ${person.partyId ?? actorId})
      on conflict do nothing
    `);
    // on conflict do nothing is benign here by construction: the link is
    // idempotent vocabulary wiring, and the unique (org, competency,
    // kind, target) makes a repeat exactly the same row. The read below
    // proves the effect — a save no read can observe is not a save.
    const linked = (await db.execute<{ id: string }>(sql`
      select id from hrm_competency_links
       where org_id = ${orgId} and competency_id = ${competencyId} and target_kind = ${args.targetKind} and target_id = ${targetId}
    `)).rows[0];
    if (!linked) {
      throw new HrmPerformanceError("REFUSED", "the competency link was not stored — no row can be read back; retry the action");
    }
  });
}

export async function setSectionCompetency(args: {
  orgId: string;
  actorId: string;
  sectionId: string;
  competencyId: string | null;
}): Promise<void> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const sectionId = requireId("sectionId", args.sectionId);
  if (args.competencyId !== null) requireId("competencyId", args.competencyId);
  await withOrgTransaction(orgId, async () => {
    await assertCompetenciesFeature(db, orgId);
    await requireAggregatePerformanceManage(db, orgId, actorId);
    const section = (await db.execute<{ id: string }>(sql`
      select id from hrm_review_template_sections where org_id = ${orgId} and id = ${sectionId}
    `)).rows[0];
    if (!section) {
      throw new HrmPerformanceError("NOT_FOUND", "review template section was not found — attach the competency to an existing section");
    }
    if (args.competencyId) {
      const competency = (await db.execute<{ id: string }>(sql`
        select id from hrm_competencies where org_id = ${orgId} and id = ${args.competencyId}
      `)).rows[0];
      if (!competency) {
        throw new HrmPerformanceError("NOT_FOUND", "competency was not found — attach an existing competency");
      }
    }
    const updated = (await db.execute<{ id: string }>(sql`
      update hrm_review_template_sections set competency_id = ${args.competencyId}, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${sectionId}
      returning id
    `)).rows;
    if (updated.length !== 1) {
      throw new HrmPerformanceError("STALE_REVISION", "the template section changed under you — reload it and try again");
    }
  });
}

export interface CompetencyProfileRow {
  readonly sectionTitle: string;
  readonly competencyName: string;
  readonly assessedRating: string | null;
  readonly levels: readonly CompetencyLevelDTO[];
}

/**
 * Expected vs assessed for one employment from their last calibrated (or
 * shared) manager review: each template section carrying a competency
 * reads its level expectations beside the assessed answer rating. HR,
 * the subject, and the line manager may read it — the same audience as
 * the review itself.
 */
/**
 * Subject-relation half of the competency profile audience: the subject
 * themselves, or their line manager as of today — the same rule as the
 * other performance reads. Strangers keep the grant refusal, so the
 * profile keeps hiding for readers without the performance grant.
 */
async function requireProfileRelation(
  db: SqlExecutor,
  orgId: string,
  actorId: string,
  employmentId: string,
): Promise<void> {
  const person = await loadApprovalPerson(db, orgId, actorId);
  const subject = (await db.execute<{ workerPartyId: string }>(sql`
    select worker_party_id as "workerPartyId" from worker_employments
     where org_id = ${orgId} and id = ${employmentId}
  `)).rows[0];
  if (!subject) {
    throw new HrmPerformanceError(
      "NOT_FOUND",
      `competency profile for employment ${employmentId} is not visible in this organization — check the id or the organization`,
    );
  }
  if (person.partyId !== null && person.partyId === subject.workerPartyId) return;
  const managed = await loadManagedEmploymentIds(db, orgId, actorId, await businessToday(orgId));
  if (managed.includes(employmentId)) return;
  throw new HrmPerformanceError(
    "FORBIDDEN",
    "competency frameworks need hrm.performance.read — ask an administrator to grant it in /admin/roles",
  );
}

export async function competencyProfileForEmployment(args: {
  orgId: string;
  actorId: string;
  employmentId: string;
}): Promise<readonly CompetencyProfileRow[]> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const employmentId = requireId("employmentId", args.employmentId);
  return withOrgTransaction(orgId, async () => {
    await assertCompetenciesFeature(db, orgId);
    // Subject plus allowed-employer fence before any profile read: HR
    // reads only employments inside their allowed subsidiaries (the
    // returned Set is the fence, never discarded); everyone else only
    // their own employment or a direct report's — the same audience as
    // the review itself.
    const scope = await performanceReadScope(db, orgId, actorId);
    if (scope === undefined) {
      await requireProfileRelation(db, orgId, actorId, employmentId);
    } else {
      await requireHrmPerformanceOnEmployment(db, orgId, actorId, employmentId, "hrm.performance.read");
    }
    const reviews = (await db.execute<{ id: string; cycle_id: string }>(sql`
      select r.id, r.cycle_id
        from hrm_reviews r
        join hrm_review_cycles c on c.org_id = r.org_id and c.id = r.cycle_id
       where r.org_id = ${orgId} and r.employment_id = ${employmentId}
         and r.kind = 'manager' and r.status in ('calibrated', 'shared', 'acknowledged')
       order by c.period_end_on desc, r.created_at desc
       limit 1
    `)).rows;
    const review = reviews[0];
    if (!review) return [];
    const answers = (await db.execute<{ section_title: string; rating: string | null }>(sql`
      select section_title, rating::text as rating from hrm_review_answers
       where org_id = ${orgId} and review_id = ${review.id}
    `)).rows;
    const assessed = new Map<string, string | null>();
    for (const answer of answers) {
      if (!assessed.has(answer.section_title)) assessed.set(answer.section_title, answer.rating);
    }
    const cycle = (await db.execute<{ template_id: string }>(sql`
      select template_id from hrm_review_cycles where org_id = ${orgId} and id = ${review.cycle_id}
    `)).rows[0];
    if (!cycle) return [];
    const sections = (await db.execute<{ id: string; title: string; competency_id: string | null; competency_name: string | null }>(sql`
      select s.id, s.title, s.competency_id::text as competency_id, c.name as competency_name
        from hrm_review_template_sections s
        left join hrm_competencies c on c.org_id = s.org_id and c.id = s.competency_id
       where s.org_id = ${orgId} and s.template_id = ${cycle.template_id} and s.competency_id is not null
       order by s.position
    `)).rows;
    const out: CompetencyProfileRow[] = [];
    for (const section of sections) {
      const levels = (await db.execute<{ id: string; level_rank: number; label: string; expectation: string }>(sql`
        select id, level_rank, label, expectation from hrm_competency_levels
         where org_id = ${orgId} and competency_id = ${section.competency_id} order by level_rank
      `)).rows;
      out.push({
        sectionTitle: section.title,
        competencyName: section.competency_name ?? section.title,
        assessedRating: assessed.get(section.title) ?? null,
        levels: levels.map((level) => ({ id: level.id, levelRank: level.level_rank, label: level.label, expectation: level.expectation })),
      });
    }
    return out;
  });
}

/**
 * Level expectations for a review template section: what the review
 * drafting renders inline beside the section's questions.
 */
export async function levelExpectationsForSection(args: {
  orgId: string;
  actorId: string;
  sectionId: string;
}): Promise<readonly CompetencyLevelDTO[]> {
  const orgId = requireId("orgId", args.orgId);
  const actorId = requireId("actorId", args.actorId);
  const sectionId = requireId("sectionId", args.sectionId);
  return withOrgTransaction(orgId, async () => {
    await assertCompetenciesFeature(db, orgId);
    await requireCompetenciesRead(db, orgId, actorId);
    const section = (await db.execute<{ competency_id: string | null }>(sql`
      select competency_id::text as competency_id from hrm_review_template_sections where org_id = ${orgId} and id = ${sectionId}
    `)).rows[0];
    if (!section?.competency_id) return [];
    const levels = (await db.execute<{ id: string; level_rank: number; label: string; expectation: string }>(sql`
      select id, level_rank, label, expectation from hrm_competency_levels
       where org_id = ${orgId} and competency_id = ${section.competency_id} order by level_rank
    `)).rows;
    return levels.map((level) => ({ id: level.id, levelRank: level.level_rank, label: level.label, expectation: level.expectation }));
  });
}
