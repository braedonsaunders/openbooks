import 'server-only'
import { sql } from 'drizzle-orm'
import { db, type SqlExecutor } from '@openbooks/engine/src/platform/db.ts'
import { lockAndCheckOrgFeature } from '@openbooks/engine/src/organization/org-feature-lock.ts'
import { isUuid } from '../list-params'
import { UNRESTRICTED_SCOPE_REQUIRED } from '../subsidiaries'
import { auditSetupChange } from './audit'
import type { SetupActor, SetupWriteResult } from './write'
import type {
  PipelineStageKind,
  PipelineStageNode,
  PipelineTemplateNode,
  ReviewAnswerKind,
  ReviewOutlineOrder,
  ReviewSectionKind,
  ReviewSectionNode,
  ReviewTemplateNode,
} from './hrm-builder-outline'

/**
 * Reads and ordering commands for the review-template and hiring-pipeline
 * builders (/admin/setup/review-templates, /admin/setup/hiring-pipelines).
 *
 * Row fields are written through the shared Setup writer
 * (/api/admin/setup/[entity], write.ts), so the builders share its
 * validation, feature fence and audit. What that writer cannot express
 * lives here:
 *
 * - Ordering. Positions are unique per parent and the constraints are not
 *   deferrable, so a swap through two row PATCHes collides with itself.
 *   The order commands rewrite every position of one parent in a single
 *   transaction: every row is lifted clear of the final range first, then
 *   placed. The submitted set must equal the stored set — an order built
 *   on a stale outline is refused, never half-applied.
 * - The default pipeline. Exactly one default per org is a partial unique
 *   index, so switching the default clears the old one and sets the new one
 *   in one transaction.
 */

/** Positions are lifted above any real index before being placed. */
const LIFT = 1_000_000

type Refusal = { status: number; body: { error: string; code?: string } }

class BuilderRefusal extends Error {
  constructor(readonly result: Refusal) {
    super(result.body.error)
  }
}

function refuse(status: number, error: string, code?: string): never {
  throw new BuilderRefusal({ status, body: code ? { error, code } : { error } })
}

function scopeRefusal(actor: SetupActor): SetupWriteResult | null {
  return actor.allowedSubsidiaryIds !== undefined && actor.allowedSubsidiaryIds !== null
    ? { status: 403, body: { error: UNRESTRICTED_SCOPE_REQUIRED } }
    : null
}

async function runCommand(actor: SetupActor, write: (tx: SqlExecutor) => Promise<void>): Promise<SetupWriteResult> {
  const scoped = scopeRefusal(actor)
  if (scoped) return scoped
  try {
    await db.transaction(async (tx) => {
      if (!(await lockAndCheckOrgFeature(tx, actor.orgId, 'hrm'))) refuse(404, 'unknown setup entity')
      await write(tx)
    })
    return { status: 200, body: { ok: true } }
  } catch (error) {
    if (error instanceof BuilderRefusal) return error.result
    throw error
  }
}

function uniqueIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !isUuid(id))) {
    refuse(400, `${label} must be a list of record ids`, 'invalid')
  }
  const ids = value as string[]
  if (new Set(ids).size !== ids.length) refuse(400, `${label} lists a record twice`, 'invalid')
  return ids
}

function sameSet(submitted: readonly string[], stored: readonly string[]): boolean {
  if (submitted.length !== stored.length) return false
  const known = new Set(stored)
  return submitted.every((id) => known.has(id))
}

/** Stamp the audit pair only on rows whose placement actually moved. */
function touched(changed: boolean, actorId: string) {
  return changed ? sql`, updated_by = ${actorId}, updated_at = now()` : sql``
}

const STALE = 'The outline changed since it was loaded — reload the page and reorder again'

// ---------------------------------------------------------------------------
// Review templates
// ---------------------------------------------------------------------------

export interface ReviewTemplateSummary {
  id: string
  name: string
  isActive: boolean
  scaleMin: string
  scaleMax: string
  sectionCount: number
  questionCount: number
  cycleCount: number
}

