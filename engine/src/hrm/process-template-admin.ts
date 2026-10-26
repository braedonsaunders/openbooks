/** HR process template and template-step configuration writes. */
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { requireHrmProcessConfig } from "./authorization.ts";
import { isUniqueViolation } from "./field-time/errors.ts";
import { HrmProcessError, requireKind, requireOrgId, requireActorId, requireId, requireNonBlank, assertHrmFeatureOn } from "./process-core.ts";
import { type TemplateRow, type ProcessTemplateDTO, type TemplateStepRow, type ProcessTemplateStepDTO, toTemplateDTO, toTemplateStepDTO, assertTemplateWriteScope, templateAppliesTo, assertAppliesToTargets, assertOwnerParty, requireOwnerKind, requireEvidenceKind } from "./process-templates.ts";

// --- Template CRUD (configuration; Setup registry pattern) -------------------

export interface CreateTemplateQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly kind: unknown;
  readonly name: unknown;
  readonly appliesTo?: { employerSubsidiaryId?: string | null; departmentId?: string | null };
}

export async function createProcessTemplate(
  query: CreateTemplateQuery,
): Promise<ProcessTemplateDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const kind = requireKind(query.kind);
  const name = requireNonBlank("name", query.name);
  const appliesTo = {
    employerSubsidiaryId: query.appliesTo?.employerSubsidiaryId ?? null,
    departmentId: query.appliesTo?.departmentId ?? null,
  };
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessConfig(db, orgId, actorId);
    // The declared target is the creation's legal-entity claim: B needs
    // scope over B (uniform with a fabricated subsidiary), org-wide needs
    // unrestricted scope.
    await assertAppliesToTargets(db, orgId, actorId, appliesTo);
    let inserted: TemplateRow[];
    try {
      inserted = (await db.execute<TemplateRow>(sql`
        insert into hrm_process_templates (org_id, kind, name, applies_to, created_by, updated_by)
        values (${orgId}, ${kind}, ${name},
                ${JSON.stringify({ employer_subsidiary_id: appliesTo.employerSubsidiaryId, department_id: appliesTo.departmentId })}::jsonb,
                ${actorId}, ${actorId})
        returning id, org_id, kind, name,
                  applies_to as "applies_to",
                  is_active as "is_active",
                  created_at as "created_at", created_by as "created_by",
                  updated_at as "updated_at", updated_by as "updated_by"
      `, "objects")) as TemplateRow[];
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HrmProcessError(
          "REFUSED",
          `a ${kind} template named ${JSON.stringify(name)} already exists — rename this one or edit the existing template`,
        );
      }
      throw error;
    }
    const row = inserted[0];
    if (!row) {
      throw new HrmProcessError(
        "REFUSED",
        "the template was not stored — nothing saved; retry the create",
      );
    }
    return toTemplateDTO(row, 0);
  });
}

export interface UpdateTemplateQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly templateId: string;
  readonly name?: unknown;
  readonly appliesTo?: { employerSubsidiaryId?: string | null; departmentId?: string | null };
  readonly isActive?: boolean;
}

