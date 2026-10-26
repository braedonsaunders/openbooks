/** HR process template definitions, reads and resolution for an employment. */
import { checklistStepDesignSchema, type ChecklistStepDesign } from "@openbooks/forms-core";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import {
  requireHrmProcessConfig,
  requireHrmProcessManage,
  requireUnrestrictedHrmScope,
} from "./authorization.ts";
import { resolveTemplateForEmployment, type MatchableTemplate } from "./process-math.ts";
import { parseCivilDate } from "./temporal.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  HrmProcessError,
  type ProcessKind,
  requireKind,
  requireOrgId,
  requireActorId,
  requireId,
  mathRefusal,
  assertHrmFeatureOn,
} from "./process-core.ts";

// --- Template rows and DTOs --------------------------------------------------

export type TemplateRow = {
  id: string;
  org_id: string;
  kind: string;
  name: string;
  applies_to: { employer_subsidiary_id?: string | null; department_id?: string | null } | null;
  is_active: boolean;
  created_at: Date;
  created_by: string | null;
  updated_at: Date;
  updated_by: string | null;
};

export interface ProcessTemplateDTO {
  readonly id: string;
  readonly kind: ProcessKind;
  readonly name: string;
  readonly appliesTo: { employerSubsidiaryId: string | null; departmentId: string | null };
  readonly isActive: boolean;
  readonly stepCount: number;
}

export interface ProcessTemplateDetail extends ProcessTemplateDTO {
  readonly steps: ProcessTemplateStepDTO[];
}

export type TemplateStepRow = {
  id: string;
  org_id: string;
  template_id: string;
  position: number;
  title: string;
  description: string | null;
  owner_kind: string;
  owner_party_id: string | null;
  due_offset_days: number;
  required: boolean;
  evidence_kind: string;
  design?: ChecklistStepDesign;
};

export interface ProcessTemplateStepDTO {
  readonly id: string;
  readonly position: number;
  readonly title: string;
  readonly description: string | null;
  readonly ownerKind: string;
  readonly ownerPartyId: string | null;
  readonly dueOffsetDays: number;
  readonly required: boolean;
  readonly evidenceKind: string;
  readonly design?: ChecklistStepDesign;
}

export function toTemplateDTO(row: TemplateRow, stepCount: number): ProcessTemplateDTO {
  const raw = row.applies_to ?? {};
  return {
    id: row.id,
    kind: requireKind(row.kind),
    name: row.name,
    appliesTo: {
      employerSubsidiaryId:
        typeof raw.employer_subsidiary_id === "string" ? raw.employer_subsidiary_id : null,
      departmentId: typeof raw.department_id === "string" ? raw.department_id : null,
    },
    isActive: row.is_active,
    stepCount,
  };
}

export function toTemplateStepDTO(row: TemplateStepRow): ProcessTemplateStepDTO {
  return {
    id: row.id,
    position: row.position,
    title: row.title,
    description: row.description,
    ownerKind: row.owner_kind,
    ownerPartyId: row.owner_party_id,
    dueOffsetDays: row.due_offset_days,
    required: row.required,
    evidenceKind: row.evidence_kind,
    design: checklistStepDesignSchema.parse(row.design ?? {}),
  };
}

/**
 * Process-template catalogue for the HRM checklist workspace. This is the
 * canonical read behind both the template list and the explicit template
 * picker; it deliberately uses the process-management grant rather than the
 * broader Setup permission because checklist authors own this configuration.
 */
