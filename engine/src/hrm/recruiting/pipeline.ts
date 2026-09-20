import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { requireHrmRecruitingManageOrg } from "../authorization.ts";
import { RecruitingError } from "./errors.ts";
import { requireActorId, requireId, requireOrgId } from "./input.ts";

/**
 * Canonical recruiting pipeline service (HR-6, 0195): the org's own funnel.
 * Templates are configuration (Setup registry); stages are ordered rows with
 * a stable key and a kind whose terminality derives from kind. Every write
 * asserts its affected row count — a zero-row write is a refusal.
 */

export const PIPELINE_STAGE_KINDS = [
  "screening",
  "interview",
  "assessment",
  "offer",
  "hired",
  "rejected",
] as const;

export type PipelineStageKind = (typeof PIPELINE_STAGE_KINDS)[number];

export interface PipelineStageDTO {
  readonly id: string;
  readonly templateId: string;
  readonly position: number;
  readonly key: string;
  readonly name: string;
  readonly kind: PipelineStageKind;
  readonly isTerminal: boolean;
}

export interface PipelineTemplateDTO {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly isActive: boolean;
  readonly stages: readonly PipelineStageDTO[];
}

/** The default funnel seeded when hrm is enabled: applied to hired. */
const DEFAULT_TEMPLATE_NAME = "Standard hiring pipeline";
const DEFAULT_STAGES: readonly { key: string; name: string; kind: PipelineStageKind }[] = [
  { key: "applied", name: "Applied", kind: "screening" },
  { key: "screening", name: "Screening", kind: "screening" },
  { key: "interview", name: "Interview", kind: "interview" },
  { key: "offer", name: "Offer", kind: "offer" },
  { key: "hired", name: "Hired", kind: "hired" },
  { key: "rejected", name: "Rejected", kind: "rejected" },
];

function toStageDTO(row: {
  id: string;
  templateId: string;
  position: number;
  key: string;
  name: string;
  kind: string;
  isTerminal: boolean;
}): PipelineStageDTO {
  if (!(PIPELINE_STAGE_KINDS as readonly string[]).includes(row.kind)) {
    throw new RecruitingError("REFUSED", `pipeline stage ${row.id} carries unknown kind ${row.kind} — refusing a funnel the service cannot resolve`);
  }
  return {
    id: row.id,
    templateId: row.templateId,
    position: row.position,
    key: row.key,
    name: row.name,
    kind: row.kind as PipelineStageKind,
    isTerminal: row.isTerminal,
  };
}

export async function loadTemplateStages(
  exec: SqlExecutor,
  orgId: string,
  templateId: string,
): Promise<PipelineStageDTO[]> {
  const rows = (await exec.execute<{
    id: string;
    templateId: string;
    position: number;
    key: string;
    name: string;
    kind: string;
    isTerminal: boolean;
  }>(sql`
    select id, template_id as "templateId", position, key, name, kind,
           is_terminal as "isTerminal"
      from hrm_pipeline_stages
     where org_id = ${orgId} and template_id = ${templateId}
     order by position
  `)).rows;
  return rows.map(toStageDTO);
}

export async function loadPipelineTemplate(
  exec: SqlExecutor,
  orgId: string,
  templateId: string,
): Promise<PipelineTemplateDTO | null> {
  const row = (await exec.execute<{
    id: string;
    name: string;
    isDefault: boolean;
    isActive: boolean;
  }>(sql`
    select id, name, is_default as "isDefault", is_active as "isActive"
      from hrm_pipeline_templates
     where org_id = ${orgId} and id = ${templateId}
  `)).rows[0];
  if (!row) return null;
  return { ...row, stages: await loadTemplateStages(exec, orgId, templateId) };
}

export async function loadDefaultPipelineTemplate(
  exec: SqlExecutor,
  orgId: string,
): Promise<PipelineTemplateDTO | null> {
  const row = (await exec.execute<{ id: string }>(sql`
    select id from hrm_pipeline_templates
     where org_id = ${orgId} and is_default and is_active
     order by created_at limit 1
  `)).rows[0];
  if (!row) return null;
  return loadPipelineTemplate(exec, orgId, row.id);
}

