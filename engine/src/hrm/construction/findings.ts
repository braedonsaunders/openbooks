import { sql } from "drizzle-orm";
import { HrmConstructionError } from "./errors.ts";
import { requireHrmConstructionManage, requireHrmConstructionRead } from "../authorization.ts";
import {
  HRM_CONSTRUCTION_FEATURE,
  assertConstructionFeature,
  requireDate,
  requireId,
  requireText,
  type SqlExecutor,
} from "./shared.ts";

/**
 * Compliance findings (HR-13, migration 0224): append-only pre-run flags
 * also read by HR-21. A breach writes a finding AND takes its priced
 * effect (journey pricing, unresolved split) — both visible, neither
 * silent. Recording dedupes on an identical OPEN finding (same kind,
 * project, day, employment): the generator may re-run a week, and a
 * second identical flag is noise, not evidence. Status moves carry their
 * reason; deletes are refused by storage outside the governed amend path.
 */

export type ComplianceFindingKind =
  | "ratio_breach"
  | "missing_rate"
  | "class_unresolved"
  | "registration_missing"
  | "fringe_mismatch";

export interface ComplianceFinding {
  readonly id: string;
  readonly kind: ComplianceFindingKind;
  readonly projectId: string | null;
  readonly workedOn: string | null;
  readonly employmentId: string | null;
  readonly detail: Record<string, unknown>;
  readonly status: string;
  readonly recordedAt: string;
}

export interface RecordFindingInput {
  readonly orgId: string;
  readonly actorId: string;
  readonly kind: ComplianceFindingKind;
  readonly projectId?: string | null;
  readonly workedOn?: string | null;
  readonly employmentId?: string | null;
  readonly detail?: Record<string, unknown>;
}

const KINDS: readonly ComplianceFindingKind[] = [
  "ratio_breach",
  "missing_rate",
  "class_unresolved",
  "registration_missing",
  "fringe_mismatch",
];

export async function recordFinding(
  exec: SqlExecutor,
  input: RecordFindingInput,
): Promise<ComplianceFinding> {
  const orgId = requireId(input.orgId, "orgId");
  requireId(input.actorId, "actorId");
  if (!KINDS.includes(input.kind)) {
    throw new HrmConstructionError(
      `Unknown compliance finding kind ${input.kind} — use one of ${KINDS.join(", ")}.`,
    );
  }
  await assertConstructionFeature(exec, orgId, HRM_CONSTRUCTION_FEATURE, "Compliance findings");
  // No grant gate: findings are evidence written as a side effect of
  // resolution (including the approval-time prevailing-wage hook, whose
  // approver may hold no construction grant). Transitions below gate.
  const projectId = input.projectId ?? null;
  const workedOn = input.workedOn ? requireDate(input.workedOn, "workedOn") : null;
  const employmentId = input.employmentId ?? null;
  const detail = input.detail ?? {};
  if (typeof detail !== "object" || Array.isArray(detail)) {
    throw new HrmConstructionError("Finding detail must be a JSON object.");
  }
  // An identical open finding is the same flag — return it instead of a duplicate row.
  const existing = (
    await exec.execute<{ id: string }>(sql`
      select id from hrm_compliance_findings
       where org_id = ${orgId}::uuid and kind = ${input.kind}
         and project_id is not distinct from ${projectId}::uuid
         and worked_on is not distinct from ${workedOn}::date
         and employment_id is not distinct from ${employmentId}::uuid
         and status = 'open'
       order by recorded_at desc limit 1
    `)
  ).rows[0];
  if (existing) {
    return loadFinding(exec, orgId, String(existing.id));
  }
  const created = (
    await exec.execute<{ id: string }>(sql`
      insert into hrm_compliance_findings
        (org_id, kind, project_id, worked_on, employment_id, detail, status, created_by, updated_by)
      values (${orgId}::uuid, ${input.kind}, ${projectId}::uuid, ${workedOn}::date,
              ${employmentId}::uuid, ${JSON.stringify(detail)}::jsonb, 'open',
              ${input.actorId}::uuid, ${input.actorId}::uuid)
      returning id::text as id
    `)
  ).rows[0];
  if (!created) throw new HrmConstructionError("The compliance finding was not recorded — no row was written.");
  return loadFinding(exec, orgId, String(created.id));
}

