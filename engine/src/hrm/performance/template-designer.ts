import { parseRatingScale } from "./performance-math.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../../platform/db.ts";
import { actorHasPermission } from "../../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../../organization/actor-subsidiaries.ts";
import { lockAndCheckOrgFeature } from "../../organization/org-feature-lock.ts";
import { HrmAuthorizationError } from "../authorization.ts";
import { inputGuards } from "../input-guards.ts";
import {
  HrmPerformanceError,
  isUniqueViolationOn,
  mathRefusal,
} from "./errors.ts";
import {
  validateReviewTemplateDocument,
  type ReviewTemplateDocument,
  type ReviewTemplateDocumentDTO,
} from "./template-document.ts";
const { requireUuid } = inputGuards(
  (message) => new HrmPerformanceError("INVALID_INPUT", message),
);

async function authorize(orgId: string, actorId: string, write: boolean) {
  if (!(await lockAndCheckOrgFeature(db, orgId, "hrmPerformance")))
    throw new HrmPerformanceError(
      "FEATURE_OFF",
      "Enable Performance in Company Settings → Features before managing review templates.",
    );
  const permitted =
    (await actorHasPermission(db, orgId, actorId, "admin.setup.manage")) ||
    (await actorHasPermission(db, orgId, actorId, "hrm.performance.manage")) ||
    (!write &&
      (await actorHasPermission(db, orgId, actorId, "hrm.performance.read")));
  if (!permitted)
    throw new HrmAuthorizationError(
      "Review templates require Performance access or Setup management. Ask an administrator to grant the appropriate access.",
    );
  if (write && (await actorAllowedSubsidiaryIds(db, orgId, actorId)) !== null)
    throw new HrmAuthorizationError(
      "Review templates are organization-wide configuration. Ask an unrestricted administrator to save or publish this template.",
    );
}
type Stored = {
  id: string;
  name: string;
  ratingScale: ReviewTemplateDocument["ratingScale"];
  isActive: boolean;
  revision: number;
  publishedVersion: number;
  draft: ReviewTemplateDocument | null;
  published: ReviewTemplateDocument | null;
  cycleCount: number;
};
async function read(
  orgId: string,
  id: string,
): Promise<ReviewTemplateDocumentDTO> {
  const row = (
    await db.execute<Stored>(sql`select t.id,t.name,t.rating_scale as "ratingScale",t.is_active as "isActive",t.revision,
    t.published_version as "publishedVersion",t.draft_document as draft,t.published_document as published,
    (select count(*)::int from hrm_review_cycles c where c.org_id=t.org_id and c.template_id=t.id) as "cycleCount"
    from hrm_review_templates t where t.org_id=${orgId} and t.id=${id}`)
  ).rows[0];
  if (!row)
    throw new HrmPerformanceError(
      "NOT_FOUND",
      "This review template is not available. Return to the template list.",
    );
  let legacy: ReviewTemplateDocument | null = null;
  if (!row.draft && !row.published) {
    const sections = (
      await db.execute<{
        id: string;
        title: string;
        kind: ReviewTemplateDocument["sections"][number]["kind"];
        weight: string | null;
        competencyId: string | null;
      }>(
        sql`select id,title,kind,weight::text as weight,competency_id as "competencyId" from hrm_review_template_sections where org_id=${orgId} and template_id=${id} order by position`,
      )
    ).rows;
    const scale = mathRefusal("REFUSED", () =>
      parseRatingScale(row.ratingScale),
    );
    legacy = {
      name: row.name,
      instructions: "",
      ratingScale: { ...scale, labels: [...scale.labels] },
      sections: [],
    };
    for (const section of sections) {
      const questions = (
        await db.execute<
          ReviewTemplateDocument["sections"][number]["questions"][number]
        >(
          sql`select id,prompt,answer_kind as "answerKind",required from hrm_review_template_questions where org_id=${orgId} and section_id=${section.id} order by position`,
        )
      ).rows;
      legacy.sections.push({ ...section, questions });
    }
  }
  return {
    id,
    revision: row.revision,
    publishedVersion: row.publishedVersion,
    isActive: row.isActive,
    cycleCount: row.cycleCount,
    draft: row.draft ?? row.published ?? legacy!,
    published: row.published ?? (row.draft ? null : legacy),
  };
}
export async function listTemplateDocuments(args: {
  orgId: string;
  actorId: string;
}): Promise<ReviewTemplateDocumentDTO[]> {
  const orgId = requireUuid(args.orgId, "orgId"),
    actorId = requireUuid(args.actorId, "actorId");
  return withOrgTransaction(orgId, async () => {
    await authorize(orgId, actorId, false);
    const rows = (
      await db.execute<{ id: string }>(
        sql`select id from hrm_review_templates where org_id=${orgId} order by name,id`,
      )
    ).rows;
    return Promise.all(rows.map((row) => read(orgId, row.id)));
  });
}
/** Published rows are a projection for native configuration readers. Drafts never change them. */
async function publishProjection(
  orgId: string,
  actorId: string,
  templateId: string,
  document: ReviewTemplateDocument,
) {
  await db.execute(
    sql`update hrm_review_templates set rating_scale=jsonb_build_object('min',${document.ratingScale.min}::numeric,'max',${document.ratingScale.max}::numeric,'labels',${JSON.stringify(document.ratingScale.labels)}::jsonb) where org_id=${orgId} and id=${templateId}`,
  );
  // Vacate unique positions while preserving identifiers and creation evidence.
  await db.execute(
    sql`update hrm_review_template_sections set position=position+1000000 where org_id=${orgId} and template_id=${templateId}`,
  );
  await db.execute(
    sql`update hrm_review_template_questions q set position=q.position+1000000 where q.org_id=${orgId} and exists(select 1 from hrm_review_template_sections s where s.org_id=q.org_id and s.id=q.section_id and s.template_id=${templateId})`,
  );
  for (const [position, section] of document.sections.entries()) {
    const written =
      await db.execute(sql`insert into hrm_review_template_sections(id,org_id,template_id,position,title,kind,weight,competency_id,created_by,updated_by)
      values(${section.id},${orgId},${templateId},${position},${section.title},${section.kind},${section.weight ?? null}::numeric,${section.competencyId ?? null},${actorId},${actorId})
      on conflict(id) do update set position=excluded.position,title=excluded.title,kind=excluded.kind,weight=excluded.weight,competency_id=excluded.competency_id,updated_by=excluded.updated_by,updated_at=now()
      where hrm_review_template_sections.org_id=excluded.org_id and hrm_review_template_sections.template_id=excluded.template_id returning id`);
    if (written.rowCount !== 1)
      throw new HrmPerformanceError(
        "REFUSED",
        "A section identifier is unavailable. Recreate that section in the template editor and publish again.",
      );
    for (const [questionPosition, question] of section.questions.entries()) {
      const written =
        await db.execute(sql`insert into hrm_review_template_questions(id,org_id,section_id,position,prompt,answer_kind,required,created_by,updated_by)
        values(${question.id},${orgId},${section.id},${questionPosition},${question.prompt},${question.answerKind},${question.required},${actorId},${actorId})
        on conflict(id) do update set section_id=excluded.section_id,position=excluded.position,prompt=excluded.prompt,answer_kind=excluded.answer_kind,required=excluded.required,updated_by=excluded.updated_by,updated_at=now()
        where hrm_review_template_questions.org_id=excluded.org_id and exists(select 1 from hrm_review_template_sections s where s.org_id=hrm_review_template_questions.org_id and s.id=hrm_review_template_questions.section_id and s.template_id=${templateId}) returning id`);
      if (written.rowCount !== 1)
        throw new HrmPerformanceError(
          "REFUSED",
          "A question identifier is unavailable. Recreate that question in the template editor and publish again.",
        );
    }
  }
  const sectionIds = document.sections.map((s) => s.id),
    questionIds = document.sections.flatMap((s) =>
      s.questions.map((q) => q.id),
    );
  await db.execute(
    sql`delete from hrm_review_template_questions q where q.org_id=${orgId} and q.id not in (select jsonb_array_elements_text(${JSON.stringify(questionIds)}::jsonb)::uuid) and exists(select 1 from hrm_review_template_sections s where s.org_id=q.org_id and s.id=q.section_id and s.template_id=${templateId})`,
  );
  await db.execute(
    sql`delete from hrm_review_template_sections where org_id=${orgId} and template_id=${templateId} and id not in (select jsonb_array_elements_text(${JSON.stringify(sectionIds)}::jsonb)::uuid)`,
  );
}
export async function listTemplateCompetencies(args: {
  orgId: string;
  actorId: string;
}): Promise<{ value: string; label: string }[]> {
  const orgId = requireUuid(args.orgId, "orgId"),
    actorId = requireUuid(args.actorId, "actorId");
  return withOrgTransaction(orgId, async () => {
    await authorize(orgId, actorId, false);
    return (
      await db.execute<{ value: string; label: string }>(
        sql`select c.id as value,c.name||' · '||f.name as label from hrm_competencies c join hrm_competency_frameworks f on f.org_id=c.org_id and f.id=c.framework_id where c.org_id=${orgId} order by f.name,c.name,c.id`,
      )
    ).rows;
  });
}
export async function saveTemplateDocument(args: {
  orgId: string;
  actorId: string;
  id?: string;
  revision?: number;
  document: ReviewTemplateDocument;
  publish: boolean;
  isActive?: boolean;
}): Promise<ReviewTemplateDocumentDTO> {
  const orgId = requireUuid(args.orgId, "orgId"),
    actorId = requireUuid(args.actorId, "actorId");
  const document = validateReviewTemplateDocument(args.document, args.publish);
  try {
    return await withOrgTransaction(orgId, async () => {
      await authorize(orgId, actorId, true);
      for (const section of document.sections)
        if (section.competencyId) {
          const found = (
            await db.execute(
              sql`select 1 from hrm_competencies where org_id=${orgId} and id=${section.competencyId}`,
            )
          ).rows[0];
          if (!found)
            throw new HrmPerformanceError(
              "REFUSED",
              "The section competency is not available in this organization. Choose an available competency.",
            );
        }
      let id = args.id ? requireUuid(args.id, "templateId") : null;
      let before: ReviewTemplateDocumentDTO | null = null;
      if (id) {
        const locked = (
          await db.execute<{ id: string }>(
            sql`select id from hrm_review_templates where org_id=${orgId} and id=${id} for update`,
          )
        ).rows[0];
        if (!locked)
          throw new HrmPerformanceError(
            "NOT_FOUND",
            "This review template is no longer available. Return to the template list.",
          );
        before = await read(orgId, id);
        if (args.revision !== before.revision)
          throw new HrmPerformanceError(
            "STALE_REVISION",
            "Another administrator changed this template. Reload it before saving; your changes have not been applied.",
          );
        const changed = (
          await db.execute(sql`update hrm_review_templates set draft_document=${JSON.stringify(document)}::jsonb,
        published_document=case when ${args.publish} then ${JSON.stringify(document)}::jsonb else coalesce(published_document,${before?.published ? JSON.stringify(before.published) : null}::jsonb) end,
        published_version=published_version+case when ${args.publish} then 1 else 0 end,
        is_active=${args.isActive ?? before.isActive}, name=case when ${args.publish} then ${document.name} else name end, revision=revision+1,updated_at=now(),updated_by=${actorId}
        where org_id=${orgId} and id=${id} and revision=${args.revision}`)
        ).rowCount;
        if (changed !== 1)
          throw new HrmPerformanceError(
            "STALE_REVISION",
            "The template changed while saving. Reload it and retry.",
          );
      } else {
        const row = (
          await db.execute<{
            id: string;
          }>(sql`insert into hrm_review_templates(org_id,name,draft_document,published_document,published_version,is_active,created_by,updated_by)
        values(${orgId},${document.name},${JSON.stringify(document)}::jsonb,${args.publish ? JSON.stringify(document) : null}::jsonb,${args.publish ? 1 : 0},${args.isActive ?? true},${actorId},${actorId}) returning id`)
        ).rows[0];
        if (!row)
          throw new HrmPerformanceError(
            "REFUSED",
            "The template was not saved. Retry the save.",
          );
        id = row.id;
      }
      if (args.publish) await publishProjection(orgId, actorId, id, document);
      const after = await read(orgId, id);
      await db.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
      values(${orgId},'hrm_review_templates',${id},${before ? "update" : "insert"},${JSON.stringify({ event: args.publish ? "template_published" : "template_draft_saved", before, after })}::jsonb,${actorId})`);
      return after;
    });
  } catch (error) {
    if (isUniqueViolationOn(error, "hrm_review_templates_org_name"))
      throw new HrmPerformanceError(
        "REFUSED",
        "A review template already uses that name. Choose a distinct template name.",
      );
    throw error;
  }
}
