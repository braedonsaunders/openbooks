/** Checklist designer drafts, publication, coverage preview, reminders and versions. */
import {
  checklistDocumentSchema,
  checklistIssues,
  checklistConditionPredicates,
  includedChecklistSteps,
  emptyStepDesign,
  type ChecklistDocument,
} from "@openbooks/forms-core";
import { businessToday } from "../platform/business-date.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { requireHrmProcessConfig, requireHrmProcessManage } from "./authorization.ts";
import { HRM_FEATURE_KEY } from "./employment-read.ts";
import { addOffsetDays } from "./process-math.ts";
import { parseCivilDate } from "./temporal.ts";
import {
  HrmProcessError,
  requireOrgId,
  requireActorId,
  requireId,
  requireNonBlank,
  assertHrmFeatureOn,
} from "./process-core.ts";
import {
  loadStepForUpdate,
  loadProcessForUpdate,
  resolveStepActor,
  auditChecklist,
} from "./process-runtime.ts";
import {
  type TemplateRow,
  listProcessTemplates,
  getProcessTemplate,
  assertTemplateWriteScope,
  templateAppliesTo,
  scopeTemplateRows,
  assertAppliesToTargets,
  assertOwnerParty,
  loadOpeningEmploymentContext,
  assertLiveVersionOn,
  loadTemplateSteps,
} from "./process-templates.ts";

export interface ChecklistDesignerValue {
  id: string;
  revision: number;
  publishedVersion: number;
  publishedRevision?: number;
  isActive: boolean;
  document: ChecklistDocument;
  versions?: { version: number; publishedAt: string; publishedBy: string; reason: string }[];
}

export async function getChecklistDesigner(query: {
  orgId: string;
  actorId: string;
  templateId: string;
}): Promise<ChecklistDesignerValue> {
  return withOrgTransaction(query.orgId, async () => {
    const detail = await getProcessTemplate(query);
    const row = (
      await db.execute<{
        draft_document: unknown;
        draft_revision: number;
        published_version: number;
        published_revision: number;
        is_active: boolean;
      }>(
        sql`
      select draft_document, draft_revision, published_version, published_revision, is_active from hrm_process_templates where org_id = ${query.orgId} and id = ${detail.id}`,
        "objects",
      )
    )[0];
    if (!row)
      throw new HrmProcessError(
        "NOT_FOUND",
        "Checklist template is no longer visible — reload the template list.",
      );
    const document = row.draft_document ?? {
      name: detail.name,
      kind: detail.kind,
      appliesTo: detail.appliesTo,
      steps: detail.steps.map((s) => ({ ...s, design: s.design ?? emptyStepDesign() })),
    };
    const draftScope = checklistDocumentSchema.parse(document).appliesTo;
    if (
      !(
        await scopeTemplateRows(db, query.orgId, query.actorId, [
          {
            applies_to: {
              employer_subsidiary_id: draftScope.employerSubsidiaryId,
              department_id: draftScope.departmentId,
            },
          },
        ])
      ).length
    )
      throw new HrmProcessError(
        "NOT_FOUND",
        "Checklist draft is not visible in this organization and legal-entity scope.",
      );
    const versions = await db.execute<{
      version: number;
      publishedAt: string;
      publishedBy: string;
      reason: string;
    }>(
      sql`select v.version,v.published_at::text as "publishedAt",u.name as "publishedBy",v.reason from hrm_process_template_versions v join users u on u.org_id=v.org_id and u.id=v.published_by where v.org_id=${query.orgId} and v.template_id=${detail.id} order by v.version desc limit 50`,
      "objects",
    );
    return {
      versions,
      id: detail.id,
      revision: row.draft_revision,
      publishedVersion: row.published_version,
      publishedRevision: row.published_revision,
      isActive: row.is_active,
      document: checklistDocumentSchema.parse(document),
    };
  });
}