export async function listProcessTemplates(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly activeOnly?: boolean;
  readonly kind?: ProcessKind;
  readonly employmentId?: string;
  readonly effectiveDate?: string;
}): Promise<ProcessTemplateDTO[]> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const kind = query.kind === undefined ? undefined : requireKind(query.kind);
  const employmentId =
    query.employmentId === undefined ? undefined : requireId(query.employmentId, "employmentId");
  if ((employmentId === undefined) !== (query.effectiveDate === undefined)) {
    throw new HrmProcessError(
      "REFUSED",
      "employmentId and effectiveDate must be supplied together — choose the employee and date before choosing a template",
    );
  }
  let effectiveDate: string | undefined;
  if (query.effectiveDate !== undefined) {
    try {
      effectiveDate = parseCivilDate(query.effectiveDate);
    } catch {
      throw new HrmProcessError(
        "REFUSED",
        `effective date ${JSON.stringify(query.effectiveDate)} is not a real YYYY-MM-DD calendar date — choose the checklist date again`,
      );
    }
  }
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    if (employmentId !== undefined) {
      await requireHrmProcessManage(db, orgId, actorId, employmentId);
      await assertLiveVersionOn(db, orgId, employmentId, effectiveDate!);
    } else {
      await requireHrmProcessConfig(db, orgId, actorId);
    }
    const rows = await db.execute<TemplateRow & { step_count: number }>(
      sql`
      select t.id, t.org_id, t.kind, t.name, t.applies_to, t.is_active,
             t.created_at, t.created_by, t.updated_at, t.updated_by,
             count(s.id)::int as step_count
        from hrm_process_templates t
        left join hrm_process_template_steps s
          on s.org_id = t.org_id and s.template_id = t.id and s.is_current
       where t.org_id = ${orgId}
         ${query.activeOnly ? sql`and t.is_active` : sql``}
         ${kind ? sql`and t.kind = ${kind}` : sql``}
       group by t.id
       order by t.kind, t.name, t.id
    `,
      "objects",
    );
    // The catalogue lists only what the actor may see: B-targeted rows
    // are invisible to an A-restricted reader, exactly as the write path
    // refuses them as not-found.
    const visible = await scopeTemplateRows(db, orgId, actorId, rows);
    if (employmentId === undefined) return visible.map((row) => toTemplateDTO(row, row.step_count));
    const context = await loadOpeningEmploymentContext(db, orgId, employmentId, effectiveDate!);
    return visible
      .filter((row) => {
        const employer =
          typeof row.applies_to?.employer_subsidiary_id === "string"
            ? row.applies_to.employer_subsidiary_id
            : null;
        const department =
          typeof row.applies_to?.department_id === "string" ? row.applies_to.department_id : null;
        return (
          (employer === null || employer === context.employerSubsidiaryId) &&
          (department === null || department === context.departmentId)
        );
      })
      .map((row) => toTemplateDTO(row, row.step_count));
  });
}

/** One template and its ordered steps for the unified create/edit drawer. */
export async function getProcessTemplate(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly templateId: string;
}): Promise<ProcessTemplateDetail> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const templateId = requireId(query.templateId, "templateId");
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessConfig(db, orgId, actorId);
    const row = (
      await db.execute<TemplateRow>(
        sql`
      select id, org_id, kind, name, applies_to, is_active,
             created_at, created_by, updated_at, updated_by
        from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId} for share
    `,
        "objects",
      )
    )[0];
    if (!row) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template not found in this organization — open it from the template list",
      );
    }
    // A B-targeted template reads to an A-restricted actor exactly as
    // the write path refuses it: not-found, with the same message as a
    // missing template, so a fabricated id probes nothing.
    if ((await scopeTemplateRows(db, orgId, actorId, [row])).length === 0) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template not found in this organization — open it from the template list",
      );
    }
    const steps = await loadTemplateSteps(db, orgId, templateId);
    return { ...toTemplateDTO(row, steps.length), steps: steps.map(toTemplateStepDTO) };
  });
}

/**
 * Scope half for template writes, over a LOCKED template row's applies_to:
 * a B-targeted template refuses uniformly as not-found (the same message
 * as a missing template), while an org-wide (no employer) template
 * changes every entity's onboarding/offboarding at once and needs
 * unrestricted scope (named 403).
 */
export async function assertTemplateWriteScope(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  appliesTo: { employerSubsidiaryId: string | null; departmentId: string | null },
): Promise<void> {
  try {
    await assertAppliesToTargets(exec, orgId, actorId, appliesTo);
  } catch (error) {
    if (error instanceof HrmProcessError && error.code === "NOT_FOUND") {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template not found in this organization — check the template id",
      );
    }
    throw error;
  }
}

export function templateAppliesTo(
  appliesTo: { employer_subsidiary_id?: unknown; department_id?: unknown } | null,
): { employerSubsidiaryId: string | null; departmentId: string | null } {
  return {
    employerSubsidiaryId:
      typeof appliesTo?.employer_subsidiary_id === "string"
        ? appliesTo.employer_subsidiary_id
        : null,
    departmentId: typeof appliesTo?.department_id === "string" ? appliesTo.department_id : null,
  };
}