/**
 * Seed the default funnel. Idempotent: an org that already holds a default
 * template keeps it (tenant edits win); only a missing default is inserted,
 * with its ordered stages. Called when the hrm feature is enabled (the
 * provisioning seed used for HRM setup rows) and lazily by requisition
 * opening, so an org enabled before HR-6 still gets its funnel.
 */
export async function ensureDefaultPipelineTemplate(
  exec: SqlExecutor,
  orgId: string,
  actorId: string | null,
): Promise<PipelineTemplateDTO> {
  const existing = await loadDefaultPipelineTemplate(exec, orgId);
  if (existing && existing.stages.length > 0) return existing;
  const templateId = existing?.id ?? null;
  if (templateId) {
    // A default row with no stages is a broken funnel, never a second
    // template: repair it in place rather than duplicating the default.
    // The do-nothing conflict arm is the concurrent-seeder race: two
    // enablers seeding the same funnel converge on one stage set, and a
    // conflict means the other writer already placed the row.
    let position = 0;
    for (const stage of DEFAULT_STAGES) {
      await exec.execute(sql`
        insert into hrm_pipeline_stages
          (org_id, template_id, position, key, name, kind, is_terminal, created_by, updated_by)
        values (${orgId}, ${templateId}, ${position}, ${stage.key}, ${stage.name}, ${stage.kind},
                ${stage.kind === "hired" || stage.kind === "rejected"},
                ${actorId}, ${actorId})
        on conflict on constraint hrm_pipeline_stages_org_template_key do nothing
      `);
      position += 1;
    }
    return (await loadPipelineTemplate(exec, orgId, templateId))!;
  }
  // The name conflict arm is the concurrent-enabler race (two writers
  // seeding the same default converge on one template row); the follow-up
  // select reads whichever writer won, so no seeder ever duplicates the
  // default.
  await exec.execute(sql`
    insert into hrm_pipeline_templates (org_id, name, is_default, is_active, created_by, updated_by)
    values (${orgId}, ${DEFAULT_TEMPLATE_NAME}, true, true, ${actorId}, ${actorId})
    on conflict on constraint hrm_pipeline_templates_org_name do nothing
  `);
  const id = (await exec.execute<{ id: string }>(sql`
    select id from hrm_pipeline_templates
     where org_id = ${orgId} and name = ${DEFAULT_TEMPLATE_NAME} limit 1
  `)).rows[0]?.id;
  if (!id) {
    throw new RecruitingError(
      "REFUSED",
      "the default hiring pipeline was not seeded — no funnel was written; retry the request",
    );
  }
  let position = 0;
  for (const stage of DEFAULT_STAGES) {
    // Same concurrent-seeder convergence as above: a conflict means the
    // stage row already stands, so the seed lands exactly one funnel.
    await exec.execute(sql`
      insert into hrm_pipeline_stages
        (org_id, template_id, position, key, name, kind, is_terminal, created_by, updated_by)
      values (${orgId}, ${id}, ${position}, ${stage.key}, ${stage.name}, ${stage.kind},
              ${stage.kind === "hired" || stage.kind === "rejected"},
              ${actorId}, ${actorId})
      on conflict on constraint hrm_pipeline_stages_org_template_key do nothing
    `);
    position += 1;
  }
  const template = await loadPipelineTemplate(exec, orgId, id);
  if (!template || template.stages.length === 0) {
    throw new RecruitingError(
      "REFUSED",
      "the default hiring pipeline was not seeded — no funnel was written; retry the request",
    );
  }
  return template;
}

/** The template's first (lowest-position) stage: every application starts here. */
export function firstStage(template: PipelineTemplateDTO): PipelineStageDTO {
  const first = template.stages[0];
  if (!first) {
    throw new RecruitingError(
      "REFUSED",
      `pipeline template ${template.id} holds no stages — add stages under Company Settings before opening requisitions on it`,
    );
  }
  return first;
}

