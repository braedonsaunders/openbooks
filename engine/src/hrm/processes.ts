import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { actorHasPermission, actorIdentity } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { HrmAuthorizationError, loadApprovalPerson } from "./authorization.ts";
import {
  requireHrmEmploymentManage,
  requireHrmProcessConfig,
  requireHrmProcessManage,
} from "./authorization.ts";
import { HRM_FEATURE_KEY } from "./employment-read.ts";
import {
  ProcessMathError,
  resolveTemplateForEmployment,
  snapshotTemplateSteps,
  summarizeProgress,
  type MatchableTemplate,
} from "./process-math.ts";
import { parseCivilDate } from "./temporal.ts";

/**
 * Governed HRM onboarding / offboarding / transfer checklists (0193).
 *
 * Templates are configuration (Setup registry pattern); processes are
 * snapshot history opened in the SAME transaction as the approved change
 * request that triggers them, so a partial effect cannot exist. Every
 * conditional write asserts its affected row count — a zero-row write is a
 * refusal, never a success — and every refusal names its remedy.
 *
 * Authorization is hardwired to engine/src/hrm/authorization.ts. Writes run
 * on the transaction runner so each check and its write are atomic. The one
 * exception is self-service: a step owner who is the employee themself may
 * complete only their own steps (see resolveStepOwner below), fenced to the
 * single step row — the first self-service touch, exposing nothing beyond
 * the step.
 *
 * Do not touch packages/payroll. Do not change the employment executor or
 * collector. Existing refusal classes are untouched — HrmProcessError below
 * is new.
 */

export type HrmProcessCode =
  | "NOT_FOUND"
  | "BAD_STATE"
  | "REFUSED"
  | "FORBIDDEN"
  | "TEMPLATE_NOT_FOUND"
  | "AMBIGUOUS_TEMPLATE"
  | "NO_LIVE_VERSION"
  | "DUPLICATE_OPEN"
  | "EVIDENCE_REQUIRED"
  | "UNREADABLE_ATTACHMENT"
  | "FEATURE_OFF";

export class HrmProcessError extends Error {
  readonly code: HrmProcessCode;
  constructor(code: HrmProcessCode, message: string) {
    super(message);
    this.name = "HrmProcessError";
    this.code = code;
  }
}

export type ProcessKind = "onboarding" | "offboarding" | "transfer";

const PROCESS_KINDS = ["onboarding", "offboarding", "transfer"] as const;

function requireKind(kind: unknown): ProcessKind {
  if (typeof kind !== "string" || !(PROCESS_KINDS as readonly string[]).includes(kind)) {
    throw new HrmProcessError(
      "REFUSED",
      `unknown process kind ${JSON.stringify(kind)} — open one of onboarding, offboarding, or transfer`,
    );
  }
  return kind as ProcessKind;
}

function requireOrgId(orgId: unknown): string {
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new HrmProcessError("REFUSED", "orgId must be a non-empty string");
  }
  return orgId;
}

function requireActorId(actorId: unknown): string {
  if (typeof actorId !== "string" || actorId.length === 0) {
    throw new HrmProcessError("REFUSED", "actorId must be a non-empty string");
  }
  return actorId;
}

function requireId(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HrmProcessError("REFUSED", `${field} must be a non-empty string`);
  }
  return value;
}

function requireNonBlank(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HrmProcessError("REFUSED", `${field} must be recorded — a reasonless checklist change is not evidence`);
  }
  return value.trim();
}

/** Translate pure-math refusals without losing their message. */
function mathRefusal(error: unknown, fallback: HrmProcessCode): never {
  if (error instanceof ProcessMathError) {
    throw new HrmProcessError(error.code as HrmProcessCode, error.message);
  }
  throw new HrmProcessError(fallback, error instanceof Error ? error.message : String(error));
}

async function assertHrmFeatureOn(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new HrmProcessError(
      "FEATURE_OFF",
      "hrm feature is disabled: enable it on Company Settings → Features before working with processes",
    );
  }
}

// --- Template rows and DTOs --------------------------------------------------

