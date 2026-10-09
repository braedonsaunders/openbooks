import {
  checklistDocumentSchema,
  checklistStepDesignSchema,
  checklistIssues,
  checklistConditionPredicates,
  includedChecklistSteps,
  emptyStepDesign,
  validateResponse,
  splitRecordData,
  withComputedFormulas,
  CHECKLIST_STEP_SUBJECT_KIND,
  type ChecklistDocument,
  type ChecklistStepDesign,
} from "@openbooks/forms-core";
import { cancelDispatchRuns, dispatchFailureReason } from "../flows/dispatch-result.ts";
import { businessToday } from "../platform/business-date.ts";
import { runRecordFlows } from "../flows/run.ts";
import { lockFlowSubjectDecision } from "../flows/decision-lock.ts";
import { completedGateAllowsSelfApproval } from "../flows/approval-decision-policy.ts";
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
  requireUnrestrictedHrmScope,
} from "./authorization.ts";
import { HRM_FEATURE_KEY } from "./employment-read.ts";
import {
  ProcessMathError,
  addOffsetDays,
  resolveTemplateForEmployment,
  snapshotTemplateSteps,
  summarizeProgress,
  type MatchableTemplate,
} from "./process-math.ts";
import { parseCivilDate } from "./temporal.ts";
import { isUniqueViolation } from "./field-time/errors.ts";
import { isUuid } from "../platform/uuid.ts";
import { inputGuards } from "./input-guards.ts";

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

const { requireOrgId, requireActorId, requireId } = inputGuards(
  (message) => new HrmProcessError("REFUSED", message),
);