/**
 * Read-scope half for the template catalogue: the write path refuses a
 * B-targeted template to an A-restricted actor as not-found, so the
 * catalogue must not list it either — a listed-but-unwritable row is a
 * probe for B's configuration. Rows targeted at an out-of-scope
 * subsidiary drop out, whether targeted directly or through a
 * department owned by that subsidiary; org-wide rows stay visible
 * (their writes refuse 403, never not-found, so listing them probes
 * nothing and the checklist picker needs them).
 */
export async function scopeTemplateRows<T extends Pick<TemplateRow, "applies_to">>(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  rows: readonly T[],
): Promise<T[]> {
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  if (allowed === null || rows.length === 0) return [...rows];
  const departmentIds = [
    ...new Set(
      rows
        .map((row) => templateAppliesTo(row.applies_to).departmentId)
        .filter((id): id is string => id !== null),
    ),
  ];
  const departmentOwner = new Map<string, string | null>();
  if (departmentIds.length > 0) {
    const owners = await exec.execute<{ id: string; subsidiary_id: string | null }>(
      sql`
      select id::text as id, subsidiary_id::text as subsidiary_id from departments
       where org_id = ${orgId} and id = any (${`{${departmentIds.join(",")}}`}::uuid[])
    `,
      "objects",
    );
    for (const owner of owners) departmentOwner.set(owner.id, owner.subsidiary_id);
  }
  return rows.filter((row) => {
    const targets = templateAppliesTo(row.applies_to);
    if (targets.employerSubsidiaryId !== null) return allowed.has(targets.employerSubsidiaryId);
    if (targets.departmentId !== null) {
      const owner = departmentOwner.get(targets.departmentId);
      return owner !== undefined && (owner === null || allowed.has(owner));
    }
    return true;
  });
}

/**
 * Prove filter targets before saving: a template whose filter names a
 * subsidiary or department outside this organization could never apply, so
 * saving it would report work no read can observe. Refused by field name.
 */
export async function assertAppliesToTargets(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  appliesTo: { employerSubsidiaryId: string | null; departmentId: string | null },
): Promise<void> {
  for (const value of [appliesTo.employerSubsidiaryId, appliesTo.departmentId]) {
    if (value !== null && !isUuid(value)) {
      throw new HrmProcessError(
        "REFUSED",
        `applies_to carries ${JSON.stringify(value)}, which is not a uuid — pick the subsidiary and department by id, or null for all`,
      );
    }
  }
  const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  if (appliesTo.employerSubsidiaryId === null) {
    // Declaring (or keeping) an org-wide target is an org-wide write.
    await requireUnrestrictedHrmScope(exec, orgId, actorId);
  } else {
    // One scoped-existence check covers unknown, cross-org, and
    // out-of-scope subsidiaries identically: a B subsidiary reads to an
    // A-scoped actor exactly like a fabricated id.
    const found = (
      await exec.execute(
        sql`
      select 1 as one from subsidiaries
       where org_id = ${orgId} and id = ${appliesTo.employerSubsidiaryId}
         ${allowed === null ? sql`` : sql`and id = any (${`{${[...allowed].join(",")}}`}::uuid[])`}
    `,
        "objects",
      )
    )[0];
    if (!found) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template target is not visible in this organization — check the subsidiary id",
      );
    }
  }
  if (appliesTo.departmentId !== null) {
    const department = (
      await exec.execute<{ subsidiary_id: string | null; owner_exists: boolean }>(
        sql`
      select d.subsidiary_id,
             (d.subsidiary_id is null or s.id is not null) as owner_exists
        from departments d
        left join subsidiaries s on s.org_id = d.org_id and s.id = d.subsidiary_id
       where d.org_id = ${orgId} and d.id = ${appliesTo.departmentId}
       for update of d
    `,
        "objects",
      )
    )[0];
    if (
      !department?.owner_exists ||
      (department.subsidiary_id !== null &&
        allowed !== null &&
        !allowed.has(department.subsidiary_id))
    ) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template target is not visible in this organization — check the department id",
      );
    }
    // A shared department has no subsidiary owner and may be narrowed by an
    // explicit employer target. A subsidiary-owned department must match
    // that employer exactly; otherwise the template would cross entity lines.
    if (
      appliesTo.employerSubsidiaryId !== null &&
      department.subsidiary_id !== null &&
      department.subsidiary_id !== appliesTo.employerSubsidiaryId
    ) {
      throw new HrmProcessError(
        "REFUSED",
        "the applies_to department belongs to a different subsidiary than the employer target — choose a matching department or a shared department",
      );
    }
  }
}