type TemplateRow = {
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

type TemplateStepRow = {
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
}

function toTemplateDTO(row: TemplateRow, stepCount: number): ProcessTemplateDTO {
  const raw = row.applies_to ?? {};
  return {
    id: row.id,
    kind: requireKind(row.kind),
    name: row.name,
    appliesTo: {
      employerSubsidiaryId: typeof raw.employer_subsidiary_id === "string" ? raw.employer_subsidiary_id : null,
      departmentId: typeof raw.department_id === "string" ? raw.department_id : null,
    },
    isActive: row.is_active,
    stepCount,
  };
}

function toTemplateStepDTO(row: TemplateStepRow): ProcessTemplateStepDTO {
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
  const employmentId = query.employmentId === undefined ? undefined : requireId("employmentId", query.employmentId);
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
    const rows = (await db.execute<TemplateRow & { step_count: number }>(sql`
      select t.id, t.org_id, t.kind, t.name, t.applies_to, t.is_active,
             t.created_at, t.created_by, t.updated_at, t.updated_by,
             count(s.id)::int as step_count
        from hrm_process_templates t
        left join hrm_process_template_steps s
          on s.org_id = t.org_id and s.template_id = t.id
       where t.org_id = ${orgId}
         ${query.activeOnly ? sql`and t.is_active` : sql``}
         ${kind ? sql`and t.kind = ${kind}` : sql``}
       group by t.id
       order by t.kind, t.name, t.id
    `)).rows;
    if (employmentId === undefined) return rows.map((row) => toTemplateDTO(row, row.step_count));
    const context = await loadOpeningEmploymentContext(db, orgId, employmentId, effectiveDate!);
    return rows
      .filter((row) => {
        const employer = typeof row.applies_to?.employer_subsidiary_id === "string"
          ? row.applies_to.employer_subsidiary_id
          : null;
        const department = typeof row.applies_to?.department_id === "string"
          ? row.applies_to.department_id
          : null;
        return (employer === null || employer === context.employerSubsidiaryId)
          && (department === null || department === context.departmentId);
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
  const templateId = requireId("templateId", query.templateId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessConfig(db, orgId, actorId);
    const row = (await db.execute<TemplateRow>(sql`
      select id, org_id, kind, name, applies_to, is_active,
             created_at, created_by, updated_at, updated_by
        from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId}
    `)).rows[0];
    if (!row) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template not found in this organization — open it from the template list",
      );
    }
    const steps = await loadTemplateSteps(db, orgId, templateId);
    return { ...toTemplateDTO(row, steps.length), steps: steps.map(toTemplateStepDTO) };
  });
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Prove filter targets before saving: a template whose filter names a
 * subsidiary or department outside this organization could never apply, so
 * saving it would report work no read can observe. Refused by field name.
 */
async function assertAppliesToTargets(
  exec: SqlExecutor,
  orgId: string,
  appliesTo: { employerSubsidiaryId: string | null; departmentId: string | null },
): Promise<void> {
  for (const value of [appliesTo.employerSubsidiaryId, appliesTo.departmentId]) {
    if (value !== null && !UUID_RE.test(value)) {
      throw new HrmProcessError(
        "REFUSED",
        `applies_to carries ${JSON.stringify(value)}, which is not a uuid — pick the subsidiary and department by id, or null for all`,
      );
    }
  }
  if (appliesTo.employerSubsidiaryId !== null) {
    const found = (await exec.execute(sql`
      select 1 as one from subsidiaries where org_id = ${orgId} and id = ${appliesTo.employerSubsidiaryId}
    `)).rows[0];
    if (!found) {
      throw new HrmProcessError(
        "REFUSED",
        "the applies_to subsidiary is not visible in this organization — pick a subsidiary of this organization, or null for all",
      );
    }
  }
  if (appliesTo.departmentId !== null) {
    const found = (await exec.execute(sql`
      select 1 as one from departments where org_id = ${orgId} and id = ${appliesTo.departmentId}
    `)).rows[0];
    if (!found) {
      throw new HrmProcessError(
        "REFUSED",
        "the applies_to department is not visible in this organization — pick a department of this organization, or null for all",
      );
    }
  }
}

/** Prove a named owner party is visible in this org — never a dangling owner. */
async function assertOwnerParty(exec: SqlExecutor, orgId: string, ownerPartyId: string | null): Promise<void> {
  if (ownerPartyId === null) return;
  if (!UUID_RE.test(ownerPartyId)) {
    throw new HrmProcessError(
      "REFUSED",
      `owner party ${JSON.stringify(ownerPartyId)} is not a uuid — name a party of this organization`,
    );
  }
  const found = (await exec.execute(sql`
    select 1 as one from parties where org_id = ${orgId} and id = ${ownerPartyId}
  `)).rows[0];
  if (!found) {
    throw new HrmProcessError(
      "REFUSED",
      "the owner party is not visible in this organization — name a party of this organization",
    );
  }
}

function requireOwnerKind(ownerKind: unknown): string {
  const kinds = ["manager", "hr", "employee", "named_party"];
  if (typeof ownerKind !== "string" || !kinds.includes(ownerKind)) {
    throw new HrmProcessError(
      "REFUSED",
      `unknown step owner ${JSON.stringify(ownerKind)} — assign one of manager, hr, employee, or named_party`,
    );
  }
  return ownerKind;
}

function requireEvidenceKind(evidenceKind: unknown): string {
  const kinds = ["none", "acknowledgement", "attachment"];
  if (typeof evidenceKind !== "string" || !kinds.includes(evidenceKind)) {
    throw new HrmProcessError(
      "REFUSED",
      `unknown evidence kind ${JSON.stringify(evidenceKind)} — require one of none, acknowledgement, or attachment`,
    );
  }
  return evidenceKind;
}

// --- Template CRUD (configuration; Setup registry pattern) -------------------

export interface CreateTemplateQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly kind: unknown;
  readonly name: unknown;
  readonly appliesTo?: { employerSubsidiaryId?: string | null; departmentId?: string | null };
}

