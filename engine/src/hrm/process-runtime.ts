/** Opened-process and step rows, step-actor resolution and checklist audit. */
import { sql } from "drizzle-orm";
import { type SqlExecutor } from "../platform/db.ts";
import { actorHasPermission, actorIdentity } from "../organization/actor-permissions.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { loadApprovalPerson } from "./authorization.ts";
import { isUuid } from "../platform/uuid.ts";
import { HrmProcessError, type ProcessKind } from "./process-core.ts";

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

export type StepRow = {
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

export async function loadStepForUpdate(
  exec: SqlExecutor,
  orgId: string,
  stepId: string,
): Promise<StepRow> {
  const identity = (await exec.execute<{ process_id: string }>(
      sql`select process_id from hrm_process_steps where org_id=${orgId} and id=${stepId}`, "objects",
    ))[0];
  if (identity) await loadProcessForUpdate(exec, orgId, identity.process_id);
  const row = (await exec.execute<StepRow>(sql`
    select ${STEP_COLUMNS}
      from hrm_process_steps s
      join hrm_processes p on p.org_id = s.org_id and p.id = s.process_id
      join worker_employments e on e.org_id = s.org_id and e.id = p.employment_id
     where s.org_id = ${orgId} and s.id = ${stepId} for update of s
  `, "objects"))[0];
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

export async function loadProcessForUpdate(
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
  `, "objects"))[0];
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
      `, "objects"))[0];
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
export async function assertAttachmentReadable(
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
  const canReadApCapture = await actorHasPermission(exec, orgId, actorId, "ap.read");
  const readable = (await exec.execute<{ readable: boolean }>(sql`
    with recursive capture_folders as (
      select id from folders where org_id = ${orgId} and system_kind = 'ap_capture'
      union
      select f.id from folders f join capture_folders c on f.parent_folder_id = c.id
       where f.org_id = ${orgId}
    ), hidden_folders as (
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
         and (${canReadApCapture} or not exists(select 1 from capture_folders c where c.id = f.folder_id))
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
  `, "objects"))[0]?.readable;
  if (!readable) {
    throw new HrmProcessError(
      "UNREADABLE_ATTACHMENT",
      "that file is not readable by this actor — attach a file from a shared folder, or ask its owner to share it",
    );
  }
}

export async function auditChecklist(
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