/** Prove a named owner party is visible in this org — never a dangling owner. */
export async function assertOwnerParty(
  exec: SqlExecutor,
  orgId: string,
  ownerPartyId: string | null,
): Promise<void> {
  if (ownerPartyId === null) return;
  if (!isUuid(ownerPartyId)) {
    throw new HrmProcessError(
      "REFUSED",
      `owner party ${JSON.stringify(ownerPartyId)} is not a uuid — name a party of this organization`,
    );
  }
  const found = (
    await exec.execute(
      sql`
    select 1 as one from parties where org_id = ${orgId} and id = ${ownerPartyId}
  `,
      "objects",
    )
  )[0];
  if (!found) {
    throw new HrmProcessError(
      "REFUSED",
      "the owner party is not visible in this organization — name a party of this organization",
    );
  }
}

export function requireOwnerKind(ownerKind: unknown): string {
  const kinds = ["manager", "hr", "employee", "named_party"];
  if (typeof ownerKind !== "string" || !kinds.includes(ownerKind)) {
    throw new HrmProcessError(
      "REFUSED",
      `unknown step owner ${JSON.stringify(ownerKind)} — assign one of manager, hr, employee, or named_party`,
    );
  }
  return ownerKind;
}

export function requireEvidenceKind(evidenceKind: unknown): string {
  const kinds = ["none", "acknowledgement", "attachment"];
  if (typeof evidenceKind !== "string" || !kinds.includes(evidenceKind)) {
    throw new HrmProcessError(
      "REFUSED",
      `unknown evidence kind ${JSON.stringify(evidenceKind)} — require one of none, acknowledgement, or attachment`,
    );
  }
  return evidenceKind;
}

// --- Employment context for opening ------------------------------------------

export interface OpeningEmploymentContext {
  readonly employerSubsidiaryId: string;
  readonly departmentId: string | null;
}

/**
 * Load the employment context an applies_to filter matches against: the
 * stable legal employer plus the department of the currently-known
 * assignment slice covering the effective date (primary preferred). Recorded
 * "now" is the honest basis — a backdated open still matches what is known
 * today, never a superseded slice.
 */
export async function loadOpeningEmploymentContext(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  effectiveDate: string,
): Promise<OpeningEmploymentContext> {
  const stable = (
    await exec.execute<{ employer_subsidiary_id: string }>(
      sql`
    select employer_subsidiary_id from worker_employments
     where org_id = ${orgId} and id = ${employmentId}
  `,
      "objects",
    )
  )[0];
  if (!stable) {
    throw new HrmProcessError(
      "NOT_FOUND",
      "employment not found in this organization — check the employment id",
    );
  }
  const assignment = (
    await exec.execute<{ department_id: string | null }>(
      sql`
    select av.department_id::text as department_id
      from employment_assignment_versions av
     where av.org_id = ${orgId} and av.employment_id = ${employmentId}
       and av.recorded_until is null
       and av.effective_from <= ${effectiveDate}::date
       and (av.effective_to is null or av.effective_to > ${effectiveDate}::date)
     order by av.is_primary desc, av.version_no desc
     limit 1
  `,
      "objects",
    )
  )[0];
  return {
    employerSubsidiaryId: stable.employer_subsidiary_id,
    departmentId: assignment?.department_id ?? null,
  };
}

/**
 * Refuse when the employment carries no live version on the effective date:
 * a checklist for nobody-in-service is unconfigured input. Names the date
 * and the remedy (hire or record the version first).
 */