export async function createProcessTemplate(query: CreateTemplateQuery): Promise<ProcessTemplateDTO> {
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
    await assertAppliesToTargets(db, orgId, appliesTo);
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
      `)).rows as TemplateRow[];
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
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

export async function updateProcessTemplate(query: UpdateTemplateQuery): Promise<ProcessTemplateDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const templateId = requireId("templateId", query.templateId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessConfig(db, orgId, actorId);
    const current = (await db.execute<TemplateRow>(sql`
      select id, org_id, kind, name, applies_to, is_active,
             created_at, created_by, updated_at, updated_by
        from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId} for update
    `)).rows[0];
    if (!current) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template not found in this organization — check the template id",
      );
    }
    const name = query.name === undefined ? current.name : requireNonBlank("name", query.name);
    const appliesTo =
      query.appliesTo === undefined
        ? {
            employerSubsidiaryId:
              typeof current.applies_to?.employer_subsidiary_id === "string"
                ? current.applies_to.employer_subsidiary_id
                : null,
            departmentId:
              typeof current.applies_to?.department_id === "string" ? current.applies_to.department_id : null,
          }
        : {
            employerSubsidiaryId: query.appliesTo?.employerSubsidiaryId ?? null,
            departmentId: query.appliesTo?.departmentId ?? null,
          };
    const isActive = query.isActive ?? current.is_active;
    await assertAppliesToTargets(db, orgId, appliesTo);
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
      `)).rows as TemplateRow[];
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
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
    const count = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from hrm_process_template_steps where org_id = ${orgId} and template_id = ${templateId}
    `)).rows[0]?.n ?? 0;
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
  const templateId = requireId("templateId", query.templateId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessConfig(db, orgId, actorId);
    const current = (await db.execute<TemplateRow>(sql`
      select id, org_id, kind, name, applies_to, is_active,
             created_at, created_by, updated_at, updated_by
        from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId} for update
    `)).rows[0];
    if (!current) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template not found in this organization — check the template id",
      );
    }
    const opened = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from hrm_processes where org_id = ${orgId} and template_id = ${templateId}
    `)).rows[0]?.n ?? 0;
    if (opened > 0) {
      throw new HrmProcessError(
        "REFUSED",
        `${opened} process(es) were opened from this template and it is retained as history — set is_active = false to retire it instead of deleting it`,
      );
    }
    const deleted = (await db.execute(sql`
      delete from hrm_process_templates where org_id = ${orgId} and id = ${templateId} returning id
    `)).rows;
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

export async function upsertProcessTemplateStep(query: UpsertTemplateStepQuery): Promise<ProcessTemplateStepDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const templateId = requireId("templateId", query.templateId);
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
       where org_id = ${orgId} and id = ${templateId}
    `)).rows[0];
    if (!template) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template not found in this organization — check the template id",
      );
    }
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
        `)).rows[0];
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
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
        `)).rows[0];
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
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
  const templateId = requireId("templateId", query.templateId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessConfig(db, orgId, actorId);
    const template = (await db.execute(sql`
      select id from hrm_process_templates where org_id = ${orgId} and id = ${templateId}
    `)).rows[0];
    if (!template) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template not found in this organization — check the template id",
      );
    }
    const current = (await db.execute<{ id: string }>(sql`
      select id from hrm_process_template_steps where org_id = ${orgId} and template_id = ${templateId}
    `)).rows.map((row) => row.id);
    const wanted = [...query.orderedStepIds];
    if (wanted.length !== current.length || new Set(wanted).size !== wanted.length ||
        !wanted.every((id) => current.includes(id))) {
      throw new HrmProcessError(
        "REFUSED",
        "the reorder must name exactly the template's current steps once each — reload the template and order the full list",
      );
    }
    // Step aside through negative positions so no two rows share one.
    for (let index = 0; index < wanted.length; index += 1) {
      const moved = (await db.execute(sql`
        update hrm_process_template_steps
           set position = ${-(index + 1)}, updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${wanted[index]} and template_id = ${templateId}
        returning id
      `)).rows;
      if (moved.length !== 1) {
        throw new HrmProcessError(
          "REFUSED",
          "the reorder matched no rows mid-write — nothing reordered; reload the template and try again",
        );
      }
    }
    for (let index = 0; index < wanted.length; index += 1) {
      const moved = (await db.execute(sql`
        update hrm_process_template_steps
           set position = ${index}, updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${wanted[index]} and template_id = ${templateId}
        returning id
      `)).rows;
      if (moved.length !== 1) {
        throw new HrmProcessError(
          "REFUSED",
          "the reorder matched no rows mid-write — nothing reordered; reload the template and try again",
        );
      }
    }
    const rows = (await db.execute<TemplateStepRow>(sql`
      select id, org_id, template_id, position, title, description, owner_kind, owner_party_id,
             due_offset_days, required, evidence_kind
        from hrm_process_template_steps
       where org_id = ${orgId} and template_id = ${templateId}
       order by position
    `)).rows;
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
  const templateId = requireId("templateId", query.templateId);
  const stepId = requireId("stepId", query.stepId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await requireHrmProcessConfig(db, orgId, actorId);
    // Opened processes hold snapshots, so deleting a template step never
    // rewrites history — lineage on copied steps simply clears (SET NULL).
    const deleted = (await db.execute(sql`
      delete from hrm_process_template_steps
       where org_id = ${orgId} and id = ${stepId} and template_id = ${templateId}
      returning id
    `)).rows;
    if (deleted.length !== 1) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "template step not found on this template in this organization — check the step id",
      );
    }
  });
}

// --- Runtime rows and DTOs ---------------------------------------------------

type ProcessRow = {
  id: string;
  org_id: string;
  template_id: string;
  employment_id: string;
  kind: string;
  effective_date: string;
  status: string;
  opened_by_change_id: string | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
};

export interface ProcessDTO {
  readonly id: string;
  readonly templateId: string;
  readonly employmentId: string;
  readonly kind: ProcessKind;
  readonly effectiveDate: string;
  readonly status: string;
  readonly openedByChangeId: string | null;
  readonly progress: { total: number; required: number; doneRequired: number; allRequiredDone: boolean };
}

type StepRow = {
  id: string;
  org_id: string;
  process_id: string;
  template_step_id: string | null;
  position: number;
  title: string;
  description: string | null;
  owner_kind: string;
  owner_party_id: string | null;
  due_on: string;
  required: boolean;
  evidence_kind: string;
  status: string;
  done_by: string | null;
  done_at: Date | null;
  skip_reason: string | null;
  attachment_id: string | null;
  employment_id: string;
  process_status: string;
  process_kind: string;
  worker_party_id: string;
};

const STEP_COLUMNS = sql`
  s.id, s.org_id, s.process_id, s.template_step_id, s.position, s.title,
  s.description, s.owner_kind, s.owner_party_id,
  s.due_on::text as due_on, s.required, s.evidence_kind, s.status,
  s.done_by, s.done_at, s.skip_reason, s.attachment_id,
  p.employment_id, p.status as process_status, p.kind as process_kind,
  e.worker_party_id