/** The template's hired stage: reachable only through hire, never by hand. */
export function hiredStage(template: PipelineTemplateDTO): PipelineStageDTO {
  const hired = template.stages.find((stage) => stage.kind === "hired");
  if (!hired) {
    throw new RecruitingError(
      "REFUSED",
      `pipeline template ${template.id} holds no hired stage — add one under Company Settings before hiring through it`,
    );
  }
  return hired;
}

export interface CreatePipelineTemplateQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly name: unknown;
  readonly stages: readonly { key: unknown; name: unknown; kind: unknown }[];
}

/** Author a funnel through the service (the Setup registry path writes here). */
export async function createPipelineTemplate(query: CreatePipelineTemplateQuery): Promise<PipelineTemplateDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  if (typeof query.name !== "string" || query.name.trim().length === 0) {
    throw new RecruitingError("INVALID_INPUT", "template name must be non-blank");
  }
  if (query.stages.length === 0) {
    throw new RecruitingError("INVALID_INPUT", "a pipeline template holds at least one stage — add the funnel steps");
  }
  const seenKeys = new Set<string>();
  for (const stage of query.stages) {
    if (typeof stage.key !== "string" || stage.key.trim().length === 0) {
      throw new RecruitingError("INVALID_INPUT", "every pipeline stage carries a non-blank stable key");
    }
    if (typeof stage.name !== "string" || stage.name.trim().length === 0) {
      throw new RecruitingError("INVALID_INPUT", "every pipeline stage carries a non-blank name");
    }
    if (typeof stage.kind !== "string" || !(PIPELINE_STAGE_KINDS as readonly string[]).includes(stage.kind)) {
      throw new RecruitingError(
        "INVALID_INPUT",
        `pipeline stage kind must be one of ${PIPELINE_STAGE_KINDS.join(", ")} — check the stage kind`,
      );
    }
    if (seenKeys.has(stage.key)) {
      throw new RecruitingError("INVALID_INPUT", `pipeline stage key ${JSON.stringify(stage.key)} repeats — keys are unique per template`);
    }
    seenKeys.add(stage.key);
  }
  if (!query.stages.some((stage) => stage.kind === "hired")) {
    throw new RecruitingError("INVALID_INPUT", "a pipeline template holds a hired stage — the funnel ends in hired or rejected, never in a step");
  }
  return withOrgTransaction(orgId, async () => {
    await requireHrmRecruitingManageOrg(db, orgId, actorId);
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into hrm_pipeline_templates (org_id, name, is_default, is_active, created_by, updated_by)
      values (${orgId}, ${query.name as string}, false, true, ${actorId}, ${actorId})
      returning id
    `)).rows[0];
    if (!inserted) {
      throw new RecruitingError("REFUSED", "the pipeline template was not stored — no row was written; retry the request");
    }
    let position = 0;
    for (const stage of query.stages) {
      const kind = stage.kind as PipelineStageKind;
      await db.execute(sql`
        insert into hrm_pipeline_stages
          (org_id, template_id, position, key, name, kind, is_terminal, created_by, updated_by)
        values (${orgId}, ${inserted.id}, ${position},
                ${stage.key as string}, ${stage.name as string}, ${kind},
                ${kind === "hired" || kind === "rejected"}, ${actorId}, ${actorId})
      `);
      position += 1;
    }
    return (await loadPipelineTemplate(db, orgId, inserted.id))!;
  });
}

export interface GetPipelineTemplateQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly templateId: string;
}

/** Read one funnel (any recruiting reader; the Setup drawer resolves through here). */
export async function getPipelineTemplate(query: GetPipelineTemplateQuery): Promise<PipelineTemplateDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const templateId = requireId(query.templateId, "templateId");
  // Config visibility rides the manage grant (the Setup registry fences the
  // same writes behind admin.setup.manage); reads stay inside the module.
  await requireHrmRecruitingManageOrg(db, orgId, actorId);
  const template = await loadPipelineTemplate(db, orgId, templateId);
  if (!template) {
    throw new RecruitingError("NOT_FOUND", "pipeline template is not visible in this organization");
  }
  return template;
}