export async function assertLiveVersionOn(
  exec: SqlExecutor,
  orgId: string,
  employmentId: string,
  effectiveDate: string,
): Promise<void> {
  const live = (
    await exec.execute(
      sql`
    select 1 as one from worker_employment_versions
     where org_id = ${orgId} and employment_id = ${employmentId}
       and recorded_until is null
       and effective_from <= ${effectiveDate}::date
       and (effective_to is null or effective_to > ${effectiveDate}::date)
     limit 1
  `,
      "objects",
    )
  )[0];
  if (!live) {
    throw new HrmProcessError(
      "NO_LIVE_VERSION",
      `employment has no live version on ${effectiveDate} — hire or record the employment version first, then open the process`,
    );
  }
}

export type TemplateChoice = { id: string; kind: ProcessKind; name: string };

export async function resolveTemplateChoice(
  exec: SqlExecutor,
  orgId: string,
  kind: ProcessKind,
  employmentId: string,
  effectiveDate: string,
  templateId: string | null,
): Promise<{ template: TemplateChoice; steps: TemplateStepRow[] }> {
  if (templateId !== null) {
    const row = (
      await exec.execute<TemplateRow>(
        sql`
      select id, org_id, kind, name, applies_to, is_active,
             created_at, created_by, updated_at, updated_by
        from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId}
    `,
        "objects",
      )
    )[0];
    if (!row) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template not found in this organization — check the template id",
      );
    }
    if (row.kind !== kind) {
      throw new HrmProcessError(
        "REFUSED",
        `template ${JSON.stringify(row.name)} is an ${row.kind} checklist — pick an ${kind} template for an ${kind} process`,
      );
    }
    if (!row.is_active) {
      throw new HrmProcessError(
        "REFUSED",
        `template ${JSON.stringify(row.name)} is retired — reactivate it before opening a process from it`,
      );
    }
    const context = await loadOpeningEmploymentContext(exec, orgId, employmentId, effectiveDate);
    const employer =
      typeof row.applies_to?.employer_subsidiary_id === "string"
        ? row.applies_to.employer_subsidiary_id
        : null;
    const department =
      typeof row.applies_to?.department_id === "string" ? row.applies_to.department_id : null;
    if (
      (employer !== null && employer !== context.employerSubsidiaryId) ||
      (department !== null && department !== context.departmentId)
    ) {
      throw new HrmProcessError(
        "REFUSED",
        `template ${JSON.stringify(row.name)} does not cover this employment on ${effectiveDate} — choose a template offered by the checklist picker`,
      );
    }
    const steps = await loadTemplateSteps(exec, orgId, row.id);
    return { template: { id: row.id, kind, name: row.name }, steps };
  }
  const context = await loadOpeningEmploymentContext(exec, orgId, employmentId, effectiveDate);
  const candidates = await exec.execute<TemplateRow>(
    sql`
    select id, org_id, kind, name, applies_to, is_active,
           created_at, created_by, updated_at, updated_by
      from hrm_process_templates
     where org_id = ${orgId} and kind = ${kind} and is_active for share
  `,
    "objects",
  );
  let matchables: MatchableTemplate[];
  try {
    matchables = candidates.map((row) => ({
      id: row.id,
      employerSubsidiaryId:
        typeof row.applies_to?.employer_subsidiary_id === "string"
          ? row.applies_to.employer_subsidiary_id
          : null,
      departmentId:
        typeof row.applies_to?.department_id === "string" ? row.applies_to.department_id : null,
    }));
    const winner = resolveTemplateForEmployment(kind, matchables, context);
    const winnerRow = candidates.find((row) => row.id === winner.id)!;
    const steps = await loadTemplateSteps(exec, orgId, winnerRow.id);
    return { template: { id: winnerRow.id, kind, name: winnerRow.name }, steps };
  } catch (error) {
    mathRefusal(error, "TEMPLATE_NOT_FOUND");
  }
}

export async function loadTemplateSteps(
  exec: SqlExecutor,
  orgId: string,
  templateId: string,
  includeRetired = false,
): Promise<TemplateStepRow[]> {
  return await exec.execute<TemplateStepRow>(
    sql`
    select id, org_id, template_id, position, title, description, owner_kind, owner_party_id,
           due_offset_days, required, evidence_kind, design
      from hrm_process_template_steps
     where org_id = ${orgId} and template_id = ${templateId} ${includeRetired ? sql`` : sql`and is_current`}
     order by position
  `,
    "objects",
  );
}