`;

async function loadStepForUpdate(
  exec: SqlExecutor,
  orgId: string,
  stepId: string,
): Promise<StepRow> {
  const row = (await exec.execute<StepRow>(sql`
    select ${STEP_COLUMNS}
      from hrm_process_steps s
      join hrm_processes p on p.org_id = s.org_id and p.id = s.process_id
      join worker_employments e on e.org_id = s.org_id and e.id = p.employment_id
     where s.org_id = ${orgId} and s.id = ${stepId} for update
  `)).rows[0];
  // Zero rows is a failure: unknown id, or an id from another organization
  // (the org_id predicate is the org-isolation enforcement).
  if (!row) {
    throw new HrmProcessError(
      "NOT_FOUND",
      "process step not found in this organization — check the step id",
    );
  }
  return row;
}

async function loadProcessForUpdate(
  exec: SqlExecutor,
  orgId: string,
  processId: string,
): Promise<ProcessRow> {
  const row = (await exec.execute<ProcessRow>(sql`
    select id, org_id, template_id, employment_id, kind,
           effective_date::text as effective_date, status,
           opened_by_change_id, completed_at, cancelled_at, cancel_reason
      from hrm_processes
     where org_id = ${orgId} and id = ${processId} for update
  `)).rows[0];
  if (!row) {
    throw new HrmProcessError(
      "NOT_FOUND",
      "process not found in this organization — check the process id",
    );
  }
  return row;
}

/**
 * Who may act on one step, decided over trusted-DB-loaded parties only.
 * "manager" holds hrm.process.manage in the employment's scope; "owner" is
 * the employee themself on their own step — owner_kind employee on their
 * own employment, or named_party naming their party. Anything else is
 * nobody's step to touch.
 */
export type StepActor = "manager" | "owner" | "stranger";

export async function resolveStepActor(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  step: Pick<StepRow, "owner_kind" | "owner_party_id" | "employment_id" | "worker_party_id">,
): Promise<StepActor> {
  if (await actorHasPermission(exec, orgId, actorId, "hrm.process.manage")) {
    // Permission alone is not scope: the manager must also see the employer.
    const allowed = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
    if (allowed !== null) {
      const employer = (await exec.execute<{ employer_subsidiary_id: string }>(sql`
        select employer_subsidiary_id from worker_employments
         where org_id = ${orgId} and id = ${step.employment_id}
      `)).rows[0];
      if (!employer || !allowed.has(employer.employer_subsidiary_id)) {
        return "stranger";
      }
    }
    return "manager";
  }
  const person = await loadApprovalPerson(exec, orgId, actorId);
  if (person.partyId === null) return "stranger";
  if (step.owner_kind === "employee" && person.partyId === step.worker_party_id) return "owner";
  if (step.owner_kind === "named_party" && person.partyId === step.owner_party_id) return "owner";
  return "stranger";
}

/**
 * Engine-side mirror of the File Cabinet read rule
 * (web/lib/file-cabinet.ts resolveReadScope): the file must be org-visible
 * and live, and the actor must be a super admin, see the file's folder
 * (outside another's private subtree, or re-opened by a grant), or hold a
 * direct file grant. Raw SQL over the cabinet tables — no module edge, no
 * duplicated logic drift beyond this one documented mirror.
 */
async function assertAttachmentReadable(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  attachmentId: string,
): Promise<void> {
  if (!UUID_RE.test(attachmentId)) {
    throw new HrmProcessError(
      "UNREADABLE_ATTACHMENT",
      `attachment ${JSON.stringify(attachmentId)} is not a file id — attach a file from this organization's File Cabinet`,
    );
  }
  const identity = await actorIdentity(exec, orgId, actorId);
  if (!identity?.isActive) {
    throw new HrmProcessError(
      "UNREADABLE_ATTACHMENT",
      "the identity behind this action is not established in this organization — attachment evidence needs an active user",
    );
  }
  const readable = (await exec.execute<{ readable: boolean }>(sql`
    with recursive hidden_folders as (
      select id, parent_folder_id from folders
       where org_id = ${orgId} and is_private and owner_id is distinct from ${actorId}
      union
      select f.id, f.parent_folder_id from folders f
        join hidden_folders h on f.parent_folder_id = h.id
       where f.org_id = ${orgId}
    ),
    granted_folders as (
      select g.resource_id as id from resource_grants g
       where g.org_id = ${orgId} and g.resource_type = 'folder'
         and ((g.principal_type = 'user' and g.principal_id = ${actorId})
              or (g.principal_type = 'role' and g.principal_id in (
                    select role_id from role_assignments where org_id = ${orgId} and user_id = ${actorId})))
      union
      select f.id from folders f
        join granted_folders gr on f.parent_folder_id = gr.id
       where f.org_id = ${orgId}
    )
    select exists(
      select 1 from files f
       where f.org_id = ${orgId} and f.id = ${attachmentId} and not f.is_inactive
         and (${identity.isSuperAdmin}
              or f.folder_id not in (
                    select id from hidden_folders
                     where id not in (select id from granted_folders))
              or exists (
                    select 1 from resource_grants g
                     where g.org_id = ${orgId} and g.resource_type = 'file'
                       and g.resource_id = f.id
                       and ((g.principal_type = 'user' and g.principal_id = ${actorId})
                            or (g.principal_type = 'role' and g.principal_id in (
                                  select role_id from role_assignments
                                   where org_id = ${orgId} and user_id = ${actorId})))))) as readable
  `)).rows[0]?.readable;
  if (!readable) {
    throw new HrmProcessError(
      "UNREADABLE_ATTACHMENT",
      "that file is not readable by this actor — attach a file from a shared folder, or ask its owner to share it",
    );
  }
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
  const stable = (await exec.execute<{ employer_subsidiary_id: string }>(sql`
    select employer_subsidiary_id from worker_employments
     where org_id = ${orgId} and id = ${employmentId}
  `)).rows[0];
  if (!stable) {
    throw new HrmProcessError(
      "NOT_FOUND",
      "employment not found in this organization — check the employment id",
    );
  }
  const assignment = (await exec.execute<{ department_id: string | null }>(sql`
    select av.department_id::text as department_id
      from employment_assignment_versions av
     where av.org_id = ${orgId} and av.employment_id = ${employmentId}
       and av.recorded_until is null
       and av.effective_from <= ${effectiveDate}::date
       and (av.effective_to is null or av.effective_to > ${effectiveDate}::date)
     order by av.is_primary desc, av.version_no desc
     limit 1
  `)).rows[0];
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
  const live = (await exec.execute(sql`
    select 1 as one from worker_employment_versions
     where org_id = ${orgId} and employment_id = ${employmentId}
       and recorded_until is null
       and effective_from <= ${effectiveDate}::date
       and (effective_to is null or effective_to > ${effectiveDate}::date)
     limit 1
  `)).rows[0];
  if (!live) {
    throw new HrmProcessError(
      "NO_LIVE_VERSION",
      `employment has no live version on ${effectiveDate} — hire or record the employment version first, then open the process`,
    );
  }
}