function scaleBound(scale: unknown, key: 'min' | 'max', fallback: string): string {
  const value = scale && typeof scale === 'object' ? (scale as Record<string, unknown>)[key] : undefined
  return typeof value === 'number' || typeof value === 'string' ? String(value) : fallback
}

function scaleLabels(scale: unknown): string[] {
  const labels = scale && typeof scale === 'object' ? (scale as Record<string, unknown>).labels : undefined
  return Array.isArray(labels) ? labels.filter((label): label is string => typeof label === 'string') : []
}

export async function listReviewTemplates(orgId: string): Promise<ReviewTemplateSummary[]> {
  const rows = (await db.execute<{
    id: string; name: string; isActive: boolean; ratingScale: unknown
    sectionCount: number; questionCount: number; cycleCount: number
  }>(sql`
    select t.id, t.name, t.is_active as "isActive", t.rating_scale as "ratingScale",
           (select count(*)::int from hrm_review_template_sections s
             where s.org_id = t.org_id and s.template_id = t.id) as "sectionCount",
           (select count(*)::int from hrm_review_template_questions q
              join hrm_review_template_sections s on s.org_id = q.org_id and s.id = q.section_id
             where q.org_id = t.org_id and s.template_id = t.id) as "questionCount",
           (select count(*)::int from hrm_review_cycles c
             where c.org_id = t.org_id and c.template_id = t.id) as "cycleCount"
      from hrm_review_templates t
     where t.org_id = ${orgId}
     order by t.is_active desc, t.name`)).rows
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    isActive: row.isActive,
    scaleMin: scaleBound(row.ratingScale, 'min', '1'),
    scaleMax: scaleBound(row.ratingScale, 'max', '5'),
    sectionCount: row.sectionCount,
    questionCount: row.questionCount,
    cycleCount: row.cycleCount,
  }))
}

export async function loadReviewTemplate(orgId: string, templateId: string): Promise<ReviewTemplateNode | null> {
  if (!isUuid(templateId)) return null
  const template = (await db.execute<{ id: string; name: string; isActive: boolean; ratingScale: unknown; cycleCount: number }>(sql`
    select t.id, t.name, t.is_active as "isActive", t.rating_scale as "ratingScale",
           (select count(*)::int from hrm_review_cycles c
             where c.org_id = t.org_id and c.template_id = t.id) as "cycleCount"
      from hrm_review_templates t
     where t.org_id = ${orgId} and t.id = ${templateId}`)).rows[0]
  if (!template) return null
  const [sections, questions] = await Promise.all([
    db.execute<{ id: string; position: number; title: string; kind: ReviewSectionKind; weight: string | null; competencyId: string | null }>(sql`
      select id, position, title, kind, weight::text as weight, competency_id as "competencyId"
        from hrm_review_template_sections
       where org_id = ${orgId} and template_id = ${templateId}
       order by position`),
    db.execute<{ id: string; sectionId: string; position: number; prompt: string; answerKind: ReviewAnswerKind; required: boolean }>(sql`
      select q.id, q.section_id as "sectionId", q.position, q.prompt, q.answer_kind as "answerKind", q.required
        from hrm_review_template_questions q
        join hrm_review_template_sections s on s.org_id = q.org_id and s.id = q.section_id
       where q.org_id = ${orgId} and s.template_id = ${templateId}
       order by q.position`),
  ])
  const nodes: ReviewSectionNode[] = sections.rows.map((section) => ({
    ...section,
    weight: section.weight === null ? null : trimDecimal(section.weight),
    questions: questions.rows.filter((question) => question.sectionId === section.id),
  }))
  return {
    id: template.id,
    name: template.name,
    isActive: template.isActive,
    scaleMin: scaleBound(template.ratingScale, 'min', '1'),
    scaleMax: scaleBound(template.ratingScale, 'max', '5'),
    scaleLabels: scaleLabels(template.ratingScale),
    cycleCount: template.cycleCount,
    sections: nodes,
  }
}