function requireNonBlank(field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new HrmProcessError(
      "REFUSED",
      `${field} must be recorded — a reasonless checklist change is not evidence`,
    );
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

function toTemplateDTO(row: TemplateRow, stepCount: number): ProcessTemplateDTO {
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
    const rows = (
      await db.execute<TemplateRow & { step_count: number }>(sql`
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
    `)
    ).rows;
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
      await db.execute<TemplateRow>(sql`
      select id, org_id, kind, name, applies_to, is_active,
             created_at, created_by, updated_at, updated_by
        from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId} for share
    `)
    ).rows[0];
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
async function assertTemplateWriteScope(
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

function templateAppliesTo(
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
async function scopeTemplateRows<T extends Pick<TemplateRow, "applies_to">>(
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
    const owners = (
      await exec.execute<{ id: string; subsidiary_id: string | null }>(sql`
      select id::text as id, subsidiary_id::text as subsidiary_id from departments
       where org_id = ${orgId} and id = any (${`{${departmentIds.join(",")}}`}::uuid[])
    `)
    ).rows;
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
async function assertAppliesToTargets(
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
      await exec.execute(sql`
      select 1 as one from subsidiaries
       where org_id = ${orgId} and id = ${appliesTo.employerSubsidiaryId}
         ${allowed === null ? sql`` : sql`and id = any (${`{${[...allowed].join(",")}}`}::uuid[])`}
    `)
    ).rows[0];
    if (!found) {
      throw new HrmProcessError(
        "NOT_FOUND",
        "process template target is not visible in this organization — check the subsidiary id",
      );
    }
  }
  if (appliesTo.departmentId !== null) {
    const department = (
      await exec.execute<{ subsidiary_id: string | null; owner_exists: boolean }>(sql`
      select d.subsidiary_id,
             (d.subsidiary_id is null or s.id is not null) as owner_exists
        from departments d
        left join subsidiaries s on s.org_id = d.org_id and s.id = d.subsidiary_id
       where d.org_id = ${orgId} and d.id = ${appliesTo.departmentId}
       for update of d
    `)
    ).rows[0];
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
async function assertOwnerParty(
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
    await exec.execute(sql`
    select 1 as one from parties where org_id = ${orgId} and id = ${ownerPartyId}
  `)
  ).rows[0];
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
      inserted = (
        await db.execute<TemplateRow>(sql`
        insert into hrm_process_templates (org_id, kind, name, applies_to, created_by, updated_by)
        values (${orgId}, ${kind}, ${name},
                ${JSON.stringify({ employer_subsidiary_id: appliesTo.employerSubsidiaryId, department_id: appliesTo.departmentId })}::jsonb,
                ${actorId}, ${actorId})
        returning id, org_id, kind, name,
                  applies_to as "applies_to",
                  is_active as "is_active",
                  created_at as "created_at", created_by as "created_by",
                  updated_at as "updated_at", updated_by as "updated_by"
      `)
      ).rows as TemplateRow[];
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
    const current = (
      await db.execute<TemplateRow>(sql`
      select id, org_id, kind, name, applies_to, is_active,
             created_at, created_by, updated_at, updated_by
        from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId} for update
    `)
    ).rows[0];
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
      updated = (
        await db.execute<TemplateRow>(sql`
        update hrm_process_templates
           set name = ${name},
               applies_to = ${JSON.stringify({ employer_subsidiary_id: appliesTo.employerSubsidiaryId, department_id: appliesTo.departmentId })}::jsonb,
               is_active = ${isActive}, updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${templateId}
        returning id, org_id, kind, name, applies_to, is_active,
                  created_at, created_by, updated_at, updated_by
      `)
      ).rows as TemplateRow[];
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
      (
        await db.execute<{ n: number }>(sql`
      select count(*)::int as n from hrm_process_template_steps where org_id = ${orgId} and template_id = ${templateId}
    `)
      ).rows[0]?.n ?? 0;
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
    const current = (
      await db.execute<TemplateRow>(sql`
      select id, org_id, kind, name, applies_to, is_active,
             created_at, created_by, updated_at, updated_by
        from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId} for update
    `)
    ).rows[0];
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
      (
        await db.execute<{ n: number }>(sql`
      select count(*)::int as n from hrm_processes where org_id = ${orgId} and template_id = ${templateId}
    `)
      ).rows[0]?.n ?? 0;
    const versions =
      (
        await db.execute<{ n: number }>(
          sql`select count(*)::int as n from hrm_process_template_versions where org_id=${orgId} and template_id=${templateId}`,
        )
      ).rows[0]?.n ?? 0;
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
    const deleted = (
      await db.execute(sql`
      delete from hrm_process_templates where org_id = ${orgId} and id = ${templateId} returning id
    `)
    ).rows;
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
    const template = (
      await db.execute<TemplateRow>(sql`
      select id, org_id, kind, name, applies_to, is_active,
             created_at, created_by, updated_at, updated_by
        from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId} for update
    `)
    ).rows[0];
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
        row = (
          await db.execute<TemplateStepRow>(sql`
          insert into hrm_process_template_steps
            (org_id, template_id, position, title, description, owner_kind, owner_party_id,
             due_offset_days, required, evidence_kind, created_by, updated_by)
          values (${orgId}, ${templateId}, ${position}, ${title}, ${description}, ${ownerKind}, ${ownerPartyId},
                  ${dueOffsetDays}, ${required}, ${evidenceKind}, ${actorId}, ${actorId})
          returning id, org_id, template_id, position, title, description, owner_kind, owner_party_id,
                    due_offset_days, required, evidence_kind
        `)
        ).rows[0];
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
        row = (
          await db.execute<TemplateStepRow>(sql`
          update hrm_process_template_steps
             set position = ${position}, title = ${title}, description = ${description},
                 owner_kind = ${ownerKind}, owner_party_id = ${ownerPartyId},
                 due_offset_days = ${dueOffsetDays}, required = ${required},
                 evidence_kind = ${evidenceKind}, updated_by = ${actorId}, updated_at = now()
           where org_id = ${orgId} and id = ${query.stepId} and template_id = ${templateId}
          returning id, org_id, template_id, position, title, description, owner_kind, owner_party_id,
                    due_offset_days, required, evidence_kind
        `)
        ).rows[0];
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
    const template = (
      await db.execute<{ id: string; applies_to: TemplateRow["applies_to"] }>(sql`
      select id, applies_to from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId} for update
    `)
    ).rows[0];
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
    const current = (
      await db.execute<{ id: string }>(sql`
      select id from hrm_process_template_steps where org_id = ${orgId} and template_id = ${templateId}
    `)
    ).rows.map((row) => row.id);
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
      const moved = (
        await db.execute(sql`
        update hrm_process_template_steps
           set position = ${-(index + 1)}, updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${wanted[index]} and template_id = ${templateId}
        returning id
      `)
      ).rows;
      if (moved.length !== 1) {
        throw new HrmProcessError(
          "REFUSED",
          "the reorder matched no rows mid-write — nothing reordered; reload the template and try again",
        );
      }
    }
    for (let index = 0; index < wanted.length; index += 1) {
      const moved = (
        await db.execute(sql`
        update hrm_process_template_steps
           set position = ${index}, updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${wanted[index]} and template_id = ${templateId}
        returning id
      `)
      ).rows;
      if (moved.length !== 1) {
        throw new HrmProcessError(
          "REFUSED",
          "the reorder matched no rows mid-write — nothing reordered; reload the template and try again",
        );
      }
    }
    const rows = (
      await db.execute<TemplateStepRow>(sql`
      select id, org_id, template_id, position, title, description, owner_kind, owner_party_id,
             due_offset_days, required, evidence_kind
        from hrm_process_template_steps
       where org_id = ${orgId} and template_id = ${templateId}
       order by position
    `)
    ).rows;
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
    const template = (
      await db.execute<{ id: string; applies_to: TemplateRow["applies_to"] }>(sql`
      select id, applies_to from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId} for update
    `)
    ).rows[0];
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
    const deleted = (
      await db.execute(sql`
      delete from hrm_process_template_steps
       where org_id = ${orgId} and id = ${stepId} and template_id = ${templateId}
      returning id
    `)
    ).rows;
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
  readonly progress: {
    total: number;
    required: number;
    doneRequired: number;
    allRequiredDone: boolean;
  };
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
  const identity = (
    await exec.execute<{ process_id: string }>(
      sql`select process_id from hrm_process_steps where org_id=${orgId} and id=${stepId}`,
    )
  ).rows[0];
  if (identity) await loadProcessForUpdate(exec, orgId, identity.process_id);
  const row = (
    await exec.execute<StepRow>(sql`
    select ${STEP_COLUMNS}
      from hrm_process_steps s
      join hrm_processes p on p.org_id = s.org_id and p.id = s.process_id
      join worker_employments e on e.org_id = s.org_id and e.id = p.employment_id
     where s.org_id = ${orgId} and s.id = ${stepId} for update of s
  `)
  ).rows[0];
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
  const row = (
    await exec.execute<ProcessRow>(sql`
    select id, org_id, template_id, employment_id, kind,
           effective_date::text as effective_date, status,
           opened_by_change_id, completed_at, cancelled_at, cancel_reason
      from hrm_processes
     where org_id = ${orgId} and id = ${processId} for update
  `)
  ).rows[0];
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
      const employer = (
        await exec.execute<{ employer_subsidiary_id: string }>(sql`
        select employer_subsidiary_id from worker_employments
         where org_id = ${orgId} and id = ${step.employment_id}
      `)
      ).rows[0];
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
  if (!isUuid(attachmentId)) {
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
  const readable = (
    await exec.execute<{ readable: boolean }>(sql`
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
  `)
  ).rows[0]?.readable;
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
  const stable = (
    await exec.execute<{ employer_subsidiary_id: string }>(sql`
    select employer_subsidiary_id from worker_employments
     where org_id = ${orgId} and id = ${employmentId}
  `)
  ).rows[0];
  if (!stable) {
    throw new HrmProcessError(
      "NOT_FOUND",
      "employment not found in this organization — check the employment id",
    );
  }
  const assignment = (
    await exec.execute<{ department_id: string | null }>(sql`
    select av.department_id::text as department_id
      from employment_assignment_versions av
     where av.org_id = ${orgId} and av.employment_id = ${employmentId}
       and av.recorded_until is null
       and av.effective_from <= ${effectiveDate}::date
       and (av.effective_to is null or av.effective_to > ${effectiveDate}::date)
     order by av.is_primary desc, av.version_no desc
     limit 1
  `)
  ).rows[0];
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
    await exec.execute(sql`
    select 1 as one from worker_employment_versions
     where org_id = ${orgId} and employment_id = ${employmentId}
       and recorded_until is null
       and effective_from <= ${effectiveDate}::date
       and (effective_to is null or effective_to > ${effectiveDate}::date)
     limit 1
  `)
  ).rows[0];
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
    const row = (
      await exec.execute<TemplateRow>(sql`
      select id, org_id, kind, name, applies_to, is_active,
             created_at, created_by, updated_at, updated_by
        from hrm_process_templates
       where org_id = ${orgId} and id = ${templateId}
    `)
    ).rows[0];
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
  const candidates = (
    await exec.execute<TemplateRow>(sql`
    select id, org_id, kind, name, applies_to, is_active,
           created_at, created_by, updated_at, updated_by
      from hrm_process_templates
     where org_id = ${orgId} and kind = ${kind} and is_active for share
  `)
  ).rows;
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

async function loadTemplateSteps(
  exec: SqlExecutor,
  orgId: string,
  templateId: string,
  includeRetired = false,
): Promise<TemplateStepRow[]> {
  return (
    await exec.execute<TemplateStepRow>(sql`
    select id, org_id, template_id, position, title, description, owner_kind, owner_party_id,
           due_offset_days, required, evidence_kind, design
      from hrm_process_template_steps
     where org_id = ${orgId} and template_id = ${templateId} ${includeRetired ? sql`` : sql`and is_current`}
     order by position
  `)
  ).rows;
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
  const employmentId = requireId(query.employmentId, "employmentId");
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
  const templateId =
    query.templateId === undefined ? null : requireId(query.templateId, "templateId");
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
export async function openProcessInTx(
  exec: SqlExecutor,
  args: OpenProcessInTx,
): Promise<ProcessDTO> {
  const { orgId, actorId, employmentId, kind, effectiveDate, templateId, openedByChangeId } = args;
  await assertLiveVersionOn(exec, orgId, employmentId, effectiveDate);
  const dupe = (
    await exec.execute(sql`
    select id from hrm_processes
     where org_id = ${orgId} and employment_id = ${employmentId}
       and kind = ${kind} and status = 'open'
     limit 1
  `)
  ).rows[0];
  if (dupe) {
    throw new HrmProcessError(
      "DUPLICATE_OPEN",
      `an open ${kind} process already exists for this employment — complete or cancel it before opening another`,
    );
  }
  let choice: { template: TemplateChoice; steps: TemplateStepRow[] };
  try {
    choice = await resolveTemplateChoice(
      exec,
      orgId,
      kind,
      employmentId,
      effectiveDate,
      templateId,
    );
  } catch (error) {
    if (error instanceof HrmProcessError) throw error;
    mathRefusal(error, "TEMPLATE_NOT_FOUND");
  }
  const context = await loadOpeningEmploymentContext(exec, orgId, employmentId, effectiveDate);
  const document = checklistDocumentSchema.parse({
    name: choice.template.name,
    kind,
    appliesTo: { employerSubsidiaryId: null, departmentId: null },
    steps: choice.steps.map((step) => ({
      id: step.id,
      title: step.title,
      description: step.description,
      ownerKind: step.owner_kind,
      ownerPartyId: step.owner_party_id,
      dueOffsetDays: step.due_offset_days,
      required: step.required,
      evidenceKind: step.evidence_kind,
      design: step.design ?? {},
    })),
  });
  let included;
  try {
    included = includedChecklistSteps(document, { ...context, kind });
  } catch (error) {
    throw new HrmProcessError(
      "REFUSED",
      error instanceof Error
        ? error.message
        : "Checklist conditions could not resolve — review the template.",
    );
  }
  choice.steps = choice.steps.filter((step) => included.some((item) => item.id === step.id));
  const publication = (
    await exec.execute<{ published_version: number }>(
      sql`select published_version from hrm_process_templates where org_id = ${orgId} and id = ${choice.template.id} for share`,
    )
  ).rows[0];
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
    const inserted = (
      await exec.execute<{ id: string }>(sql`
      insert into hrm_processes
        (org_id, template_id, employment_id, kind, effective_date, opened_by_change_id, created_by, updated_by, template_version)
      values (${orgId}, ${choice.template.id}, ${employmentId}, ${kind},
              ${effectiveDate}::date, ${openedByChangeId}, ${actorId}, ${actorId}, ${publication?.published_version ?? 0})
      returning id
    `)
    ).rows[0];
    if (!inserted) {
      throw new HrmProcessError(
        "REFUSED",
        "the process was not stored — nothing opened; retry the open",
      );
    }
    processId = inserted.id;
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HrmProcessError(
        "DUPLICATE_OPEN",
        `an open ${kind} process already exists for this employment — complete or cancel it before opening another`,
      );
    }
    throw error;
  }
  for (const snapshot of snapshots) {
    const stored = (
      await exec.execute(sql`
      insert into hrm_process_steps
        (org_id, process_id, template_step_id, position, title, description,
         owner_kind, owner_party_id, due_on, required, evidence_kind, created_by, updated_by, design)
      values (${orgId}, ${processId}, ${snapshot.templateStepId}, ${snapshot.position},
              ${snapshot.title}, ${snapshot.description}, ${snapshot.ownerKind},
              ${snapshot.ownerPartyId}, ${snapshot.dueOn}::date,
              ${snapshot.required}, ${snapshot.evidenceKind}, ${actorId}, ${actorId}, ${JSON.stringify(choice.steps.find((step) => step.id === snapshot.templateStepId)?.design ?? emptyStepDesign())}::jsonb)
      returning id
    `)
    ).rows;
    if (stored.length !== 1) {
      throw new HrmProcessError(
        "REFUSED",
        "a checklist step was not stored — nothing opened; retry the open",
      );
    }
  }
  const progress = await readProgress(exec, orgId, processId);
  await auditChecklist(
    exec,
    orgId,
    actorId,
    processId,
    "opened",
    null,
    {
      status: "open",
      templateId: choice.template.id,
      templateVersion: publication?.published_version ?? 0,
      employmentId,
      effectiveDate,
      openedByChangeId,
    },
    "Opened a checklist from its template snapshot.",
    "hrm_processes",
  );
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
  const rows = (
    await exec.execute<{ required: boolean; status: string }>(sql`
    select required, status from hrm_process_steps
     where org_id = ${orgId} and process_id = ${processId}
  `)
  ).rows;
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
  readonly acknowledged?: boolean;
  readonly response?: Record<string, unknown>;
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
  const stepId = requireId(query.stepId, "stepId");
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await lockFlowSubjectDecision(orgId, CHECKLIST_STEP_SUBJECT_KIND, stepId);
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
    const reviewed = (
      await db.execute<{
        design: unknown;
        approval_status: string;
        response: Record<string, unknown> | null;
        attachment_id: string | null;
      }>(
        sql`select design,approval_status,response,attachment_id from hrm_process_steps where org_id=${orgId} and id=${stepId}`,
      )
    ).rows[0];
    const design = checklistStepDesignSchema.parse(reviewed?.design ?? {});
    if (design.form && query.response)
      query = { ...query, response: withComputedFormulas(design.form.sections, query.response) };
    if (design.approval && reviewed?.approval_status === "approved") {
      const matches = (
        await db.execute<{ matches: boolean }>(
          sql`select response is not distinct from ${JSON.stringify(query.response ?? null)}::jsonb and attachment_id is not distinct from ${query.attachmentId ?? null}::uuid as matches from hrm_process_steps where org_id=${orgId} and id=${stepId}`,
        )
      ).rows[0]?.matches;
      if (!matches)
        throw new HrmProcessError(
          "REFUSED",
          "The completion evidence differs from the approved submission — use the reviewed response and attachment.",
        );
    }
    await validateDesignedCompletion(db, orgId, actorId, step, query);
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
    const done = (
      await db.execute(sql`
      update hrm_process_steps
         set status = 'done', done_by = ${actorId}, done_at = now(),
             attachment_id = ${attachmentId}, response = ${JSON.stringify(query.response ?? null)}::jsonb, updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${stepId} and status = 'pending'
      returning id
    `)
    ).rows;
    if (done.length !== 1) {
      throw new HrmProcessError(
        "REFUSED",
        "the step changed while completing — nothing completed; reload the checklist and try again",
      );
    }
    await auditChecklist(
      db,
      orgId,
      actorId,
      step.process_id,
      "step_completed",
      {
        stepId,
        status: "pending",
        response: reviewed?.response ?? null,
        attachmentId: reviewed?.attachment_id ?? null,
      },
      { stepId, status: "done", response: query.response ?? null, attachmentId },
      "Completed checklist evidence.",
      "hrm_processes",
    );
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
  const stepId = requireId(query.stepId, "stepId");
  const reason = requireNonBlank("reason", query.reason);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await lockFlowSubjectDecision(orgId, CHECKLIST_STEP_SUBJECT_KIND, stepId);
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
    const waitingRuns = (
      await db.execute<{ id: string }>(
        sql`select id from flow_runs where org_id=${orgId} and subject_kind=${CHECKLIST_STEP_SUBJECT_KIND} and subject_id=${stepId} and status in ('running','waiting')`,
      )
    ).rows;
    await cancelDispatchRuns(
      orgId,
      waitingRuns.map((r) => r.id),
      { actorId },
    );
    const skipped = (
      await db.execute(sql`
      update hrm_process_steps
         set status = 'skipped', skip_reason = ${reason},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${stepId} and status = 'pending'
      returning id
    `)
    ).rows;
    if (skipped.length !== 1) {
      throw new HrmProcessError(
        "REFUSED",
        "the step changed while skipping — nothing skipped; reload the checklist and try again",
      );
    }
    await auditChecklist(
      db,
      orgId,
      actorId,
      step.process_id,
      "step_skipped",
      { stepId, status: "pending" },
      { stepId, status: "skipped", skipReason: reason },
      reason,
      "hrm_processes",
    );
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
  const processId = requireId(query.processId, "processId");
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
    const pending = (
      await db.execute<{ title: string }>(sql`
      select title from hrm_process_steps
       where org_id = ${orgId} and process_id = ${processId}
         and required and status = 'pending'
       order by position
    `)
    ).rows;
    if (pending.length > 0) {
      const names = pending
        .slice(0, 3)
        .map((row) => JSON.stringify(row.title))
        .join(", ");
      const more = pending.length > 3 ? ` and ${pending.length - 3} more` : "";
      throw new HrmProcessError(
        "REFUSED",
        `${pending.length} required step(s) still pending (${names}${more}) — complete or skip them before completing the process`,
      );
    }
    const completed = (
      await db.execute(sql`
      update hrm_processes
         set status = 'completed', completed_at = now(),
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${processId} and status = 'open'
      returning id
    `)
    ).rows;
    if (completed.length !== 1) {
      throw new HrmProcessError(
        "REFUSED",
        "the process left the open state while completing — nothing completed; reload it and try again",
      );
    }
    await auditChecklist(
      db,
      orgId,
      actorId,
      processId,
      "completed",
      { status: "open" },
      { status: "completed" },
      "All required checklist work was completed or explicitly skipped.",
      "hrm_processes",
    );
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
  const processId = requireId(query.processId, "processId");
  const reason = requireNonBlank("reason", query.reason);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    const stepIds = (
      await db.execute<{ id: string }>(
        sql`select id from hrm_process_steps where org_id=${orgId} and process_id=${processId} order by id`,
      )
    ).rows;
    for (const step of stepIds)
      await lockFlowSubjectDecision(orgId, CHECKLIST_STEP_SUBJECT_KIND, step.id);
    const process = await loadProcessForUpdate(db, orgId, processId);
    if (process.status !== "open") {
      throw new HrmProcessError(
        "BAD_STATE",
        `the process is already ${process.status} — ${process.status} checklists stay as recorded`,
      );
    }
    await requireHrmProcessManage(db, orgId, actorId, process.employment_id);
    const runs = (
      await db.execute<{ id: string }>(
        sql`select id from flow_runs where org_id=${orgId} and subject_kind=${CHECKLIST_STEP_SUBJECT_KIND} and subject_id in (select id from hrm_process_steps where org_id=${orgId} and process_id=${processId}) and status in ('running','waiting')`,
      )
    ).rows;
    await cancelDispatchRuns(
      orgId,
      runs.map((r) => r.id),
      { actorId },
    );
    const cancelled = (
      await db.execute(sql`
      update hrm_processes
         set status = 'cancelled', cancelled_at = now(), cancel_reason = ${reason},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${processId} and status = 'open'
      returning id
    `)
    ).rows;
    if (cancelled.length !== 1) {
      throw new HrmProcessError(
        "REFUSED",
        "the process left the open state while cancelling — nothing cancelled; reload it and try again",
      );
    }
    await auditChecklist(
      db,
      orgId,
      actorId,
      processId,
      "cancelled",
      { status: "open" },
      { status: "cancelled" },
      reason,
      "hrm_processes",
    );
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
  | {
      readonly kind: "assignment_change";
      readonly departmentChanged: boolean;
      readonly windowStart: string;
    };

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
      return input.departmentChanged
        ? { trigger: "transfer", effectiveDate: input.windowStart }
        : null;
  }
}

/**
 * Open the checklist an approved employment change owes, on the change
 * request's own transaction runner: hire → onboarding, termination →
 * offboarding, department change → transfer. No separate authority check:
 * the approved decision IS the authority, and the open runs inside the
 * apply transaction. Missing coverage and an existing open checklist are
 * optional side effects; every other refusal rolls the employment change back.
 *
 * The HRM feature switch governs automatic opening. With HRM enabled, an
 * applicable template opens a checklist; absent coverage leaves the approved
 * employment change usable without creating unconfigured work.
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
    if (
      error instanceof HrmProcessError &&
      (error.code === "TEMPLATE_NOT_FOUND" || error.code === "DUPLICATE_OPEN")
    ) {
      return null;
    }
    throw error;
  }
}

export interface ChecklistDesignerValue {
  id: string;
  revision: number;
  publishedVersion: number;
  publishedRevision?: number;
  isActive: boolean;
  document: ChecklistDocument;
  versions?: { version: number; publishedAt: string; publishedBy: string; reason: string }[];
}

async function auditChecklist(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  id: string,
  event: string,
  before: unknown,
  after: unknown,
  reason: string,
  tableName = "hrm_process_templates",
) {
  await exec.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${tableName}, ${id}, 'update', ${JSON.stringify({ event, before, after, reason, actor: { kind: "user", userId: actorId } })}::jsonb, ${actorId})`);
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
      }>(sql`
      select draft_document, draft_revision, published_version, published_revision, is_active from hrm_process_templates where org_id = ${query.orgId} and id = ${detail.id}`)
    ).rows[0];
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
    const versions = (
      await db.execute<{
        version: number;
        publishedAt: string;
        publishedBy: string;
        reason: string;
      }>(
        sql`select v.version,v.published_at::text as "publishedAt",u.name as "publishedBy",v.reason from hrm_process_template_versions v join users u on u.org_id=v.org_id and u.id=v.published_by where v.org_id=${query.orgId} and v.template_id=${detail.id} order by v.version desc limit 50`,
      )
    ).rows;
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
      }>(sql`
      select applies_to, kind, draft_revision, draft_document, published_version, published_revision, is_active from hrm_process_templates where org_id = ${orgId} and id = ${id} for update`)
    ).rows[0];
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
            )
          ).rows[0]?.matches
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
    const duplicateName = (
      await db.execute(
        sql`select id from hrm_process_templates where org_id=${orgId} and kind=${document.kind} and id<>${id} and (name=${document.name.trim()} or draft_document->>'name'=${document.name.trim()}) limit 1`,
      )
    ).rows;
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
      ? (
          await db.execute(
            sql`update hrm_process_templates set draft_document = ${JSON.stringify(document)}::jsonb, draft_revision = ${revision}, designer_managed = true, updated_by = ${actorId}, updated_at = now() where org_id = ${orgId} and id = ${id} and draft_revision = ${query.revision} returning id`,
          )
        ).rows
      : (
          await db.execute(sql`insert into hrm_process_templates(id,org_id,kind,name,applies_to,is_active,designer_managed,draft_document,draft_revision,created_by,updated_by)
          values(${id},${orgId},${document.kind},${document.name.trim()},${JSON.stringify({ employer_subsidiary_id: document.appliesTo.employerSubsidiaryId, department_id: document.appliesTo.departmentId })}::jsonb,false,true,${JSON.stringify(document)}::jsonb,${revision},${actorId},${actorId}) returning id`)
        ).rows;
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

async function refuseLegacyDesignerEdit(
  exec: SqlExecutor,
  orgId: string,
  templateId: string,
): Promise<void> {
  const row = (
    await exec.execute<{ designer_managed: boolean }>(
      sql`select designer_managed from hrm_process_templates where org_id=${orgId} and id=${templateId}`,
    )
  ).rows[0];
  if (row?.designer_managed)
    throw new HrmProcessError(
      "REFUSED",
      "Open this template in HRM Checklist templates to edit and publish its whole draft, or use Retire template there.",
    );
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
    const updated = (
      await db.execute(
        sql`update hrm_process_templates set is_active=false,updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${id} and is_active returning id`,
      )
    ).rows;
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
      )
    ).rows[0];
    if (
      marker?.published_revision === query.revision &&
      locked.publishedVersion > 0 &&
      locked.isActive
    )
      return locked;
    const document = locked.document,
      issues = checklistIssues(document);
    const foreignIdentities = (
      await db.execute(
        sql`select id from hrm_process_template_steps where id in(select value::uuid from jsonb_array_elements_text(${JSON.stringify(document.steps.map((s) => s.id))}::jsonb) as ids(value)) and (org_id<>${orgId} or template_id<>${id}) limit 1`,
      )
    ).rows;
    if (foreignIdentities.length)
      throw new HrmProcessError(
        "REFUSED",
        "A step identity belongs to another template — duplicate the step in this designer to give it a new identity.",
      );
    if (issues.length) throw new HrmProcessError("REFUSED", issues.map((i) => i.message).join(" "));
    await db.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${orgId + ":checklist-name:" + document.kind + ":" + document.name.trim()},0))`,
    );
    const duplicateName = (
      await db.execute(
        sql`select id from hrm_process_templates where org_id=${orgId} and kind=${document.kind} and id<>${id} and (name=${document.name.trim()} or draft_document->>'name'=${document.name.trim()}) limit 1`,
      )
    ).rows;
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
      if (step.design.approval) {
        const policy = (
          await db.execute(
            sql`select id from flows where org_id = ${orgId} and subject_kind = ${CHECKLIST_STEP_SUBJECT_KIND} and enabled limit 1`,
          )
        ).rows[0];
        if (!policy)
          throw new HrmProcessError(
            "REFUSED",
            `Step "${step.title}" requires approval — configure an enabled HRM checklist step policy in Flows before publishing.`,
          );
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
        ? (
            await db.execute(
              sql`update hrm_process_template_steps set is_current=true,position=${position},title=${step.title.trim()},description=${step.description},owner_kind=${step.ownerKind},owner_party_id=${step.ownerPartyId},due_offset_days=${step.dueOffsetDays},required=${step.required},evidence_kind=${step.evidenceKind},design=${design}::jsonb,updated_by=${actorId},updated_at=now() where org_id=${orgId} and template_id=${id} and id=${step.id} returning id`,
            )
          ).rows
        : (
            await db.execute(
              sql`insert into hrm_process_template_steps(id,org_id,template_id,position,title,description,owner_kind,owner_party_id,due_offset_days,required,evidence_kind,design,created_by,updated_by) values(${step.id},${orgId},${id},${position},${step.title.trim()},${step.description},${step.ownerKind},${step.ownerPartyId},${step.dueOffsetDays},${step.required},${step.evidenceKind},${design}::jsonb,${actorId},${actorId}) returning id`,
            )
          ).rows;
      if (rows.length !== 1)
        throw new HrmProcessError(
          "REFUSED",
          "A checklist step was not published — retry after reloading the draft.",
        );
    }
    // Keep the source identity of every historical execution step. Removed
    // definitions are excluded from future snapshots, never detached from history.
    for (const old of currentSteps.filter((s) => !document.steps.some((n) => n.id === s.id))) {
      const removed = (
        await db.execute(
          sql`update hrm_process_template_steps set is_current=false,updated_by=${actorId},updated_at=now() where org_id=${orgId} and template_id=${id} and id=${old.id} returning id`,
        )
      ).rows;
      if (removed.length !== 1)
        throw new HrmProcessError(
          "REFUSED",
          "A removed step changed during publication — reload and retry.",
        );
    }
    const version = locked.publishedVersion + 1;
    const stored = (
      await db.execute(
        sql`insert into hrm_process_template_versions(org_id,template_id,version,document,published_by,reason) values(${orgId},${id},${version},${JSON.stringify(document)}::jsonb,${actorId},${reason}) returning id`,
      )
    ).rows;
    if (stored.length !== 1)
      throw new HrmProcessError(
        "REFUSED",
        "Publication evidence was not stored — nothing was published.",
      );
    const updated = (
      await db.execute(
        sql`update hrm_process_templates set name=${document.name.trim()},applies_to=${JSON.stringify({ employer_subsidiary_id: scope.employerSubsidiaryId, department_id: scope.departmentId })}::jsonb,is_active=true,designer_managed=true,published_version=${version},published_revision=${query.revision},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${id} returning id`,
      )
    ).rows;
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

async function validateDesignedCompletion(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  step: StepRow,
  query: CompleteStepQuery,
  submitting = false,
) {
  const row = (
    await exec.execute<{ design: unknown; approval_status: string }>(
      sql`select design,approval_status from hrm_process_steps where org_id=${orgId} and id=${step.id}`,
    )
  ).rows[0];
  if (!row)
    throw new HrmProcessError(
      "NOT_FOUND",
      "Checklist step is no longer visible — reload the checklist.",
    );
  const design = checklistStepDesignSchema.parse(row.design ?? {});
  const pending = (
    await exec.execute<{ title: string }>(
      sql`select title from hrm_process_steps where org_id=${orgId} and process_id=${step.process_id} and template_step_id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(design.dependencies)}::jsonb) as deps(value)) and status='pending' order by position`,
    )
  ).rows;
  const dependencyCount = (
    await exec.execute<{ count: number }>(
      sql`select count(*)::int as count from hrm_process_steps where org_id=${orgId} and process_id=${step.process_id} and template_step_id in(select value::uuid from jsonb_array_elements_text(${JSON.stringify(design.dependencies)}::jsonb) as ids(value))`,
    )
  ).rows[0]?.count;
  if (dependencyCount !== design.dependencies.length)
    throw new HrmProcessError(
      "REFUSED",
      "A prerequisite is missing from this checklist — ask HR to cancel it and open a corrected checklist from a published template.",
    );
  if (pending.length)
    throw new HrmProcessError(
      "REFUSED",
      `Complete prerequisite steps first: ${pending.map((s) => s.title).join(", ")}.`,
    );
  if (
    step.evidence_kind === "acknowledgement" &&
    Object.keys((row.design ?? {}) as object).length &&
    query.acknowledged !== true
  )
    throw new HrmProcessError(
      "EVIDENCE_REQUIRED",
      "Confirm that you reviewed these instructions before completing this step.",
    );
  if (design.form) {
    const computed = withComputedFormulas(design.form.sections, query.response ?? {});
    const { values, rows } = splitRecordData(design.form.sections, computed);
    const errors = validateResponse(design.form, values, rows);
    for (const section of design.form.sections)
      for (const field of section.fields) {
        if (field.type !== "party" && field.type !== "gl_account") continue;
        const sources = section.repeating ? (rows[section.id] ?? []) : [values];
        for (const source of sources) {
          const value = source[field.id];
          if (value === null || value === undefined || value === "") continue;
          if (typeof value !== "string" || !isUuid(value))
            throw new HrmProcessError(
              "EVIDENCE_REQUIRED",
              `Choose a valid reference for ${field.label} from its picker.`,
            );
          const target = (
            await exec.execute(
              sql`select id from ${sql.identifier(field.type === "party" ? "parties" : "accounts")} where org_id=${orgId} and id=${value} and is_active`,
            )
          ).rows[0];
          if (!target)
            throw new HrmProcessError(
              "EVIDENCE_REQUIRED",
              `${field.label} is not available in this organization — choose an active reference from its picker.`,
            );
        }
      }
    if (errors.length)
      throw new HrmProcessError(
        "EVIDENCE_REQUIRED",
        `Complete the form: ${errors.map((e) => `${design.form!.sections.flatMap((s) => s.fields).find((f) => f.id === e.fieldId)?.label ?? e.fieldId}: ${e.message}`).join(" ")}.`,
      );
  } else if (query.response && Object.keys(query.response).length)
    throw new HrmProcessError(
      "REFUSED",
      "This step does not collect a form response — remove the response before completing it.",
    );
  if (!submitting && design.approval && row.approval_status !== "approved")
    throw new HrmProcessError(
      "REFUSED",
      "This step requires approval — submit it for review and wait for the configured approvers before completing it.",
    );
}

export async function submitChecklistStepApproval(query: CompleteStepQuery): Promise<void> {
  const orgId = requireOrgId(query.orgId),
    actorId = requireActorId(query.actorId),
    id = requireId(query.stepId, "stepId");
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeatureOn(db, orgId);
    await lockFlowSubjectDecision(orgId, CHECKLIST_STEP_SUBJECT_KIND, id);
    const step = await loadStepForUpdate(db, orgId, id);
    if ((await resolveStepActor(db, orgId, actorId, step)) === "stranger")
      throw new HrmProcessError(
        "FORBIDDEN",
        "Submit only your own checklist step, or ask a scoped HR manager to submit it.",
      );
    if (step.process_status !== "open" || step.status !== "pending")
      throw new HrmProcessError(
        "BAD_STATE",
        "Only a pending step on an open checklist can be submitted.",
      );
    const row = (
      await db.execute<{
        design: unknown;
        approval_status: string;
        response: unknown;
        attachment_id: string | null;
      }>(
        sql`select design,approval_status,response,attachment_id from hrm_process_steps where org_id=${orgId} and id=${id}`,
      )
    ).rows[0];
    if (!row)
      throw new HrmProcessError("NOT_FOUND", "Checklist step not found — reload the checklist.");
    const design = checklistStepDesignSchema.parse(row.design);
    if (!design.approval)
      throw new HrmProcessError(
        "REFUSED",
        "This step does not require approval — complete it through its checklist action.",
      );
    if (row.approval_status === "pending" || row.approval_status === "approved")
      throw new HrmProcessError(
        "BAD_STATE",
        "This evidence has already been submitted — review its approval state before taking another action.",
      );
    if (design.form && query.response)
      query = { ...query, response: withComputedFormulas(design.form.sections, query.response) };
    // Validate the same evidence as completion, withholding only the approval check.
    await validateDesignedCompletion(db, orgId, actorId, step, { ...query }, true);
    if (query.attachmentId && step.evidence_kind !== "attachment")
      throw new HrmProcessError(
        "REFUSED",
        "This step does not collect a file — remove the attachment before submitting it.",
      );
    if (step.evidence_kind === "attachment") {
      if (!query.attachmentId)
        throw new HrmProcessError(
          "EVIDENCE_REQUIRED",
          "Attach the supporting file before submitting this step for approval.",
        );
      await assertAttachmentReadable(db, orgId, actorId, query.attachmentId);
    }
    const prepared = (
      await db.execute(
        sql`update hrm_process_steps set submitted_by=${actorId},submitted_at=now(),response=${JSON.stringify(query.response ?? null)}::jsonb,attachment_id=${query.attachmentId ?? null},approval_status='pending',updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${id} and status='pending' returning id`,
      )
    ).rows;
    if (prepared.length !== 1)
      throw new HrmProcessError(
        "REFUSED",
        "The step changed during submission — reload and retry.",
      );
    const attempt = (
      await db.execute<{ submitted_at: string }>(
        sql`select submitted_at::text from hrm_process_steps where org_id=${orgId} and id=${id}`,
      )
    ).rows[0];
    const result = await runRecordFlows(
      {
        kind: "on_submit",
        source: "ui",
        occurrenceKey: `checklist-step:${id}:${attempt?.submitted_at}`,
      },
      CHECKLIST_STEP_SUBJECT_KIND,
      id,
      { orgId, userId: actorId },
    );
    if (result.failed)
      throw new HrmProcessError(
        "REFUSED",
        `Checklist approval could not start: ${dispatchFailureReason(result)}. Correct the policy in Flows and submit again.`,
      );
    const gated = result.runs.find((r) => r.gatesCreated > 0);
    if (!gated)
      throw new HrmProcessError(
        "REFUSED",
        "No approval policy matched this step — configure HRM checklist step approvals in Flows, then submit again.",
      );
    const stored = (
      await db.execute(
        sql`update hrm_process_steps set flow_run_id=${gated.runId} where org_id=${orgId} and id=${id} and approval_status='pending' returning id`,
      )
    ).rows;
    if (stored.length !== 1)
      throw new HrmProcessError(
        "REFUSED",
        "Approval evidence was not stored — nothing was submitted.",
      );
    await auditChecklist(
      db,
      orgId,
      actorId,
      step.process_id,
      "step_submitted",
      {
        stepId: id,
        approvalStatus: row.approval_status,
        response: row.response,
        attachmentId: row.attachment_id,
      },
      {
        stepId: id,
        runId: gated.runId,
        approvalStatus: "pending",
        response: query.response ?? null,
        attachmentId: query.attachmentId ?? null,
      },
      "Submitted checklist evidence for native workflow approval.",
      "hrm_processes",
    );
  });
}

export async function releaseChecklistStepApproval(args: {
  approvalRunId?: string;
  subjectId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
  ctx: { orgId: string; userId?: string | null };
}): Promise<void> {
  const { orgId, userId } = args.ctx,
    actorId = requireActorId(userId);
  await assertHrmFeatureOn(db, orgId);
  const step = await loadStepForUpdate(db, orgId, args.subjectId);
  await requireHrmProcessManage(db, orgId, actorId, step.employment_id);
  const row = (
    await db.execute<{ approval_status: string; submitted_by: string; flow_run_id: string | null }>(
      sql`select approval_status,submitted_by,flow_run_id from hrm_process_steps where org_id=${orgId} and id=${step.id}`,
    )
  ).rows[0];
  if (row?.approval_status !== "pending") return;
  if (step.process_status !== "open" || step.status !== "pending")
    throw new HrmProcessError(
      "BAD_STATE",
      "This checklist no longer accepts approval decisions — cancel the outstanding gate through its workflow controls.",
    );
  if (row.submitted_by === actorId && !(row.flow_run_id === args.approvalRunId &&
    await completedGateAllowsSelfApproval(db, {
      orgId, subjectKind: CHECKLIST_STEP_SUBJECT_KIND, subjectId: step.id,
      approvalRunId: args.approvalRunId, actorId, outcome: args.outcome,
    })))
    throw new HrmProcessError(
      "FORBIDDEN",
      "The submitted Flow policy requires another authorized approver for this checklist evidence.",
    );
  const changed = (
    await db.execute(
      sql`update hrm_process_steps set approval_status=${args.outcome},updated_by=${actorId},updated_at=now() where org_id=${orgId} and id=${step.id} and approval_status='pending' returning id`,
    )
  ).rows;
  if (changed.length !== 1)
    throw new HrmProcessError(
      "REFUSED",
      "The approval state changed — reload the worklist before deciding.",
    );
  await auditChecklist(
    db,
    orgId,
    actorId,
    step.process_id,
    "step_" + args.outcome,
    { approvalStatus: "pending" },
    { stepId: step.id, approvalStatus: args.outcome, approvalRunId: args.approvalRunId ?? null },
    args.comment?.trim() || "Native checklist approval decision.",
    "hrm_processes",
  );
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
    const candidates = (
      await db.execute<{ id: string; process_id: string }>(
        sql`select s.id,s.process_id from hrm_process_steps s join hrm_processes p on p.org_id=s.org_id and p.id=s.process_id where s.org_id=${orgId} and p.status='open' and s.status='pending' and s.design->>'reminderDays' is not null and s.due_on + (s.design->>'reminderDays')::int <= ${today}::date and (s.reminder_sent_on is null or s.reminder_sent_on<${today}::date) order by s.process_id,s.id limit 100`,
      )
    ).rows;
    const users = (
      await db.execute<{ id: string }>(
        sql`select id from users where org_id=${orgId} and is_active order by id`,
      )
    ).rows;
    let sent = 0;
    for (const candidate of candidates) {
      const process = await loadProcessForUpdate(db, orgId, candidate.process_id);
      if (process.status !== "open") continue;
      const step = await loadStepForUpdate(db, orgId, candidate.id);
      if (step.status !== "pending") continue;
      const current = (
        await db.execute<{ sent: boolean }>(
          sql`select reminder_sent_on>=${today}::date as sent from hrm_process_steps where org_id=${orgId} and id=${step.id}`,
        )
      ).rows[0];
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
        const notification = (
          await db.execute(
            sql`insert into notifications(org_id,user_id,kind,title,body,href) values(${orgId},${userId},'hrm_checklist',${`Checklist step due: ${step.title}`},${`This ${step.process_kind} checklist step was due ${step.due_on}. Open the task to review its instructions and complete the outstanding work.`},${href}) returning id`,
          )
        ).rows;
        if (notification.length !== 1)
          throw new HrmProcessError(
            "REFUSED",
            "The checklist reminder was not stored — the next automation tick will retry it.",
          );
      }
      const changed = (
        await db.execute(
          sql`update hrm_process_steps set reminder_sent_on=${today}::date where org_id=${orgId} and id=${step.id} and (reminder_sent_on is null or reminder_sent_on<${today}::date) returning id`,
        )
      ).rows;
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
      )
    ).rows[0];
    if (!row)
      throw new HrmProcessError(
        "NOT_FOUND",
        "This published version is no longer visible — reload the checklist history.",
      );
    return checklistDocumentSchema.parse(row.document);
  });
}