type TemplateChoice = { id: string; kind: ProcessKind; name: string };

async function resolveTemplateChoice(
  exec: SqlExecutor,
  orgId: string,
  kind: ProcessKind,
  employmentId: string,
  effectiveDate: string,
  templateId: string | null,
): Promise<{ template: TemplateChoice; steps: TemplateStepRow[] }> {
  if (templateId !== null) {
    const row = (await exec.execute<TemplateRow>(sql`
      select id, org_id, kind, name, applies_to, is_active,
             created_at, created_by, updated_at, updated_by
        from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId}
    `)).rows[0];
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
    const employer = typeof row.applies_to?.employer_subsidiary_id === "string"
      ? row.applies_to.employer_subsidiary_id
      : null;
    const department = typeof row.applies_to?.department_id === "string"
      ? row.applies_to.department_id
      : null;
    if ((employer !== null && employer !== context.employerSubsidiaryId)
        || (department !== null && department !== context.departmentId)) {
      throw new HrmProcessError(
        "REFUSED",
        `template ${JSON.stringify(row.name)} does not cover this employment on ${effectiveDate} — choose a template offered by the checklist picker`,
      );
    }
    const steps = await loadTemplateSteps(exec, orgId, row.id);
    return { template: { id: row.id, kind, name: row.name }, steps };
  }
  const context = await loadOpeningEmploymentContext(exec, orgId, employmentId, effectiveDate);
  const candidates = (await exec.execute<TemplateRow>(sql`
    select id, org_id, kind, name, applies_to, is_active,
           created_at, created_by, updated_at, updated_by
      from hrm_process_templates
     where org_id = ${orgId} and kind = ${kind} and is_active
  `)).rows;
  let matchables: MatchableTemplate[];
  try {
    matchables = candidates.map((row) => ({
      id: row.id,
      employerSubsidiaryId:
        typeof row.applies_to?.employer_subsidiary_id === "string" ? row.applies_to.employer_subsidiary_id : null,
      departmentId: typeof row.applies_to?.department_id === "string" ? row.applies_to.department_id : null,
    }));
    const winner = resolveTemplateForEmployment(kind, matchables, context);
    const winnerRow = candidates.find((row) => row.id === winner.id)!;
    const steps = await loadTemplateSteps(exec, orgId, winnerRow.id);
    return { template: { id: winnerRow.id, kind, name: winnerRow.name }, steps };
  } catch (error) {
    mathRefusal(error, "TEMPLATE_NOT_FOUND");
  }
}

async function loadTemplateSteps(exec: SqlExecutor, orgId: string, templateId: string): Promise<TemplateStepRow[]> {
  return (await exec.execute<TemplateStepRow>(sql`
    select id, org_id, template_id, position, title, description, owner_kind, owner_party_id,
           due_offset_days, required, evidence_kind
      from hrm_process_template_steps
     where org_id = ${orgId} and template_id = ${templateId}
     order by position
  `)).rows;
}

// --- Open a process ----------------------------------------------------------

export interface OpenProcessQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly kind: unknown;
  readonly effectiveDate: string;
  readonly templateId?: string;
}

/**
 * Open a checklist for an employment: refuse when the employment has no
 * live version on the effective date, refuse a duplicate open process of
 * the same kind, and instantiate the template as a snapshot in the same
 * transaction. The partial unique index repeats the duplicate refusal for
 * racers (mapped below, never a raw 23505).
 */
