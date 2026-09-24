import { sql } from "drizzle-orm";
import { HrmConstructionError } from "./errors.ts";
import {
  requireConstructionScope,
  requireHrmConstructionRead,
  requireUnrestrictedHrmScope,
} from "../authorization.ts";
import { recordFinding } from "./findings.ts";
import { actorAllowedSubsidiaryIds } from "../../organization/actor-subsidiaries.ts";
import { compRuleMatches, pickCompRule, type CompMatch, type CompTarget } from "./pure.ts";
import {
  HRM_WORKERS_COMP_FEATURE,
  assertConstructionFeature,
  assertEmploymentInScope,
  assertProjectInScope,
  requireDate,
  requireId,
  requireText,
  withOrgTransaction,
  type SqlExecutor,
} from "./shared.ts";

/**
 * Workers'-comp / premium classes (HR-13, migration 0224). classify()
 * resolves one costed hour to its class by highest-priority match and
 * REFUSES with a class_unresolved finding when nothing matches — a
 * default class would price payroll exposure at the wrong rate silently.
 * dailySplit() prices a day's approved hours per employment per class
 * from the same rule set.
 */

export interface CompClass {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly jurisdictionCode: string | null;
  readonly ratePer100: string | null;
}

export async function listCompClasses(exec: SqlExecutor, orgId: string, actorId: string): Promise<readonly CompClass[]> {
  await assertConstructionFeature(exec, orgId, HRM_WORKERS_COMP_FEATURE, "Comp classes");
  requireId(actorId, "actorId");
  await requireHrmConstructionRead(exec, orgId, actorId);
  const rows = (
    await exec.execute<{
      id: string;
      code: string;
      name: string;
      jurisdictionCode: string | null;
      ratePer100: string | null;
    }>(sql`
      select id::text as id, code, name,
             jurisdiction_code as "jurisdictionCode",
             rate_per_100::text as "ratePer100"
        from hrm_comp_classes
       where org_id = ${orgId}::uuid
       order by code
    `)
  ).rows;
  return rows;
}

export async function createCompClass(
  exec: SqlExecutor,
  input: {
  orgId: string;
  actorId: string;
  code: string;
  name: string;
  jurisdictionCode?: string | null;
  ratePer100?: string | null;
  effectiveFrom: string;
}): Promise<CompClass> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const code = requireText(input.code, "code");
  const name = requireText(input.name, "name");
  if (input.ratePer100 !== undefined && input.ratePer100 !== null && !/^\d+(\.\d{1,4})?$/.test(input.ratePer100)) {
    throw new HrmConstructionError(`ratePer100 must be a non-negative decimal with at most 4 places — got ${input.ratePer100}.`);
  }
  const effectiveFrom = requireDate(input.effectiveFrom, "effectiveFrom");
  return withOrgTransaction(orgId, async () => {
    await assertConstructionFeature(exec, orgId, HRM_WORKERS_COMP_FEATURE, "Comp classes");
    // Premium classes price every entity's exposure: org-wide config
    // needs unrestricted scope (named 403).
    await requireConstructionScope(exec, orgId, actorId, "hrm.construction.manage");
    await requireUnrestrictedHrmScope(exec, orgId, actorId);
    try {
      const created = (
        await exec.execute<{ id: string }>(sql`
          insert into hrm_comp_classes
            (org_id, code, name, jurisdiction_code, rate_per_100, effective_from, created_by, updated_by)
          values (${orgId}::uuid, ${code}, ${name}, ${input.jurisdictionCode ?? null},
                  ${input.ratePer100 ?? null}, ${effectiveFrom}::date,
                  ${actorId}::uuid, ${actorId}::uuid)
          returning id::text as id
        `)
      ).rows[0];
      if (!created) throw new HrmConstructionError(`Comp class ${code} was not created — no row was written.`);
      const rows = await listCompClasses(exec, orgId, actorId);
      const found = rows.find((row) => row.id === created.id);
      if (!found) throw new HrmConstructionError(`Comp class ${code} was not created — it cannot be read back.`);
      return found;
    } catch (error) {
      if (error instanceof HrmConstructionError) throw error;
      throw new HrmConstructionError(
        `Comp class ${code} cannot be saved — its code is already in use in this organization.`,
      );
    }
  });
}

export interface CompRule {
  readonly id: string;
  readonly priority: number;
  readonly match: CompMatch;
  readonly compClassId: string;
}