export async function saveChecklistDraft(query: {
  orgId: string;
  actorId: string;
  templateId: string;
  revision: number;
  document: unknown;
}): Promise<ChecklistDesignerValue> {
  const orgId = requireOrgId(query.orgId),
    actorId = requireActorId(query.actorId),
    id = requireId(query.templateId, "templateId");
  const parsed = checklistDocumentSchema.safeParse(query.document);
  if (!parsed.success)
    throw new HrmProcessError(
      "REFUSED",
      `Checklist draft is invalid: ${parsed.error.issues[0]?.message}. Review the indicated field before saving.`,
    );
  const document = parsed.data;
  if (!document.name.trim())
    throw new HrmProcessError("REFUSED", "Give the checklist a name before saving its draft.");
  if (!Number.isSafeInteger(query.revision) || query.revision < 0)
    throw new HrmProcessError(
      "REFUSED",
      "Draft revision is missing — reload the template before saving.",
    );
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessConfig(db, orgId, actorId);
    // A stable client identity serializes first-save retries as well as later edits.
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${orgId + ":checklist:" + id},0))`,
    );
    const current = (
      await db.execute<{
        applies_to: TemplateRow["applies_to"];
        kind: string;
        draft_revision: number;
        draft_document: unknown;
        published_version: number;
        published_revision: number;
        is_active: boolean;
      }>(
        sql`
      select applies_to, kind, draft_revision, draft_document, published_version, published_revision, is_active from hrm_process_templates where org_id = ${orgId} and id = ${id} for update`,
        "objects",
      )
    )[0];
    if (current) {
      await assertTemplateWriteScope(db, orgId, actorId, templateAppliesTo(current.applies_to));
      if (current.kind !== document.kind)
        throw new HrmProcessError(
          "REFUSED",
          "The process type cannot change after creation — create another template for that transition.",
        );
      if (current.draft_revision !== query.revision) {
        if (
          current.draft_revision === query.revision + 1 &&
          (
            await db.execute<{ matches: boolean }>(
              sql`select draft_document = ${JSON.stringify(document)}::jsonb as matches from hrm_process_templates where org_id=${orgId} and id=${id}`,
              "objects",
            )
          )[0]?.matches
        )
          return {
            id,
            revision: current.draft_revision,
            publishedVersion: current.published_version,
            publishedRevision: current.published_revision,
            isActive: current.is_active,
            document,
          };
        throw new HrmProcessError(
          "REFUSED",
          "Another editor saved this draft — reload the latest revision before applying your changes. Your edits have not been overwritten.",
        );
      }
    } else if (query.revision !== 0)
      throw new HrmProcessError(
        "NOT_FOUND",
        "Checklist template is no longer visible — reload the template list.",
      );
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${orgId + ":checklist-name:" + document.kind + ":" + document.name.trim()},0))`,
    );
    const duplicateName = await db.execute(
      sql`select id from hrm_process_templates where org_id=${orgId} and kind=${document.kind} and id<>${id} and (name=${document.name.trim()} or draft_document->>'name'=${document.name.trim()}) limit 1`,
      "objects",
    );
    if (duplicateName.length)
      throw new HrmProcessError(
        "REFUSED",
        "Another checklist template already uses this name — choose a distinct name before saving or publishing.",
      );
    await assertAppliesToTargets(db, orgId, actorId, document.appliesTo);
    for (const step of document.steps)
      if (step.ownerPartyId) await assertOwnerParty(db, orgId, step.ownerPartyId);
    const revision = query.revision + 1;
    const rows = current
      ? await db.execute(
          sql`update hrm_process_templates set draft_document = ${JSON.stringify(document)}::jsonb, draft_revision = ${revision}, designer_managed = true, updated_by = ${actorId}, updated_at = now() where org_id = ${orgId} and id = ${id} and draft_revision = ${query.revision} returning id`,
          "objects",
        )
      : await db.execute(
          sql`insert into hrm_process_templates(id,org_id,kind,name,applies_to,is_active,designer_managed,draft_document,draft_revision,created_by,updated_by)
          values(${id},${orgId},${document.kind},${document.name.trim()},${JSON.stringify({ employer_subsidiary_id: document.appliesTo.employerSubsidiaryId, department_id: document.appliesTo.departmentId })}::jsonb,false,true,${JSON.stringify(document)}::jsonb,${revision},${actorId},${actorId}) returning id`,
          "objects",
        );
    if (rows.length !== 1)
      throw new HrmProcessError(
        "REFUSED",
        "The draft could not be saved — reload the template and retry.",
      );
    await auditChecklist(
      db,
      orgId,
      actorId,
      id,
      "draft_saved",
      current?.draft_document ?? null,
      document,
      "Saved a checklist draft; its published definition is unchanged.",
    );
    return {
      id,
      revision,
      publishedVersion: current?.published_version ?? 0,
      publishedRevision: current?.published_revision ?? 0,
      isActive: current?.is_active ?? false,
      document,
    };
  });
}