export async function openProcess(query: OpenProcessQuery): Promise<ProcessDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const employmentId = requireId("employmentId", query.employmentId);
  const kind = requireKind(query.kind);
  let effectiveDate: string;
  try {
    effectiveDate = parseCivilDate(query.effectiveDate);
  } catch {
    throw new HrmProcessError(
      "REFUSED",
      `effective date ${JSON.stringify(query.effectiveDate)} is not a real YYYY-MM-DD calendar date — open the process on the employment event date`,
    );
  }
  const templateId = query.templateId === undefined ? null : requireId("templateId", query.templateId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    // Authority first: denial (including unknown/other-org employment)
    // reports uniformly through the authorization gate.
    await requireHrmProcessManage(db, orgId, actorId, employmentId);
    return openProcessInTx(db, {
      orgId,
      actorId,
      employmentId,
      kind,
      effectiveDate,
      templateId,
      openedByChangeId: null,
    });
  });
}

export interface OpenProcessInTx {
  readonly orgId: string;
  readonly actorId: string;
  readonly employmentId: string;
  readonly kind: ProcessKind;
  readonly effectiveDate: string;
  readonly templateId: string | null;
  readonly openedByChangeId: string | null;
}

/**
 * Transactional open shared by the manual entry and the change-request
 * auto-open hook: runs on the caller's runner inside the caller's
 * transaction, so a failed open rolls the canonical versions back with it.
 */
export async function openProcessInTx(exec: SqlExecutor, args: OpenProcessInTx): Promise<ProcessDTO> {
  const { orgId, actorId, employmentId, kind, effectiveDate, templateId, openedByChangeId } = args;
  await assertLiveVersionOn(exec, orgId, employmentId, effectiveDate);
  const dupe = (await exec.execute(sql`
    select id from hrm_processes
     where org_id = ${orgId} and employment_id = ${employmentId}
       and kind = ${kind} and status = 'open'
     limit 1
  `)).rows[0];
  if (dupe) {
    throw new HrmProcessError(
      "DUPLICATE_OPEN",
      `an open ${kind} process already exists for this employment — complete or cancel it before opening another`,
    );
  }
  let choice: { template: TemplateChoice; steps: TemplateStepRow[] };
  try {
    choice = await resolveTemplateChoice(exec, orgId, kind, employmentId, effectiveDate, templateId);
  } catch (error) {
    if (error instanceof HrmProcessError) throw error;
    mathRefusal(error, "TEMPLATE_NOT_FOUND");
  }
  let snapshots;
  try {
    snapshots = snapshotTemplateSteps(
      choice.template.id,
      choice.steps.map((step) => ({
        id: step.id,
        position: step.position,
        title: step.title,
        description: step.description,
        ownerKind: step.owner_kind,
        ownerPartyId: step.owner_party_id,
        dueOffsetDays: step.due_offset_days,
        required: step.required,
        evidenceKind: step.evidence_kind,
      })),
      effectiveDate,
    );
  } catch (error) {
    mathRefusal(error, "REFUSED");
  }
  let processId: string;
  try {
    const inserted = (await exec.execute<{ id: string }>(sql`
      insert into hrm_processes
        (org_id, template_id, employment_id, kind, effective_date, opened_by_change_id, created_by, updated_by)
      values (${orgId}, ${choice.template.id}, ${employmentId}, ${kind},
              ${effectiveDate}::date, ${openedByChangeId}, ${actorId}, ${actorId})
      returning id
    `)).rows[0];
    if (!inserted) {
      throw new HrmProcessError(
        "REFUSED",
        "the process was not stored — nothing opened; retry the open",
      );
    }
    processId = inserted.id;
  } catch (error) {
    if ((error as { code?: string }).code === "23505") {
      throw new HrmProcessError(
        "DUPLICATE_OPEN",
        `an open ${kind} process already exists for this employment — complete or cancel it before opening another`,
      );
    }
    throw error;
  }
  for (const snapshot of snapshots) {
    const stored = (await exec.execute(sql`
      insert into hrm_process_steps
        (org_id, process_id, template_step_id, position, title, description,
         owner_kind, owner_party_id, due_on, required, evidence_kind, created_by, updated_by)
      values (${orgId}, ${processId}, ${snapshot.templateStepId}, ${snapshot.position},
              ${snapshot.title}, ${snapshot.description}, ${snapshot.ownerKind},
              ${snapshot.ownerPartyId}, ${snapshot.dueOn}::date,
              ${snapshot.required}, ${snapshot.evidenceKind}, ${actorId}, ${actorId})
      returning id
    `)).rows;
    if (stored.length !== 1) {
      throw new HrmProcessError(
        "REFUSED",
        "a checklist step was not stored — nothing opened; retry the open",
      );
    }
  }
  const progress = await readProgress(exec, orgId, processId);
  return {
    id: processId,
    templateId: choice.template.id,
    employmentId,
    kind,
    effectiveDate,
    status: "open",
    openedByChangeId,
    progress,
  };
}

async function readProgress(
  exec: SqlExecutor,
  orgId: string,
  processId: string,
): Promise<ProcessDTO["progress"]> {
  const rows = (await exec.execute<{ required: boolean; status: string }>(sql`
    select required, status from hrm_process_steps
     where org_id = ${orgId} and process_id = ${processId}
  `)).rows;
  try {
    const summary = summarizeProgress(rows);
    return {
      total: summary.total,
      required: summary.required,
      doneRequired: summary.doneRequired,
      allRequiredDone: summary.allRequiredDone,
    };
  } catch (error) {
    mathRefusal(error, "REFUSED");
  }
}

// --- Complete / skip a step --------------------------------------------------