export async function listCompRules(
  exec: SqlExecutor,
  orgId: string,
  actorId: string,
): Promise<readonly CompRule[]> {
  await assertConstructionFeature(exec, orgId, HRM_WORKERS_COMP_FEATURE, "Comp classes");
  requireId(actorId, "actorId");
  await requireHrmConstructionRead(exec, orgId, actorId);
  return activeRules(exec, orgId);
}

export async function createCompRule(
  exec: SqlExecutor,
  input: {
  orgId: string;
  actorId: string;
  priority: number;
  match: CompMatch;
  compClassId: string;
}): Promise<CompRule> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  if (!Number.isInteger(input.priority) || input.priority < 0) {
    throw new HrmConstructionError("Rule priority must be a non-negative integer — higher wins.");
  }
  assertCompMatch(input.match);
  const compClassId = requireId(input.compClassId, "compClassId");
  return withOrgTransaction(orgId, async () => {
    await assertConstructionFeature(exec, orgId, HRM_WORKERS_COMP_FEATURE, "Comp classes");
    // Rules price org-wide exposure: org-wide config needs unrestricted
    // scope — except a rule naming a project, which is project-scoped
    // config and needs scope over that project instead.
    const allowed = await requireConstructionScope(exec, orgId, actorId, "hrm.construction.manage");
    const matchProjectId =
      typeof input.match.project_id === "string" ? input.match.project_id : null;
    if (matchProjectId !== null) {
      await assertProjectInScope(exec, orgId, matchProjectId, allowed, "share");
    } else {
      await requireUnrestrictedHrmScope(exec, orgId, actorId);
    }
    const compClass = (
      await exec.execute<{ id: string }>(sql`
        select id from hrm_comp_classes where org_id = ${orgId}::uuid and id = ${compClassId}::uuid
      `)
    ).rows[0];
    if (!compClass) {
      throw new HrmConstructionError(
        `Comp class ${compClassId} does not exist in this organization — point the rule at a declared class.`,
      );
    }
    const created = (
      await exec.execute<{ id: string }>(sql`
        insert into hrm_comp_class_rules (org_id, priority, match, comp_class_id, created_by, updated_by)
        values (${orgId}::uuid, ${input.priority}, ${JSON.stringify(input.match)}::jsonb,
                ${compClassId}::uuid, ${actorId}::uuid, ${actorId}::uuid)
        returning id::text as id
      `)
    ).rows[0];
    if (!created) throw new HrmConstructionError("The comp-class rule was not written — no row was created.");
    return { id: String(created.id), priority: input.priority, match: input.match, compClassId };
  });
}

function assertCompMatch(match: CompMatch): void {
  if (typeof match !== "object" || match === null || Array.isArray(match)) {
    throw new HrmConstructionError("Rule match must be a JSON object.");
  }
  const allowed = ["project_id", "cost_code_id", "department_id", "classification_id", "state_code"];
  for (const key of Object.keys(match)) {
    if (!allowed.includes(key)) {
      throw new HrmConstructionError(
        `Rule match key ${key} is not one of ${allowed.join(", ")} — the match shape is closed.`,
      );
    }
  }
  if (Object.keys(match).length === 0) {
    throw new HrmConstructionError(
      "A rule with an empty match would claim every hour — name at least one of project, cost code, department, classification, or state.",
    );
  }
}

async function activeRules(
  exec: SqlExecutor,
  orgId: string,
): Promise<ReadonlyArray<{ id: string; priority: number; match: CompMatch; compClassId: string }>> {
  const rows = (
    await exec.execute<{ id: string; priority: number; match: CompMatch; compClassId: string }>(sql`
      select id::text as id, priority, match, comp_class_id::text as "compClassId"
        from hrm_comp_class_rules
       where org_id = ${orgId}::uuid and is_active
    `)
  ).rows;
  return rows;
}

/**
 * Resolve one costed hour. The highest-priority match wins; nothing
 * matching writes a class_unresolved finding AND refuses — surfaced,
 * never defaulted.
 */
