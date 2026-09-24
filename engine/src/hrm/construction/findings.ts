import { sql } from "drizzle-orm";
import { UnrestrictedScopeError } from "../../organization/subsidiary-scope.ts";
import { HrmConstructionError } from "./errors.ts";
import { requireConstructionScope, requireUnrestrictedHrmScope } from "../authorization.ts";
import { withOrgTransaction } from "../../platform/db.ts";
import {
  HRM_CONSTRUCTION_FEATURE,
  assertConstructionFeature,
  assertEmploymentInScope,
  assertProjectInScope,
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
  // No grant or scope gate: findings are evidence appended as a side
  // effect of the engine's own checks (including the approval-time
  // prevailing-wage hook, whose approver may hold no construction grant
  // at all — any require* here would break that hook). Those checks
  // fence their project/employment at THEIR entry; this append never
  // crosses to HTTP — reads fence at listFindings below, transitions
  // below that. Treat this like an audit append: fenced on read.
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
  if (status !== undefined && status !== null && !["open", "acknowledged", "resolved"].includes(status)) {
    throw new HrmConstructionError(`Unknown finding status ${status} — use open, acknowledged, or resolved.`);
  }
  // Finding detail carries priced effects and named employments: a
  // restricted reader sees only findings anchored to in-scope projects
  // or employments. Anchorless (org-wide) flags name no entity and stay
  // visible; dangling anchors (project/employment gone) fail closed and
  // hide, because the anchor that would authorize the read is gone.
  const allowed = await requireConstructionScope(exec, orgId, actorId, "hrm.construction.read");
  const scope = allowed === null
    ? sql``
    : sql`and (f.project_id is null or p.subsidiary_id = any (${`{${[...allowed].join(",")}}`}::uuid[]))
          and (f.employment_id is null or w.employer_subsidiary_id = any (${`{${[...allowed].join(",")}}`}::uuid[]))`;
  const statusFilter = status ? sql`and f.status = ${status}::text` : sql``;
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
      select f.id::text as id, f.kind,
             f.project_id::text as "projectId", f.worked_on::text as "workedOn",
             f.employment_id::text as "employmentId",
             f.detail, f.status, f.recorded_at::text as "recordedAt"
        from hrm_compliance_findings f
        left join projects p on p.org_id = f.org_id and p.id = f.project_id
        left join worker_employments w on w.org_id = f.org_id and w.id = f.employment_id
       where f.org_id = ${orgId}::uuid
         ${statusFilter}
         ${scope}
       order by f.recorded_at desc
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
  // A transition on B's evidence is a write to B: the finding's anchors
  // fence before the status read. An out-of-scope anchor refuses with the
  // finding's own not-found shape — never the anchor's — so a B flag reads
  // exactly like a fabricated id instead of confirming the flag exists.
  const allowed = await requireConstructionScope(exec, orgId, actorId, "hrm.construction.manage");
  const denied = `Compliance finding ${findingId} cannot be acknowledged — it does not exist here or is no longer open.`;
  return withOrgTransaction(orgId, async () => {
    const finding = (
      await exec.execute<{ status: string; projectId: string | null; employmentId: string | null }>(sql`
        select status, project_id::text as "projectId", employment_id::text as "employmentId"
          from hrm_compliance_findings
         where org_id = ${orgId}::uuid and id = ${findingId}::uuid
         for update
      `)
    ).rows[0];
    if (!finding) {
      throw new HrmConstructionError(denied);
    }
    await assertFindingInScope(exec, orgId, actorId, finding, allowed, denied);
    if (finding.status !== "open") {
      throw new HrmConstructionError(
        `Compliance finding ${findingId} cannot be acknowledged — it does not exist here or is no longer open.`,
      );
    }
    await exec.execute(sql`
      update hrm_compliance_findings
         set status = 'acknowledged', updated_by = ${actorId}::uuid, updated_at = now()
       where org_id = ${orgId}::uuid and id = ${findingId}::uuid
    `);
    return loadFinding(exec, orgId, findingId);
  });
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
  // Same fence as acknowledge: anchors first, status second, so an
  // out-of-scope flag never leaks its lifecycle state.
  const allowed = await requireConstructionScope(exec, orgId, actorId, "hrm.construction.manage");
  const denied = `Compliance finding ${findingId} cannot be resolved — it does not exist here or is already resolved.`;
  return withOrgTransaction(orgId, async () => {
    const finding = (
      await exec.execute<{ status: string; projectId: string | null; employmentId: string | null }>(sql`
        select status, project_id::text as "projectId", employment_id::text as "employmentId"
          from hrm_compliance_findings
         where org_id = ${orgId}::uuid and id = ${findingId}::uuid
         for update
      `)
    ).rows[0];
    if (!finding) {
      throw new HrmConstructionError(denied);
    }
    await assertFindingInScope(exec, orgId, actorId, finding, allowed, denied);
    if (finding.status !== "open" && finding.status !== "acknowledged") {
      throw new HrmConstructionError(
        `Compliance finding ${findingId} cannot be resolved — it does not exist here or is already resolved.`,
      );
    }
    await exec.execute(sql`
      update hrm_compliance_findings
         set status = 'resolved', resolved_reason = ${resolvedReason},
             updated_by = ${actorId}::uuid, updated_at = now()
       where org_id = ${orgId}::uuid and id = ${findingId}::uuid
    `);
    return loadFinding(exec, orgId, findingId);
  });
}

/**
 * The shared anchor fence for finding transitions: a named project
 * fences by project, else a named employment fences by employment,
 * else the flag is org-wide and needs unrestricted scope. Dangling
 * anchors (row gone) fail closed — the anchor that would authorize the
 * transition is gone with it. Every fence failure throws the finding's
 * own denial (never the anchor's), so an out-of-scope flag is
 * indistinguishable from a fabricated id.
 */
async function assertFindingInScope(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
  finding: { projectId: string | null; employmentId: string | null },
  allowed: ReadonlySet<string> | null,
  denied: string,
): Promise<void> {
  try {
    if (finding.projectId) {
      // Share-locked: transitions run inside the write transaction, so a
      // concurrent subsidiary move waits for the check.
      await assertProjectInScope(exec, orgId, finding.projectId, allowed, "share");
      return;
    }
    if (finding.employmentId) {
      await assertEmploymentInScope(exec, orgId, finding.employmentId, allowed, true);
      return;
    }
    await requireUnrestrictedHrmScope(exec, orgId, actorId);
  } catch (error) {
    if (error instanceof HrmConstructionError || error instanceof UnrestrictedScopeError) {
      throw new HrmConstructionError(denied);
    }
    throw error;
  }
}