export interface CompleteStepQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly stepId: string;
  /** Required when the step's evidence_kind is attachment. */
  readonly attachmentId?: string;
}

/**
 * Complete one pending step. Evidence is enforced by kind: acknowledgement
 * records who (done_by) and when (done_at); attachment needs a file the
 * actor may read; none flips clean. A manager (hrm.process.manage in
 * scope) may complete any step; the employee may complete only their own.
 */
export async function completeProcessStep(query: CompleteStepQuery): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const stepId = requireId("stepId", query.stepId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    const step = await loadStepForUpdate(db, orgId, stepId);
    if (step.process_status !== "open") {
      throw new HrmProcessError(
        "BAD_STATE",
        `the process is ${step.process_status} — a ${step.process_status} checklist takes no completions; open a new process for further work`,
      );
    }
    if (step.status !== "pending") {
      throw new HrmProcessError(
        "BAD_STATE",
        `this step is already ${step.status} — completed and skipped steps stand as recorded`,
      );
    }
    const actor = await resolveStepActor(db, orgId, actorId, step);
    if (actor === "stranger") {
      // Permission leg names the remedy; the scope leg stays uniform with
      // unknown ids (the employment-gate shape), so scope cannot be probed.
      if (await actorHasPermission(db, orgId, actorId, "hrm.process.manage")) {
        throw new HrmAuthorizationError(
          "Employment is not visible in this organization and legal-entity scope.",
        );
      }
      throw new HrmProcessError(
        "FORBIDDEN",
        "this step is owned by someone else — ask its owner or a manager to complete it, or hold hrm.process.manage in the employer's scope",
      );
    }
    let attachmentId: string | null = null;
    if (step.evidence_kind === "attachment") {
      if (typeof query.attachmentId !== "string" || query.attachmentId.length === 0) {
        throw new HrmProcessError(
          "EVIDENCE_REQUIRED",
          "this step requires attachment evidence — attach a file the completing actor may read",
        );
      }
      await assertAttachmentReadable(db, orgId, actorId, query.attachmentId);
      attachmentId = query.attachmentId;
    } else if (query.attachmentId !== undefined) {
      throw new HrmProcessError(
        "REFUSED",
        `this step takes ${step.evidence_kind} evidence — drop the attachment to complete it`,
      );
    }
    const done = (await db.execute(sql`
      update hrm_process_steps
         set status = 'done', done_by = ${actorId}, done_at = now(),
             attachment_id = ${attachmentId}, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${stepId} and status = 'pending'
      returning id
    `)).rows;
    if (done.length !== 1) {
      throw new HrmProcessError(
        "REFUSED",
        "the step changed while completing — nothing completed; reload the checklist and try again",
      );
    }
  });
}

export interface SkipStepQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly stepId: string;
  readonly reason: unknown;
}

/**
 * Skip one pending step with a reason (storage pins every skip to a
 * non-blank reason — reasonless history is not evidence). Skipping a
 * REQUIRED step needs hrm.employment.manage in scope; optional steps take
 * the manager or the owner.
 */
export async function skipProcessStep(query: SkipStepQuery): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const stepId = requireId("stepId", query.stepId);
  const reason = requireNonBlank("reason", query.reason);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    const step = await loadStepForUpdate(db, orgId, stepId);
    if (step.process_status !== "open") {
      throw new HrmProcessError(
        "BAD_STATE",
        `the process is ${step.process_status} — a ${step.process_status} checklist takes no skips; open a new process for further work`,
      );
    }
    if (step.status !== "pending") {
      throw new HrmProcessError(
        "BAD_STATE",
        `this step is already ${step.status} — completed and skipped steps stand as recorded`,
      );
    }
    if (step.required) {
      // Authority first, in-transaction: the employment.manage gate carries
      // the permission plus the employer scope.
      await requireHrmEmploymentManage(db, orgId, actorId, step.employment_id);
    } else {
      const actor = await resolveStepActor(db, orgId, actorId, step);
      if (actor === "stranger") {
        if (await actorHasPermission(db, orgId, actorId, "hrm.process.manage")) {
          throw new HrmAuthorizationError(
            "Employment is not visible in this organization and legal-entity scope.",
          );
        }
        throw new HrmProcessError(
          "FORBIDDEN",
          "this step is owned by someone else — ask its owner or a manager to skip it, or hold hrm.process.manage in the employer's scope",
        );
      }
    }
    const skipped = (await db.execute(sql`
      update hrm_process_steps
         set status = 'skipped', skip_reason = ${reason},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${stepId} and status = 'pending'
      returning id
    `)).rows;
    if (skipped.length !== 1) {
      throw new HrmProcessError(
        "REFUSED",
        "the step changed while skipping — nothing skipped; reload the checklist and try again",
      );
    }
  });
}

// --- Complete / cancel a process ---------------------------------------------

export async function completeProcess(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly processId: string;
}): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const processId = requireId("processId", query.processId);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    const process = await loadProcessForUpdate(db, orgId, processId);
    if (process.status !== "open") {
      throw new HrmProcessError(
        "BAD_STATE",
        `the process is already ${process.status} — ${process.status} checklists stay as recorded`,
      );
    }
    await requireHrmProcessManage(db, orgId, actorId, process.employment_id);
    const pending = (await db.execute<{ title: string }>(sql`
      select title from hrm_process_steps
       where org_id = ${orgId} and process_id = ${processId}
         and required and status = 'pending'
       order by position
    `)).rows;
    if (pending.length > 0) {
      const names = pending.slice(0, 3).map((row) => JSON.stringify(row.title)).join(", ");
      const more = pending.length > 3 ? ` and ${pending.length - 3} more` : "";
      throw new HrmProcessError(
        "REFUSED",
        `${pending.length} required step(s) still pending (${names}${more}) — complete or skip them before completing the process`,
      );
    }
    const completed = (await db.execute(sql`
      update hrm_processes
         set status = 'completed', completed_at = now(),
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${processId} and status = 'open'
      returning id
    `)).rows;
    if (completed.length !== 1) {
      throw new HrmProcessError(
        "REFUSED",
        "the process left the open state while completing — nothing completed; reload it and try again",
      );
    }
  });
}

