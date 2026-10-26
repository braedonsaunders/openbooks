import "server-only";
import { sql } from "drizzle-orm";
import type { SqlExecutor } from "@openbooks/engine/platform/db";
import {
  parseRatingScale,
  PerformanceMathError,
} from "@openbooks/engine/hrm/performance/performance-math";
import type { SetupEntity } from "./registry";
import { validateCategoryKey } from "@openbooks/engine/hrm/documents/categories";
import { validateTemplateInput } from "@openbooks/engine/hrm/documents/templates";
import { mergeTemplateSlots } from "./hrm-document-template";
import { INTEGRITY_CONTINUES, type SetupIntegrityVerdict } from "./write-shared";

/** Ordered setup integrity rules: HRM review templates, document templates, retention schedules and document categories. */
export async function validateReviewIntegrity(
  entity: SetupEntity,
  body: Record<string, unknown>,
  orgId: string,
  rowId: string | undefined,
  executor: SqlExecutor,
): Promise<SetupIntegrityVerdict> {
  // HRM review templates (0196): the rating scale is refused with the
  // engine's own words before the write, merging the current row on edit
  // so a partial slot edit keeps the untouched bound. Sections prove
  // their parent template and questions prove their parent section, both
  // visible in this org — a form that can never open is refused by field
  // name instead of saved as openable.
  if (
    [
      "hrm-review-templates",
      "hrm-review-template-sections",
      "hrm-review-template-questions",
    ].includes(entity.key)
  ) {
    // All authoring paths lock the parent, including legacy rows. A first
    // document save cannot capture an outline while another editor mutates it.
    const parent = rowId
      ? entity.key === "hrm-review-templates"
        ? sql`t.id=${rowId}`
        : entity.key === "hrm-review-template-sections"
          ? sql`exists(select 1 from hrm_review_template_sections s where s.org_id=t.org_id and s.template_id=t.id and s.id=${rowId})`
          : sql`exists(select 1 from hrm_review_template_sections s join hrm_review_template_questions q on q.org_id=s.org_id and q.section_id=s.id where s.org_id=t.org_id and s.template_id=t.id and q.id=${rowId})`
      : entity.key === "hrm-review-template-sections" && typeof body.templateId === "string"
        ? sql`t.id=${body.templateId}`
        : entity.key === "hrm-review-template-questions" && typeof body.sectionId === "string"
          ? sql`exists(select 1 from hrm_review_template_sections s where s.org_id=t.org_id and s.template_id=t.id and s.id=${body.sectionId})`
          : null;
    if (parent) {
      const template = (
        await executor.execute(
          sql`select t.draft_document as draft,t.published_document as published from hrm_review_templates t where t.org_id=${orgId} and ${parent} for update of t`,
          "objects",
        )
      )[0];
      if (template && (template.draft || template.published))
        return "Use Performance → Templates to edit this document, save its draft, and publish the next version.";
    }
  }
  if (entity.key === "hrm-review-templates") {
    let scale = body.ratingScale as Record<string, unknown> | undefined;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select rating_scale as "ratingScale" from hrm_review_templates where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Review template not found";
      const base = (current[0] as Record<string, unknown>).ratingScale;
      scale = { ...((base ?? {}) as Record<string, unknown>), ...(scale ?? {}) };
    }
    try {
      parseRatingScale(scale ?? {});
    } catch (e) {
      if (e instanceof PerformanceMathError) return e.message;
      throw e;
    }
    // The merged scale is what writes: a partial slot edit keeps the
    // untouched bound instead of storing a partial scale the storage
    // CHECK would refuse with a worse message.
    body.ratingScale = scale;
  }
  // Document templates (0230) — the folded signer/merge
  // slots are proved with the engine's own words (validateTemplateInput
  // shares the API's validation; never a second classifier) and the
  // category must be declared in hrm_document_categories. Edits merge
  // the stored row first so a partial slot edit keeps the untouched
  // signer set (review-template precedent).
  if (entity.key === "hrm-document-templates") {
    let current: { signer_roles?: unknown; merge_fields?: unknown } | null = null;
    if (rowId) {
      const rows = (await executor.execute(
        sql`
        select signer_roles, merge_fields, category_key as "categoryKey", name as "name",
               body_template as "bodyTemplate", requires_signature as "requiresSignature",
               acknowledgment_only as "acknowledgmentOnly"
          from hrm_document_templates where id = ${rowId} and org_id = ${orgId}`,
        "objects",
      )) as Record<string, unknown>[];
      if (!rows[0]) return "Document template not found";
      current = rows[0];
    }
    const merged = mergeTemplateSlots(current, body);
    const probe = {
      name: body.name ?? (current as Record<string, unknown> | null)?.name ?? "",
      categoryKey:
        body.categoryKey ?? (current as Record<string, unknown> | null)?.categoryKey ?? "",
      bodyTemplate:
        body.bodyTemplate ?? (current as Record<string, unknown> | null)?.bodyTemplate ?? "",
      mergeFields: merged.mergeFields,
      requiresSignature:
        body.requiresSignature ??
        (current as Record<string, unknown> | null)?.requiresSignature ??
        false,
      signerRoles: merged.signerRoles,
      acknowledgmentOnly:
        body.acknowledgmentOnly ??
        (current as Record<string, unknown> | null)?.acknowledgmentOnly ??
        false,
    };
    try {
      validateTemplateInput(probe);
    } catch (e) {
      return e instanceof Error ? e.message : "Invalid document template";
    }
    const declared = await executor.execute(
      sql`
      select 1 from hrm_document_categories
       where org_id = ${orgId} and key = ${String(probe.categoryKey)} and is_active`,
      "objects",
    );
    if (!declared.length) {
      return `Category ${JSON.stringify(String(probe.categoryKey))} is not declared — declare it under Setup → Workforce → Document Categories first`;
    }
    body.signerRoles = merged.signerRoles;
    body.mergeFields = merged.mergeFields;
  }
  // Retention schedules (0230) — a schedule for an
  // undeclared category would never match a document, so the save is
  // refused against the Setup vocabulary instead of stored as a dead
  // rule. Categories themselves prove key shape with the engine's own
  // words (validateCategoryKey).
  if (entity.key === "hrm-retention-schedules") {
    const categoryKey = String(body.categoryKey ?? "").trim();
    const declared = await executor.execute(
      sql`
      select 1 from hrm_document_categories
       where org_id = ${orgId} and key = ${categoryKey} and is_active`,
      "objects",
    );
    if (!declared.length) {
      return `Category ${JSON.stringify(categoryKey)} is not declared — declare it under Setup → Workforce → Document Categories first`;
    }
  }
  if (entity.key === "hrm-document-categories") {
    try {
      validateCategoryKey(body.key);
    } catch (e) {
      return e instanceof Error ? e.message : "Invalid category key";
    }
  }
  if (entity.key === "hrm-review-template-sections") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select template_id as "templateId", kind as "kind"
          from hrm_review_template_sections where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Template section not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    if (
      values.kind !== undefined &&
      !["competency", "goals", "free_text"].includes(String(values.kind))
    ) {
      return "Place the section in competency, goals, or free_text";
    }
    const refs = await executor.execute(
      sql`
      select
        ${values.templateId ? sql`exists(select 1 from hrm_review_templates where id = ${values.templateId} and org_id = ${orgId})` : sql`false`} as template_ok
    `,
      "objects",
    );
    if (!refs[0]?.template_ok) return "The parent template is not visible in this organization";
  }
  if (entity.key === "hrm-review-template-questions") {
    let values = body;
    if (rowId) {
      const current = await executor.execute(
        sql`
        select section_id as "sectionId", answer_kind as "answerKind"
          from hrm_review_template_questions where id = ${rowId} and org_id = ${orgId}
      `,
        "objects",
      );
      if (!current[0]) return "Template question not found";
      values = { ...(current[0] as Record<string, unknown>), ...body };
    }
    if (
      values.answerKind !== undefined &&
      !["rating", "text", "rating_and_text"].includes(String(values.answerKind))
    ) {
      return "Answer the question with rating, text, or rating_and_text";
    }
    const refs = await executor.execute(
      sql`
      select
        ${values.sectionId ? sql`exists(select 1 from hrm_review_template_sections where id = ${values.sectionId} and org_id = ${orgId})` : sql`false`} as section_ok
    `,
      "objects",
    );
    if (!refs[0]?.section_ok) return "The parent section is not visible in this organization";
  }
  return INTEGRITY_CONTINUES;
}