/** numeric(19,4) reads back as "10.0000"; the inspector edits "10". */
function trimDecimal(value: string): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value
}

export interface CompetencyOption {
  id: string
  label: string
  framework: string
}

export async function listCompetencyOptions(orgId: string): Promise<CompetencyOption[]> {
  const rows = (await db.execute<{ id: string; code: string; name: string; framework: string }>(sql`
    select c.id, c.code, c.name, f.name as framework
      from hrm_competencies c
      join hrm_competency_frameworks f on f.org_id = c.org_id and f.id = c.framework_id
     where c.org_id = ${orgId} and f.is_active
     order by f.name, c.position, c.name`)).rows
  return rows.map((row) => ({ id: row.id, label: `${row.code} · ${row.name}`, framework: row.framework }))
}

/**
 * Rewrite the section order of one template and the question order (and
 * section membership) of every question in it, in one transaction.
 */
export async function orderReviewTemplateOutline(
  actor: SetupActor,
  templateId: string,
  body: unknown,
): Promise<SetupWriteResult> {
  if (!isUuid(templateId)) return { status: 404, body: { error: 'not_found' } }
  return runCommand(actor, async (tx) => {
    const order = body as Partial<ReviewOutlineOrder> | null
    if (!order || !Array.isArray(order.sections)) refuse(400, 'sections must list the template sections in order', 'invalid')
    const sectionIds = uniqueIds(order.sections.map((section) => section?.id), 'sections')
    const placements = order.sections.map((section) => ({
      sectionId: section.id,
      questionIds: uniqueIds(section.questionIds, 'questionIds'),
    }))
    const questionIds = placements.flatMap((placement) => placement.questionIds)
    if (new Set(questionIds).size !== questionIds.length) refuse(400, 'questionIds lists a question twice', 'invalid')

    const template = (await tx.execute(sql`
      select id,draft_document as draft,published_document as published from hrm_review_templates where org_id = ${actor.orgId} and id = ${templateId} for update`)).rows[0]
    if (!template) refuse(404, 'not_found')
    if(template.draft||template.published)refuse(409,'Use Performance → Templates to reorder this published document and save its draft.','managed-document')
    const storedSections = (await tx.execute<{ id: string; position: number }>(sql`
      select id, position from hrm_review_template_sections
       where org_id = ${actor.orgId} and template_id = ${templateId}
       for update`)).rows
    const storedQuestions = (await tx.execute<{ id: string; sectionId: string; position: number }>(sql`
      select q.id, q.section_id as "sectionId", q.position
        from hrm_review_template_questions q
        join hrm_review_template_sections s on s.org_id = q.org_id and s.id = q.section_id
       where q.org_id = ${actor.orgId} and s.template_id = ${templateId}
       for update of q`)).rows
    if (!sameSet(sectionIds, storedSections.map((row) => row.id))) refuse(409, STALE, 'stale')
    if (!sameSet(questionIds, storedQuestions.map((row) => row.id))) refuse(409, STALE, 'stale')

    await tx.execute(sql`
      update hrm_review_template_sections set position = position + ${LIFT}
       where org_id = ${actor.orgId} and template_id = ${templateId}`)
    await tx.execute(sql`
      update hrm_review_template_questions q set position = q.position + ${LIFT}
        from hrm_review_template_sections s
       where s.org_id = q.org_id and s.id = q.section_id
         and q.org_id = ${actor.orgId} and s.template_id = ${templateId}`)

    const sectionBefore = new Map(storedSections.map((row) => [row.id, row.position]))
    for (const [position, id] of sectionIds.entries()) {
      await tx.execute(sql`
        update hrm_review_template_sections
           set position = ${position}
               ${touched(sectionBefore.get(id) !== position, actor.id)}
         where org_id = ${actor.orgId} and id = ${id}`)
      if (sectionBefore.get(id) !== position) {
        await auditSetupChange({
          orgId: actor.orgId, table: 'hrm_review_template_sections', rowId: id, action: 'update',
          changes: { before: { position: sectionBefore.get(id) }, after: { position } }, actorId: actor.id,
        }, tx)
      }
    }

    const questionBefore = new Map(storedQuestions.map((row) => [row.id, row]))
    for (const placement of placements) {
      for (const [position, id] of placement.questionIds.entries()) {
        const before = questionBefore.get(id)!
        const changed = before.position !== position || before.sectionId !== placement.sectionId
        await tx.execute(sql`
          update hrm_review_template_questions
             set section_id = ${placement.sectionId}, position = ${position}
                 ${touched(changed, actor.id)}
           where org_id = ${actor.orgId} and id = ${id}`)
        if (changed) {
          await auditSetupChange({
            orgId: actor.orgId, table: 'hrm_review_template_questions', rowId: id, action: 'update',
            changes: {
              before: { sectionId: before.sectionId, position: before.position },
              after: { sectionId: placement.sectionId, position },
            },
            actorId: actor.id,
          }, tx)
        }
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Hiring pipelines
// ---------------------------------------------------------------------------

export interface PipelineTemplateSummary {
  id: string
  name: string
  isDefault: boolean
  isActive: boolean
  requisitionCount: number
  stages: { id: string; name: string; kind: PipelineStageKind }[]
}

export async function listPipelineTemplates(orgId: string): Promise<PipelineTemplateSummary[]> {
  const [templates, stages] = await Promise.all([
    db.execute<{ id: string; name: string; isDefault: boolean; isActive: boolean; requisitionCount: number }>(sql`
      select t.id, t.name, t.is_default as "isDefault", t.is_active as "isActive",
             (select count(*)::int from hrm_requisitions r
               where r.org_id = t.org_id and r.pipeline_template_id = t.id) as "requisitionCount"
        from hrm_pipeline_templates t
       where t.org_id = ${orgId}
       order by t.is_default desc, t.is_active desc, t.name`),
    db.execute<{ id: string; templateId: string; name: string; kind: PipelineStageKind }>(sql`
      select id, template_id as "templateId", name, kind
        from hrm_pipeline_stages
       where org_id = ${orgId}
       order by template_id, position`),
  ])
  return templates.rows.map((template) => ({
    ...template,
    stages: stages.rows
      .filter((stage) => stage.templateId === template.id)
      .map(({ id, name, kind }) => ({ id, name, kind })),
  }))
}

export async function loadPipelineTemplateNode(orgId: string, templateId: string): Promise<PipelineTemplateNode | null> {
  if (!isUuid(templateId)) return null
  const template = (await db.execute<{ id: string; name: string; isDefault: boolean; isActive: boolean; requisitionCount: number }>(sql`
    select t.id, t.name, t.is_default as "isDefault", t.is_active as "isActive",
           (select count(*)::int from hrm_requisitions r
             where r.org_id = t.org_id and r.pipeline_template_id = t.id) as "requisitionCount"
      from hrm_pipeline_templates t
     where t.org_id = ${orgId} and t.id = ${templateId}`)).rows[0]
  if (!template) return null
  const [stages, kits] = await Promise.all([
    db.execute<Omit<PipelineStageNode, 'kits'>>(sql`
      select s.id, s.position, s.key, s.name, s.kind, s.is_terminal as "isTerminal",
             (select count(*)::int from hrm_applications a
               where a.org_id = s.org_id and a.stage_id = s.id and a.status = 'active') as "activeApplications",
             (select count(*)::int from hrm_applications a
               where a.org_id = s.org_id and a.stage_id = s.id) as "totalApplications"
        from hrm_pipeline_stages s
       where s.org_id = ${orgId} and s.template_id = ${templateId}
       order by s.position`),
    db.execute<{ id: string; name: string; isActive: boolean; stageId: string }>(sql`
      select k.id, k.name, k.is_active as "isActive", k.pipeline_stage_id as "stageId"
        from hrm_interview_kits k
        join hrm_pipeline_stages s on s.org_id = k.org_id and s.id = k.pipeline_stage_id
       where k.org_id = ${orgId} and s.template_id = ${templateId}
       order by k.name`),
  ])
  return {
    ...template,
    stages: stages.rows.map((stage) => ({
      ...stage,
      kits: kits.rows.filter((kit) => kit.stageId === stage.id).map(({ id, name, isActive }) => ({ id, name, isActive })),
    })),
  }
}

/** Rewrite the stage order of one pipeline in one transaction. */
export async function orderPipelineStages(
  actor: SetupActor,
  templateId: string,
  body: unknown,
): Promise<SetupWriteResult> {
  if (!isUuid(templateId)) return { status: 404, body: { error: 'not_found' } }
  return runCommand(actor, async (tx) => {
    const stageIds = uniqueIds((body as { stageIds?: unknown } | null)?.stageIds, 'stageIds')
    const template = (await tx.execute(sql`
      select id from hrm_pipeline_templates where org_id = ${actor.orgId} and id = ${templateId} for update`)).rows[0]
    if (!template) refuse(404, 'not_found')
    const stored = (await tx.execute<{ id: string; position: number }>(sql`
      select id, position from hrm_pipeline_stages
       where org_id = ${actor.orgId} and template_id = ${templateId}
       for update`)).rows
    if (!sameSet(stageIds, stored.map((row) => row.id))) refuse(409, STALE, 'stale')
    await tx.execute(sql`
      update hrm_pipeline_stages set position = position + ${LIFT}
       where org_id = ${actor.orgId} and template_id = ${templateId}`)
    const before = new Map(stored.map((row) => [row.id, row.position]))
    for (const [position, id] of stageIds.entries()) {
      const changed = before.get(id) !== position
      await tx.execute(sql`
        update hrm_pipeline_stages
           set position = ${position}
               ${touched(changed, actor.id)}
         where org_id = ${actor.orgId} and id = ${id}`)
      if (changed) {
        await auditSetupChange({
          orgId: actor.orgId, table: 'hrm_pipeline_stages', rowId: id, action: 'update',
          changes: { before: { position: before.get(id) }, after: { position } }, actorId: actor.id,
        }, tx)
      }
    }
  })
}

/**
 * Make one pipeline the org default: new requisitions open on it when none
 * is named. Only an active pipeline can be the default.
 */
export async function makeDefaultPipeline(actor: SetupActor, templateId: string): Promise<SetupWriteResult> {
  if (!isUuid(templateId)) return { status: 404, body: { error: 'not_found' } }
  return runCommand(actor, async (tx) => {
    const rows = (await tx.execute<{ id: string; isDefault: boolean; isActive: boolean }>(sql`
      select id, is_default as "isDefault", is_active as "isActive"
        from hrm_pipeline_templates where org_id = ${actor.orgId}
       for update`)).rows
    const target = rows.find((row) => row.id === templateId)
    if (!target) refuse(404, 'not_found')
    if (target.isDefault) return
    if (!target.isActive) refuse(400, 'Activate this pipeline before making it the default', 'invalid')
    for (const previous of rows.filter((row) => row.isDefault)) {
      await tx.execute(sql`
        update hrm_pipeline_templates set is_default = false, updated_by = ${actor.id}, updated_at = now()
         where org_id = ${actor.orgId} and id = ${previous.id}`)
      await auditSetupChange({
        orgId: actor.orgId, table: 'hrm_pipeline_templates', rowId: previous.id, action: 'update',
        changes: { before: { is_default: true }, after: { is_default: false } }, actorId: actor.id,
      }, tx)
    }
    await tx.execute(sql`
      update hrm_pipeline_templates set is_default = true, updated_by = ${actor.id}, updated_at = now()
       where org_id = ${actor.orgId} and id = ${templateId}`)
    await auditSetupChange({
      orgId: actor.orgId, table: 'hrm_pipeline_templates', rowId: templateId, action: 'update',
      changes: { before: { is_default: false }, after: { is_default: true } }, actorId: actor.id,
    }, tx)
  })
}
