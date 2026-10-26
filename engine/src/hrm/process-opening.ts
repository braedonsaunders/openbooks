/** Opening HR processes directly, in a caller's transaction, and from approved changes. */
import {
  checklistDocumentSchema,
  includedChecklistSteps,
  emptyStepDesign,
} from "@openbooks/forms-core";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { requireHrmProcessManage } from "./authorization.ts";
import { HRM_FEATURE_KEY } from "./employment-read.ts";
import { snapshotTemplateSteps, summarizeProgress } from "./process-math.ts";
import { parseCivilDate } from "./temporal.ts";
import { isUniqueViolation } from "./field-time/errors.ts";
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
import { type ProcessDTO, auditChecklist } from "./process-runtime.ts";
import {
  type TemplateStepRow,
  loadOpeningEmploymentContext,
  assertLiveVersionOn,
  type TemplateChoice,
  resolveTemplateChoice,
} from "./process-templates.ts";

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
    await exec.execute(
      sql`
    select id from hrm_processes
     where org_id = ${orgId} and employment_id = ${employmentId}
       and kind = ${kind} and status = 'open'
     limit 1
  `,
      "objects",
    )
  )[0];
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
      "objects",
    )
  )[0];
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
      await exec.execute<{ id: string }>(
        sql`
      insert into hrm_processes
        (org_id, template_id, employment_id, kind, effective_date, opened_by_change_id, created_by, updated_by, template_version)
      values (${orgId}, ${choice.template.id}, ${employmentId}, ${kind},
              ${effectiveDate}::date, ${openedByChangeId}, ${actorId}, ${actorId}, ${publication?.published_version ?? 0})
      returning id
    `,
        "objects",
      )
    )[0];
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
    const stored = await exec.execute(
      sql`
      insert into hrm_process_steps
        (org_id, process_id, template_step_id, position, title, description,
         owner_kind, owner_party_id, due_on, required, evidence_kind, created_by, updated_by, design)
      values (${orgId}, ${processId}, ${snapshot.templateStepId}, ${snapshot.position},
              ${snapshot.title}, ${snapshot.description}, ${snapshot.ownerKind},
              ${snapshot.ownerPartyId}, ${snapshot.dueOn}::date,
              ${snapshot.required}, ${snapshot.evidenceKind}, ${actorId}, ${actorId}, ${JSON.stringify(choice.steps.find((step) => step.id === snapshot.templateStepId)?.design ?? emptyStepDesign())}::jsonb)
      returning id
    `,
      "objects",
    );
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
  const rows = await exec.execute<{ required: boolean; status: string }>(
    sql`
    select required, status from hrm_process_steps
     where org_id = ${orgId} and process_id = ${processId}
  `,
    "objects",
  );
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