export async function updateProcessTemplate(
  query: UpdateTemplateQuery,
): Promise<ProcessTemplateDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const templateId = requireId(query.templateId, "templateId");
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessConfig(db, orgId, actorId);
    const current = (await db.execute<TemplateRow>(sql`
      select id, org_id, kind, name, applies_to, is_active,
             created_at, created_by, updated_at, updated_by
        from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId} for update
    `, "objects"))[0];
    if (!current) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template not found in this organization — check the template id",
      );
    }
    // The locked row's current target is rechecked first: a B-targeted
    // template refuses as not-found before the new target is even read.
    await assertTemplateWriteScope(db, orgId, actorId, templateAppliesTo(current.applies_to));
    await refuseLegacyDesignerEdit(db, orgId, templateId);
    const name = query.name === undefined ? current.name : requireNonBlank("name", query.name);
    const appliesTo =
      query.appliesTo === undefined
        ? {
            employerSubsidiaryId:
              typeof current.applies_to?.employer_subsidiary_id === "string"
                ? current.applies_to.employer_subsidiary_id
                : null,
            departmentId:
              typeof current.applies_to?.department_id === "string"
                ? current.applies_to.department_id
                : null,
          }
        : {
            employerSubsidiaryId: query.appliesTo?.employerSubsidiaryId ?? null,
            departmentId: query.appliesTo?.departmentId ?? null,
          };
    const isActive = query.isActive ?? current.is_active;
    // Then the NEW target is validated the same way as a creation: moving
    // a template onto B (or onto org-wide) needs the scope for it.
    await assertAppliesToTargets(db, orgId, actorId, appliesTo);
    let updated: TemplateRow[];
    try {
      updated = (await db.execute<TemplateRow>(sql`
        update hrm_process_templates
           set name = ${name},
               applies_to = ${JSON.stringify({ employer_subsidiary_id: appliesTo.employerSubsidiaryId, department_id: appliesTo.departmentId })}::jsonb,
               is_active = ${isActive}, updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${templateId}
        returning id, org_id, kind, name, applies_to, is_active,
                  created_at, created_by, updated_at, updated_by
      `, "objects")) as TemplateRow[];
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new HrmProcessError(
          "REFUSED",
          `a ${current.kind} template named ${JSON.stringify(name)} already exists — rename this one or edit the existing template`,
        );
      }
      throw error;
    }
    const row = updated[0];
    if (!row) {
      throw new HrmProcessError(
        "REFUSED",
        "the template update matched no rows — it left this organization mid-edit; reload and try again",
      );
    }
    const count =
      (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from hrm_process_template_steps where org_id = ${orgId} and template_id = ${templateId}
    `, "objects"))[0]?.n ?? 0;
    return toTemplateDTO(row, count);
  });
}

/**
 * Delete a template. Refused by name while processes were opened from it
 * (the count is named; storage repeats the refusal as backstop) — retire
 * with is_active = false instead, so history keeps its checklist.
 */
export async function deleteProcessTemplate(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly templateId: string;
}): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const templateId = requireId(query.templateId, "templateId");
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessConfig(db, orgId, actorId);
    const current = (await db.execute<TemplateRow>(sql`
      select id, org_id, kind, name, applies_to, is_active,
             created_at, created_by, updated_at, updated_by
        from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId} for update
    `, "objects"))[0];
    if (!current) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template not found in this organization — check the template id",
      );
    }
    // Deleting retires the instrument for every targeted entity: same
    // locked-row scope as updating.
    await assertTemplateWriteScope(db, orgId, actorId, templateAppliesTo(current.applies_to));
    const opened =
      (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from hrm_processes where org_id = ${orgId} and template_id = ${templateId}
    `, "objects"))[0]?.n ?? 0;
    const versions =
      (await db.execute<{ n: number }>(
          sql`select count(*)::int as n from hrm_process_template_versions where org_id=${orgId} and template_id=${templateId}`, "objects",
        ))[0]?.n ?? 0;
    if (versions > 0)
      throw new HrmProcessError(
        "REFUSED",
        "This template has published versions retained as history — open it in HRM Checklist templates and choose Retire template instead.",
      );
    if (opened > 0) {
      throw new HrmProcessError(
        "REFUSED",
        `${opened} process(es) were opened from this template and it is retained as history — set is_active = false to retire it instead of deleting it`,
      );
    }
    const deleted = await db.execute(sql`
      delete from hrm_process_templates where org_id = ${orgId} and id = ${templateId} returning id
    `, "objects");
    if (deleted.length !== 1) {
      throw new HrmProcessError(
        "REFUSED",
        "the template delete matched no rows — it left this organization mid-edit; reload and try again",
      );
    }
  });
}

export interface UpsertTemplateStepQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly templateId: string;
  readonly stepId?: string;
  readonly position: number;
  readonly title: unknown;
  readonly description?: string | null;
  readonly ownerKind: unknown;
  readonly ownerPartyId?: string | null;
  readonly dueOffsetDays?: number;
  readonly required?: boolean;
  readonly evidenceKind?: unknown;
}