export async function classify(
  exec: SqlExecutor,
  input: {
    orgId: string;
    actorId: string;
    projectId?: string | null;
    costCodeId?: string | null;
    departmentId?: string | null;
    classificationId?: string | null;
    stateCode?: string | null;
    workedOn?: string | null;
    employmentId?: string | null;
  },
): Promise<CompClass> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  await assertConstructionFeature(exec, orgId, HRM_WORKERS_COMP_FEATURE, "Comp-class resolution");
  // No grant gate (costing resolution runs for actors holding no
  // construction grant), but named anchors still fence by the actor's
  // subsidiary lens: B's project or employment reads exactly like a
  // fabricated id, and the unresolved finding can never be aimed
  // cross-entity.
  const lens = await actorAllowedSubsidiaryIds(exec, orgId, actorId);
  if (input.projectId) await assertProjectInScope(exec, orgId, input.projectId, lens);
  if (input.employmentId) await assertEmploymentInScope(exec, orgId, input.employmentId, lens);
  const target: CompTarget = {
    projectId: input.projectId ?? null,
    costCodeId: input.costCodeId ?? null,
    departmentId: input.departmentId ?? null,
    classificationId: input.classificationId ?? null,
    stateCode: input.stateCode ?? null,
  };
  const hit = pickCompRule(await activeRules(exec, orgId), target);
  if (!hit) {
    if (input.workedOn) {
      await recordFinding(exec, {
        orgId,
        actorId: input.actorId,
        kind: "class_unresolved",
        projectId: target.projectId,
        workedOn: input.workedOn,
        employmentId: input.employmentId ?? null,
        detail: { target },
      });
    }
    throw new HrmConstructionError(
      "No comp-class rule matches this hour — declare a rule covering it before costing. The unresolved hour was flagged on the Compliance page.",
    );
  }
  const compClass = (
    await exec.execute<{
      id: string;
      code: string;
      name: string;
      jurisdictionCode: string | null;
      ratePer100: string | null;
    }>(sql`
      select id::text as id, code, name,
             jurisdiction_code as "jurisdictionCode", rate_per_100::text as "ratePer100"
        from hrm_comp_classes
       where org_id = ${orgId}::uuid and id = ${hit.compClassId}::uuid
    `)
  ).rows[0];
  if (!compClass) {
    throw new HrmConstructionError(
      `Comp class ${hit.compClassId} no longer exists — point the matching rule at a declared class.`,
    );
  }
  return compClass;
}

/** A day's approved hours per employment per class, from the same rule set — unresolved hours refuse, never split blind. */
export async function dailySplit(
  exec: SqlExecutor,
  input: { orgId: string; actorId: string; projectId: string; workedOn: string },
): Promise<readonly { employmentId: string; compClassId: string; compCode: string; hours: string }[]> {
  const orgId = requireId(input.orgId, "orgId");
  const actorId = requireId(input.actorId, "actorId");
  const projectId = requireId(input.projectId, "projectId");
  const workedOn = requireDate(input.workedOn, "workedOn");
  await assertConstructionFeature(exec, orgId, HRM_WORKERS_COMP_FEATURE, "Comp-class resolution");
  // The split exposes per-employment hours: the project must sit inside
  // the reader's lens — a B project reads exactly like a missing one.
  const allowed = await requireConstructionScope(exec, orgId, actorId, "hrm.construction.manage");
  await assertProjectInScope(exec, orgId, projectId, allowed);
  const hours = (
    await exec.execute<{
      employmentId: string | null;
      partyId: string;
      departmentId: string | null;
      hours: string;
    }>(sql`
      select w.id::text as "employmentId", te.employee_party_id::text as "partyId",
             te.department_id::text as "departmentId", sum(te.hours)::text as hours
        from time_entries te
        left join worker_employments w
          on w.org_id = te.org_id and w.worker_party_id = te.employee_party_id
       where te.org_id = ${orgId}::uuid and te.project_id = ${projectId}::uuid
         and te.worked_on = ${workedOn}::date and te.status = 'approved'
       group by w.id, te.employee_party_id, te.department_id
    `)
  ).rows;
  const out: Array<{ employmentId: string; compClassId: string; compCode: string; hours: string }> = [];
  for (const row of hours) {
    const compClass = await classify(exec, {
      orgId,
      actorId,
      projectId,
      departmentId: row.departmentId,
      workedOn,
      employmentId: row.employmentId,
    });
    out.push({
      employmentId: row.employmentId ?? row.partyId,
      compClassId: compClass.id,
      compCode: compClass.code,
      hours: row.hours,
    });
  }
  return out;
}

export { compRuleMatches };