/** Retirement stops new use while preserving published definitions and open work. */
export async function retireChecklistTemplate(query: {
  orgId: string;
  actorId: string;
  templateId: string;
  revision: number;
  reason: string;
}): Promise<ChecklistDesignerValue> {
  const orgId = requireOrgId(query.orgId),
    actorId = requireActorId(query.actorId),
    id = requireId(query.templateId, "templateId");
  const reason = requireNonBlank("Retirement reason", query.reason);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessConfig(db, orgId, actorId);
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${orgId + ":checklist-publication"},0))`,
    );
    await getChecklistDesigner(query);
    await db.execute(
      sql`select id from hrm_process_templates where org_id=${orgId} and id=${id} for update`,
    );
    const current = await getChecklistDesigner(query);
    const published = await getProcessTemplate(query);
    await assertTemplateWriteScope(db, orgId, actorId, published.appliesTo);
    await assertTemplateWriteScope(db, orgId, actorId, current.document.appliesTo);
    if (current.revision !== query.revision)
      throw new HrmProcessError(
        "REFUSED",
        "The draft changed before retirement — reload and review the latest revision.",
      );
    if (!current.isActive) return current;
    await db.execute(sql`select set_config('app.checklist_publish',${id},true)`);
    const updated = await db.execute(
      sql`update hrm_process_templates set is_active=false,updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${id} and is_active returning id`,
      "objects",
    );
    if (updated.length !== 1)
      throw new HrmProcessError(
        "REFUSED",
        "The template changed before retirement — reload and retry.",
      );
    await auditChecklist(
      db,
      orgId,
      actorId,
      id,
      "retired",
      { isActive: true, version: current.publishedVersion },
      { isActive: false, version: current.publishedVersion },
      reason,
    );
    return { ...current, isActive: false };
  });
}

export async function publishChecklistDraft(query: {
  orgId: string;
  actorId: string;
  templateId: string;
  revision: number;
  reason: string;
}): Promise<ChecklistDesignerValue> {
  const orgId = requireOrgId(query.orgId),
    actorId = requireActorId(query.actorId),
    id = requireId(query.templateId, "templateId"),
    reason = requireNonBlank("Publication reason", query.reason);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessConfig(db, orgId, actorId);
    // Serialize coverage changes across templates so two editors cannot publish an ambiguous pair.
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${orgId + ":checklist-publication"},0))`,
    );
    const value = await getChecklistDesigner(query);
    await db.execute(
      sql`select id from hrm_process_templates where org_id = ${orgId} and id = ${id} for update`,
    );
    const locked = await getChecklistDesigner(query);
    if (locked.revision !== query.revision)
      throw new HrmProcessError(
        "REFUSED",
        "The draft changed before publication — review and publish the latest revision.",
      );
    const marker = (
      await db.execute<{ published_revision: number }>(
        sql`select published_revision from hrm_process_templates where org_id=${orgId} and id=${id}`,
        "objects",
      )
    )[0];
    if (
      marker?.published_revision === query.revision &&
      locked.publishedVersion > 0 &&
      locked.isActive
    )
      return locked;
    const document = locked.document,
      issues = checklistIssues(document);
    const foreignIdentities = await db.execute(
      sql`select id from hrm_process_template_steps where id in(select value::uuid from jsonb_array_elements_text(${JSON.stringify(document.steps.map((s) => s.id))}::jsonb) as ids(value)) and (org_id<>${orgId} or template_id<>${id}) limit 1`,
      "objects",
    );
    if (foreignIdentities.length)
      throw new HrmProcessError(
        "REFUSED",
        "A step identity belongs to another template — duplicate the step in this designer to give it a new identity.",
      );
    if (issues.length) throw new HrmProcessError("REFUSED", issues.map((i) => i.message).join(" "));
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${orgId + ":checklist-name:" + document.kind + ":" + document.name.trim()},0))`,
    );
    const duplicateName = await db.execute(
      sql`select id from hrm_process_templates where org_id=${orgId} and kind=${document.kind} and id<>${id} and (name=${document.name.trim()} or draft_document->>'name'=${document.name.trim()}) limit 1`,
      "objects",
    );
    if (duplicateName.length)
      throw new HrmProcessError(
        "REFUSED",
        "Another checklist template already uses this name — choose a distinct name before saving or publishing.",
      );
    await assertAppliesToTargets(db, orgId, actorId, document.appliesTo);
    const others = await listProcessTemplates({
      orgId,
      actorId,
      kind: document.kind,
      activeOnly: true,
    });
    const scope = document.appliesTo;
    const specificity = (s: typeof scope) =>
      Number(s.employerSubsidiaryId !== null) + Number(s.departmentId !== null);
    const conflict = others.find(
      (t) =>
        t.id !== id &&
        specificity(t.appliesTo) === specificity(scope) &&
        (!scope.employerSubsidiaryId ||
          !t.appliesTo.employerSubsidiaryId ||
          scope.employerSubsidiaryId === t.appliesTo.employerSubsidiaryId) &&
        (!scope.departmentId ||
          !t.appliesTo.departmentId ||
          scope.departmentId === t.appliesTo.departmentId),
    );
    if (conflict)
      throw new HrmProcessError(
        "AMBIGUOUS_TEMPLATE",
        `This template overlaps "${conflict.name}" with equal priority — narrow the employer or department scope, or retire the other template before publishing.`,
      );
    for (const step of document.steps) {
      if (step.ownerPartyId) await assertOwnerParty(db, orgId, step.ownerPartyId);
      for (const predicate of step.design.condition
        ? checklistConditionPredicates(step.design.condition)
        : []) {
        if (!("value" in predicate) || predicate.field === "kind") continue;
        for (const value of Array.isArray(predicate.value) ? predicate.value : [predicate.value]) {
          if (value === null) continue;
          await assertAppliesToTargets(db, orgId, actorId, {
            employerSubsidiaryId: predicate.field === "employerSubsidiaryId" ? String(value) : null,
            departmentId: predicate.field === "departmentId" ? String(value) : null,
          });
        }
      }
    }
    await db.execute(sql`select set_config('app.checklist_publish',${id},true)`);
    // Existing step identities remain so historical foreign keys are preserved.
    const currentSteps = await loadTemplateSteps(db, orgId, id, true);
    const max = Math.max(0, ...currentSteps.map((s) => s.position)) + document.steps.length + 1;
    await db.execute(
      sql`update hrm_process_template_steps set position = position + ${max} where org_id = ${orgId} and template_id = ${id}`,
    );
    for (const [position, step] of document.steps.entries()) {
      const existing = currentSteps.some((s) => s.id === step.id);
      const design = JSON.stringify(step.design);
      const rows = existing
        ? await db.execute(
            sql`update hrm_process_template_steps set is_current=true,position=${position},title=${step.title.trim()},description=${step.description},owner_kind=${step.ownerKind},owner_party_id=${step.ownerPartyId},due_offset_days=${step.dueOffsetDays},required=${step.required},evidence_kind=${step.evidenceKind},design=${design}::jsonb,updated_by=${actorId},updated_at=now() where org_id=${orgId} and template_id=${id} and id=${step.id} returning id`,
            "objects",
          )
        : await db.execute(
            sql`insert into hrm_process_template_steps(id,org_id,template_id,position,title,description,owner_kind,owner_party_id,due_offset_days,required,evidence_kind,design,created_by,updated_by) values(${step.id},${orgId},${id},${position},${step.title.trim()},${step.description},${step.ownerKind},${step.ownerPartyId},${step.dueOffsetDays},${step.required},${step.evidenceKind},${design}::jsonb,${actorId},${actorId}) returning id`,
            "objects",
          );
      if (rows.length !== 1)
        throw new HrmProcessError(
          "REFUSED",
          "A checklist step was not published — retry after reloading the draft.",
        );
    }
    // Keep the source identity of every historical execution step. Removed
    // definitions are excluded from future snapshots, never detached from history.
    for (const old of currentSteps.filter((s) => !document.steps.some((n) => n.id === s.id))) {
      const removed = await db.execute(
        sql`update hrm_process_template_steps set is_current=false,updated_by=${actorId},updated_at=now() where org_id=${orgId} and template_id=${id} and id=${old.id} returning id`,
        "objects",
      );
      if (removed.length !== 1)
        throw new HrmProcessError(
          "REFUSED",
          "A removed step changed during publication — reload and retry.",
        );
    }
    const version = locked.publishedVersion + 1;
    const stored = await db.execute(
      sql`insert into hrm_process_template_versions(org_id,template_id,version,document,published_by,reason) values(${orgId},${id},${version},${JSON.stringify(document)}::jsonb,${actorId},${reason}) returning id`,
      "objects",
    );
    if (stored.length !== 1)
      throw new HrmProcessError(
        "REFUSED",
        "Publication evidence was not stored — nothing was published.",
      );
    const updated = await db.execute(
      sql`update hrm_process_templates set name=${document.name.trim()},applies_to=${JSON.stringify({ employer_subsidiary_id: scope.employerSubsidiaryId, department_id: scope.departmentId })}::jsonb,is_active=true,designer_managed=true,published_version=${version},published_revision=${query.revision},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${id} returning id`,
      "objects",
    );
    if (updated.length !== 1)
      throw new HrmProcessError(
        "REFUSED",
        "The template changed during publication — reload and retry.",
      );
    await auditChecklist(
      db,
      orgId,
      actorId,
      id,
      "published",
      { version: value.publishedVersion },
      { version, document },
      reason,
    );
    return getChecklistDesigner(query);
  });
}

export async function previewChecklistCoverage(query: {
  orgId: string;
  actorId: string;
  employmentId: string;
  effectiveDate: string;
  document: unknown;
}) {
  const orgId = requireOrgId(query.orgId),
    actorId = requireActorId(query.actorId),
    employmentId = requireId(query.employmentId, "employmentId");
  const parsed = checklistDocumentSchema.safeParse(query.document);
  if (!parsed.success)
    throw new HrmProcessError(
      "REFUSED",
      "The draft is incomplete — review its fields before testing employee coverage.",
    );
  const document = parsed.data;
  let effectiveDate: string;
  try {
    effectiveDate = parseCivilDate(query.effectiveDate);
  } catch {
    throw new HrmProcessError(
      "REFUSED",
      "Choose a real YYYY-MM-DD effective date before testing employee coverage.",
    );
  }
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessManage(db, orgId, actorId, employmentId);
    await assertLiveVersionOn(db, orgId, employmentId, effectiveDate);
    const context = await loadOpeningEmploymentContext(db, orgId, employmentId, effectiveDate),
      scope = document.appliesTo;
    if (
      (scope.employerSubsidiaryId && scope.employerSubsidiaryId !== context.employerSubsidiaryId) ||
      (scope.departmentId && scope.departmentId !== context.departmentId)
    )
      throw new HrmProcessError(
        "REFUSED",
        "This draft does not cover the selected employee on that date — adjust its employer or department scope.",
      );
    let included;
    try {
      included = includedChecklistSteps(document, { ...context, kind: document.kind });
    } catch (error) {
      throw new HrmProcessError(
        "REFUSED",
        error instanceof Error
          ? error.message
          : "Checklist conditions could not resolve — review the template.",
      );
    }
    return {
      context,
      steps: included.map((s) => ({
        id: s.id,
        title: s.title,
        dueOn: addOffsetDays(effectiveDate, s.dueOffsetDays),
      })),
    };
  });
}

/** Daily, deduplicated attention for pending checklist work, on the existing automation tick. */
export async function runChecklistReminders(orgId: string): Promise<number> {
  return withOrgTransaction(orgId, async () => {
    if (!(await lockAndCheckOrgFeature(db, orgId, HRM_FEATURE_KEY))) return 0;
    const today = await businessToday(orgId);
    const candidates = await db.execute<{ id: string; process_id: string }>(
      sql`select s.id,s.process_id from hrm_process_steps s join hrm_processes p on p.org_id=s.org_id and p.id=s.process_id where s.org_id=${orgId} and p.status='open' and s.status='pending' and s.design->>'reminderDays' is not null and s.due_on + (s.design->>'reminderDays')::int <= ${today}::date and (s.reminder_sent_on is null or s.reminder_sent_on<${today}::date) order by s.process_id,s.id limit 100`,
      "objects",
    );
    const users = await db.execute<{ id: string }>(
      sql`select id from users where org_id=${orgId} and is_active order by id`,
      "objects",
    );
    let sent = 0;
    for (const candidate of candidates) {
      const process = await loadProcessForUpdate(db, orgId, candidate.process_id);
      if (process.status !== "open") continue;
      const step = await loadStepForUpdate(db, orgId, candidate.id);
      if (step.status !== "pending") continue;
      const current = (
        await db.execute<{ sent: boolean }>(
          sql`select reminder_sent_on>=${today}::date as sent from hrm_process_steps where org_id=${orgId} and id=${step.id}`,
          "objects",
        )
      )[0];
      if (current?.sent) continue;
      const recipients: { userId: string; href: string }[] = [];
      for (const user of users) {
        const actor = await resolveStepActor(db, orgId, user.id, step);
        if (actor === "stranger") continue;
        recipients.push({
          userId: user.id,
          href:
            actor === "owner"
              ? `/me/checklists?step=${step.id}`
              : `/hrm/processes?process=${step.process_id}`,
        });
      }
      if (!recipients.length) continue;
      for (const { userId, href } of recipients) {
        const notification = await db.execute(
          sql`insert into notifications(org_id,user_id,kind,title,body,href) values(${orgId},${userId},'hrm_checklist',${`Checklist step due: ${step.title}`},${`This ${step.process_kind} checklist step was due ${step.due_on}. Open the task to review its instructions and complete the outstanding work.`},${href}) returning id`,
          "objects",
        );
        if (notification.length !== 1)
          throw new HrmProcessError(
            "REFUSED",
            "The checklist reminder was not stored — the next automation tick will retry it.",
          );
      }
      const changed = await db.execute(
        sql`update hrm_process_steps set reminder_sent_on=${today}::date where org_id=${orgId} and id=${step.id} and (reminder_sent_on is null or reminder_sent_on<${today}::date) returning id`,
        "objects",
      );
      if (changed.length !== 1)
        throw new HrmProcessError(
          "REFUSED",
          "The reminder state changed — the next automation tick will retry it.",
        );
      sent += recipients.length;
    }
    return sent;
  });
}

/** A prior definition is read as evidence; restoring it creates another draft and publication. */
export async function getChecklistVersion(query: {
  orgId: string;
  actorId: string;
  templateId: string;
  version: number;
}): Promise<ChecklistDocument> {
  if (!Number.isSafeInteger(query.version) || query.version < 1)
    throw new HrmProcessError("REFUSED", "Choose a published version from checklist history.");
  return withOrgTransaction(query.orgId, async () => {
    await getChecklistDesigner(query);
    const row = (
      await db.execute<{ document: unknown }>(
        sql`select document from hrm_process_template_versions where org_id=${query.orgId} and template_id=${query.templateId} and version=${query.version}`,
        "objects",
      )
    )[0];
    if (!row)
      throw new HrmProcessError(
        "NOT_FOUND",
        "This published version is no longer visible — reload the checklist history.",
      );
    return checklistDocumentSchema.parse(row.document);
  });
}