export async function upsertProcessTemplateStep(
  query: UpsertTemplateStepQuery,
): Promise<ProcessTemplateStepDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const templateId = requireId(query.templateId, "templateId");
  const position = query.position;
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new HrmProcessError(
      "REFUSED",
      `step position ${String(position)} must be a whole number from 0 — order steps from the first one up`,
    );
  }
  const title = requireNonBlank("title", query.title);
  const ownerKind = requireOwnerKind(query.ownerKind);
  const ownerPartyId = query.ownerPartyId ?? null;
  if ((ownerKind === "named_party") === (ownerPartyId === null)) {
    throw new HrmProcessError(
      "REFUSED",
      `owner ${ownerKind} ${ownerPartyId === null ? "needs exactly one owner party — name the party" : "takes no owner party — clear it"}`,
    );
  }
  const evidenceKind = requireEvidenceKind(query.evidenceKind ?? "none");
  const dueOffsetDays = query.dueOffsetDays ?? 0;
  if (!Number.isSafeInteger(dueOffsetDays)) {
    throw new HrmProcessError(
      "REFUSED",
      `due offset ${String(dueOffsetDays)} is not a whole number of days — store due offsets as integer days relative to the effective date`,
    );
  }
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessConfig(db, orgId, actorId);
    const template = (await db.execute<TemplateRow>(sql`
      select id, org_id, kind, name, applies_to, is_active,
             created_at, created_by, updated_at, updated_by
        from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId} for update
    `, "objects"))[0];
    if (!template) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template not found in this organization — check the template id",
      );
    }
    // Steps execute for the template's targeted employees: the locked
    // template's target governs every step write on it.
    await assertTemplateWriteScope(db, orgId, actorId, templateAppliesTo(template.applies_to));
    await refuseLegacyDesignerEdit(db, orgId, templateId);
    await assertOwnerParty(db, orgId, ownerPartyId);
    const description = query.description ?? null;
    const required = query.required ?? true;
    let row: TemplateStepRow | undefined;
    if (query.stepId === undefined) {
      try {
        row = (await db.execute<TemplateStepRow>(sql`
          insert into hrm_process_template_steps
            (org_id, template_id, position, title, description, owner_kind, owner_party_id,
             due_offset_days, required, evidence_kind, created_by, updated_by)
          values (${orgId}, ${templateId}, ${position}, ${title}, ${description}, ${ownerKind}, ${ownerPartyId},
                  ${dueOffsetDays}, ${required}, ${evidenceKind}, ${actorId}, ${actorId})
          returning id, org_id, template_id, position, title, description, owner_kind, owner_party_id,
                    due_offset_days, required, evidence_kind
        `, "objects"))[0];
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new HrmProcessError(
            "REFUSED",
            `position ${position} is already taken on this template — pick the next free position`,
          );
        }
        throw error;
      }
    } else {
      try {
        row = (await db.execute<TemplateStepRow>(sql`
          update hrm_process_template_steps
             set position = ${position}, title = ${title}, description = ${description},
                 owner_kind = ${ownerKind}, owner_party_id = ${ownerPartyId},
                 due_offset_days = ${dueOffsetDays}, required = ${required},
                 evidence_kind = ${evidenceKind}, updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${query.stepId} and template_id = ${templateId}
          returning id, org_id, template_id, position, title, description, owner_kind, owner_party_id,
                    due_offset_days, required, evidence_kind
        `, "objects"))[0];
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new HrmProcessError(
            "REFUSED",
            `position ${position} is already taken on this template — reorder the steps instead of colliding`,
          );
        }
        throw error;
      }
    }
    if (!row) {
      throw new HrmProcessError(
        "REFUSED",
        "the template step write matched no rows — nothing saved; reload the template and try again",
      );
    }
    return toTemplateStepDTO(row);
  });
}

/**
 * Rewrite a template's step order in one transaction: the ids must name
 * exactly the template's current steps, positions become 0..n-1. A swap
 * through two positional updates would collide on the unique position, so
 * ordering is one atomic rewrite, never two colliding moves.
 */