export async function cancelProcess(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly processId: string;
  readonly reason: unknown;
}): Promise<void> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const processId = requireId("processId", query.processId);
  const reason = requireNonBlank("reason", query.reason);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    const process = await loadProcessForUpdate(db, orgId, processId);
    if (process.status !== "open") {
      throw new HrmProcessError(
        "BAD_STATE",
        `the process is already ${process.status} — ${process.status} checklists stay as recorded`,
      );
    }
    await requireHrmProcessManage(db, orgId, actorId, process.employment_id);
    const cancelled = (await db.execute(sql`
      update hrm_processes
         set status = 'cancelled', cancelled_at = now(), cancel_reason = ${reason},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${processId} and status = 'open'
      returning id
    `)).rows;
    if (cancelled.length !== 1) {
      throw new HrmProcessError(
        "REFUSED",
        "the process left the open state while cancelling — nothing cancelled; reload it and try again",
      );
    }
  });
}

// --- Automatic opening from the change-request apply -------------------------

export type AutoOpenTrigger =
  | { readonly trigger: "hire"; readonly effectiveDate: string }
  | { readonly trigger: "termination"; readonly effectiveDate: string }
  | { readonly trigger: "transfer"; readonly effectiveDate: string };

export type ChangeTriggerInput =
  | { readonly kind: "hire"; readonly effectiveFrom: string }
  | { readonly kind: "status_change" }
  | { readonly kind: "termination"; readonly effectiveDate: string }
  | { readonly kind: "assignment_change"; readonly departmentChanged: boolean; readonly windowStart: string };

/**
 * Pure mapping from an approved change to the checklist it owes (or null
 * when it owes none). Hire activates → onboarding; termination ends →
 * offboarding; an assignment_change that really moves departments →
 * transfer. A status_change rides the hire's onboarding episode, and a new
 * slot or a department-carryover repoint moves nobody — both open nothing.
 * The apply branches call this (never inline `if`s) so the mapping has one
 * unit-tested home.
 */
export function processTriggerForApply(input: ChangeTriggerInput): AutoOpenTrigger | null {
  switch (input.kind) {
    case "hire":
      return { trigger: "hire", effectiveDate: input.effectiveFrom };
    case "termination":
      return { trigger: "termination", effectiveDate: input.effectiveDate };
    case "status_change":
      return null;
    case "assignment_change":
      return input.departmentChanged ? { trigger: "transfer", effectiveDate: input.windowStart } : null;
  }
}

/**
 * Open the checklist an approved employment change owes, on the change
 * request's own transaction runner: hire → onboarding, termination →
 * offboarding, department change → transfer. No separate authority check:
 * the approved decision IS the authority, and the open runs inside the
 * apply transaction — any throw (no template, no live version, duplicate
 * open) rolls the canonical versions back with it, so a partial effect
 * (versions without their checklist) cannot exist.
 *
 * Fenced by the hrm feature switch, not by template presence: an org with
 * hrm off runs no checklists by explicit configuration (payroll stays
 * independently usable while HRM is off, per the 0185 contract), so the
 * hook is a no-op there. With hrm ON, every triggering change owes its
 * process — a missing one fails the apply, never a silent skip.
 *
 * Transfer scope note: the legal employer is immutable per 0184 (a transfer
 * across employers is terminate + rehire, which opens offboarding on the
 * old row and onboarding on the new one). An employer-subsidiary value can
 * therefore never "change" on one row — the transfer trigger here is the
 * department change carried by an assignment_change.
 */
export async function autoOpenProcessForChange(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    employmentId: string;
    changeId: string;
    trigger: AutoOpenTrigger;
  },
): Promise<ProcessDTO | null> {
  if (!(await lockAndCheckOrgFeature(exec, args.orgId, HRM_FEATURE_KEY))) return null;
  const kind: ProcessKind =
    args.trigger.trigger === "hire"
      ? "onboarding"
      : args.trigger.trigger === "termination"
        ? "offboarding"
        : "transfer";
  try {
    return await openProcessInTx(exec, {
      orgId: args.orgId,
      actorId: args.actorId,
      employmentId: args.employmentId,
      kind,
      effectiveDate: args.trigger.effectiveDate,
      templateId: null,
      openedByChangeId: args.changeId,
    });
  } catch (error) {
    // The automatic opening is a side effect of an employment event, never a
    // condition on it: an org with no checklist template covering this
    // employment, or one whose checklist of this kind is already open, still
    // gets its hire, termination or transfer applied — nothing is owed here,
    // so nothing opens. Both cases stay REFUSALS on the explicit path
    // (openProcess), where the operator asked for a checklist by name and
    // must hear why there is none. Every other failure still rolls the whole
    // application back.
    if (error instanceof HrmProcessError && (error.code === "TEMPLATE_NOT_FOUND" || error.code === "DUPLICATE_OPEN")) {
      return null;
    }
    throw error;
  }
}