export async function loadFinding(
  exec: SqlExecutor,
  orgId: string,
  findingId: string,
): Promise<ComplianceFinding> {
  const row = (
    await exec.execute<{
      id: string;
      kind: ComplianceFindingKind;
      projectId: string | null;
      workedOn: string | null;
      employmentId: string | null;
      detail: Record<string, unknown>;
      status: string;
      recordedAt: string;
    }>(sql`
      select id::text as id, kind,
             project_id::text as "projectId", worked_on::text as "workedOn",
             employment_id::text as "employmentId",
             detail, status, recorded_at::text as "recordedAt"
        from hrm_compliance_findings
       where org_id = ${orgId}::uuid and id = ${findingId}::uuid
    `)
  ).rows[0];
  if (!row) {
    throw new HrmConstructionError(
      `Compliance finding ${findingId} does not exist in this organization — it may belong to another org.`,
    );
  }
  return { ...row, detail: (row.detail ?? {}) as Record<string, unknown> };
}

export async function listFindings(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  status?: string | null,
): Promise<readonly ComplianceFinding[]> {
  await assertConstructionFeature(exec, orgId, HRM_CONSTRUCTION_FEATURE, "Compliance findings");
  requireId(actorId, "actorId");
  await requireHrmConstructionRead(exec, orgId, actorId);
  if (status !== undefined && status !== null && !["open", "acknowledged", "resolved"].includes(status)) {
    throw new HrmConstructionError(`Unknown finding status ${status} — use open, acknowledged, or resolved.`);
  }
  const rows = (
    await exec.execute<{
      id: string;
      kind: ComplianceFindingKind;
      projectId: string | null;
      workedOn: string | null;
      employmentId: string | null;
      detail: Record<string, unknown>;
      status: string;
      recordedAt: string;
    }>(sql`
      select id::text as id, kind,
             project_id::text as "projectId", worked_on::text as "workedOn",
             employment_id::text as "employmentId",
             detail, status, recorded_at::text as "recordedAt"
        from hrm_compliance_findings
       where org_id = ${orgId}::uuid
         and (${status}::text is null or status = ${status}::text)
       order by recorded_at desc
    `)
  ).rows;
  return rows.map((row) => ({ ...row, detail: (row.detail ?? {}) as Record<string, unknown> }));
}

export async function acknowledgeFinding(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  findingId: string,
): Promise<ComplianceFinding> {
  requireId(actorId, "actorId");
  await assertConstructionFeature(exec, orgId, HRM_CONSTRUCTION_FEATURE, "Compliance findings");
  await requireHrmConstructionManage(exec, orgId, actorId);
  const updated = (
    await exec.execute<{ id: string }>(sql`
      update hrm_compliance_findings
         set status = 'acknowledged', updated_by = ${actorId}::uuid, updated_at = now()
       where org_id = ${orgId}::uuid and id = ${findingId}::uuid and status = 'open'
      returning id::text as id
    `)
  ).rows[0];
  if (!updated) {
    throw new HrmConstructionError(
      `Compliance finding ${findingId} cannot be acknowledged — it does not exist here or is no longer open.`,
    );
  }
  return loadFinding(exec, orgId, String(updated.id));
}

export async function resolveFinding(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  findingId: string,
  reason: string,
): Promise<ComplianceFinding> {
  requireId(actorId, "actorId");
  const resolvedReason = requireText(reason, "resolvedReason");
  await assertConstructionFeature(exec, orgId, HRM_CONSTRUCTION_FEATURE, "Compliance findings");
  await requireHrmConstructionManage(exec, orgId, actorId);
  const updated = (
    await exec.execute<{ id: string }>(sql`
      update hrm_compliance_findings
         set status = 'resolved', resolved_reason = ${resolvedReason},
             updated_by = ${actorId}::uuid, updated_at = now()
       where org_id = ${orgId}::uuid and id = ${findingId}::uuid and status in ('open', 'acknowledged')
      returning id::text as id
    `)
  ).rows[0];
  if (!updated) {
    throw new HrmConstructionError(
      `Compliance finding ${findingId} cannot be resolved — it does not exist here or is already resolved.`,
    );
  }
  return loadFinding(exec, orgId, String(updated.id));
}