export async function reorderProcessTemplateSteps(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly templateId: string;
  readonly orderedStepIds: readonly string[];
}): Promise<ProcessTemplateStepDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const templateId = requireId(query.templateId, "templateId");
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessConfig(db, orgId, actorId);
    const template = (await db.execute<{ id: string; applies_to: TemplateRow["applies_to"] }>(sql`
      select id, applies_to from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId} for update
    `, "objects"))[0];
    if (!template) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template not found in this organization — check the template id",
      );
    }
    // Reordering rewrites the steps the targeted employees execute:
    // same locked-template scope as every other step write.
    await assertTemplateWriteScope(db, orgId, actorId, templateAppliesTo(template.applies_to));
    await refuseLegacyDesignerEdit(db, orgId, templateId);
    const current = (await db.execute<{ id: string }>(sql`
      select id from hrm_process_template_steps where org_id = ${orgId} and template_id = ${templateId}
    `, "objects")).map((row) => row.id);
    const wanted = [...query.orderedStepIds];
    if (
      wanted.length !== current.length ||
      new Set(wanted).size !== wanted.length ||
      !wanted.every((id) => current.includes(id))
    ) {
      throw new HrmProcessError(
        "REFUSED",
        "the reorder must name exactly the template's current steps once each — reload the template and order the full list",
      );
    }
    // Step aside through negative positions so no two rows share one.
    for (let index = 0; index < wanted.length; index += 1) {
      const moved = await db.execute(sql`
        update hrm_process_template_steps
           set position = ${-(index + 1)}, updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${wanted[index]} and template_id = ${templateId}
        returning id
      `, "objects");
      if (moved.length !== 1) {
        throw new HrmProcessError(
          "REFUSED",
          "the reorder matched no rows mid-write — nothing reordered; reload the template and try again",
        );
      }
    }
    for (let index = 0; index < wanted.length; index += 1) {
      const moved = await db.execute(sql`
        update hrm_process_template_steps
           set position = ${index}, updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${wanted[index]} and template_id = ${templateId}
        returning id
      `, "objects");
      if (moved.length !== 1) {
        throw new HrmProcessError(
          "REFUSED",
          "the reorder matched no rows mid-write — nothing reordered; reload the template and try again",
        );
      }
    }
    const rows = await db.execute<TemplateStepRow>(sql`
      select id, org_id, template_id, position, title, description, owner_kind, owner_party_id,
             due_offset_days, required, evidence_kind
        from hrm_process_template_steps
       where org_id = ${orgId} and template_id = ${templateId}
       order by position
    `, "objects");
    return rows.map(toTemplateStepDTO);
  });
}

export async function deleteProcessTemplateStep(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly templateId: string;
  readonly stepId: string;
}): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const templateId = requireId(query.templateId, "templateId");
  const stepId = requireId(query.stepId, "stepId");
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessConfig(db, orgId, actorId);
    const template = (await db.execute<{ id: string; applies_to: TemplateRow["applies_to"] }>(sql`
      select id, applies_to from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId} for update
    `, "objects"))[0];
    if (!template) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template not found in this organization — check the template id",
      );
    }
    // Deleting a step removes it from the targeted employees' future
    // checklists: same locked-template scope as the other step writes.
    await assertTemplateWriteScope(db, orgId, actorId, templateAppliesTo(template.applies_to));
    await refuseLegacyDesignerEdit(db, orgId, templateId);
    // Opened processes hold snapshots, so deleting a template step never
    // rewrites history — lineage on copied steps simply clears (SET NULL).
    const deleted = await db.execute(sql`
      delete from hrm_process_template_steps
       where org_id = ${orgId} and id = ${stepId} and template_id = ${templateId}
      returning id
    `, "objects");
    if (deleted.length !== 1) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "template step not found on this template in this organization — check the step id",
      );
    }
  });
}

async function refuseLegacyDesignerEdit(
  exec: SqlExecutor,
  orgId: string,
  templateId: string,
): Promise<void> {
  const row = (await exec.execute<{ designer_managed: boolean }>(
      sql`select designer_managed from hrm_process_templates where org_id=${orgId} and id=${templateId}`, "objects",
    ))[0];
  if (row?.designer_managed)
    throw new HrmProcessError(
      "REFUSED",
      "Open this template in HRM Checklist templates to edit and publish its whole draft, or use Retire template there.",
    );
}
