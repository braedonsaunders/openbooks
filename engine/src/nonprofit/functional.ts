import { sql } from "drizzle-orm";
import { AllocationApportionError, apportionTargets } from "../allocations/apportion.ts";
import type { ApportionResult, AllocationResidualPolicy } from "../allocations/types.ts";
import { lockAndCheckOrgFeature, orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { db, inDbTransaction, withOrgContext, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { NonprofitError } from "./errors.ts";

export const FUNCTIONAL_CATEGORIES = ["program", "management_general", "fundraising"] as const;
export type FunctionalCategory = (typeof FUNCTIONAL_CATEGORIES)[number];

export type FunctionalMapping = {
  id: string;
  orgId: string;
  departmentId: string | null;
  projectId: string | null;
  functionKey: FunctionalCategory;
  programKey: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  createdAt: string;
  createdBy: string;
};

type FunctionalMappingRow = {
  id: string;
  org_id: string;
  department_id: string | null;
  project_id: string | null;
  function: string;
  program_key: string | null;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
  created_by: string;
};

export type SetFunctionalMappingInput = {
  orgId: string;
  departmentId?: string | null;
  projectId?: string | null;
  functionKey: FunctionalCategory;
  programKey?: string | null;
  effectiveFrom: string;
  effectiveTo?: string | null;
  actorId: string;
  reason: string;
};

const FUNCTIONAL_FEATURE_REMEDY = "Enable Functional Expenses in Company Settings → Features.";

export function functionalFeatureOff(): NonprofitError {
  return new NonprofitError({
    message: "Functional expense reporting is disabled; enable functionalExpenses in Company Settings → Features.",
    status: 422,
    code: "feature_off",
    remedy: FUNCTIONAL_FEATURE_REMEDY,
  });
}

function mappingRefusal(message: string, code: string, remedy: string, field?: string): NonprofitError {
  return new NonprofitError({ message, status: 422, code, remedy, ...(field ? { field } : {}) });
}

function toMapping(row: FunctionalMappingRow): FunctionalMapping {
  if (!(FUNCTIONAL_CATEGORIES as readonly string[]).includes(row.function)) {
    throw new NonprofitError({
      message: `Functional mapping ${row.id} has unsupported function ${row.function}.`,
      status: 409,
      code: "functional_mapping_invalid",
      remedy: "Correct the mapping to Program, Management and General, or Fundraising through setFunctionalMapping.",
    });
  }
  return {
    id: row.id,
    orgId: row.org_id,
    departmentId: row.department_id,
    projectId: row.project_id,
    functionKey: row.function as FunctionalCategory,
    programKey: row.program_key,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function validDate(value: string): boolean {
  return isIsoCalendarDate(value);
}

function validateMappingInput(input: SetFunctionalMappingInput): void {
  const hasDepartment = Boolean(input.departmentId);
  const hasProject = Boolean(input.projectId);
  if (hasDepartment === hasProject) {
    throw mappingRefusal(
      "A functional mapping must identify exactly one department or project.",
      "functional_mapping_subject_invalid",
      "Choose one department or one project when calling setFunctionalMapping.",
      "departmentId",
    );
  }
  if (!validDate(input.effectiveFrom) || (input.effectiveTo && !validDate(input.effectiveTo))) {
    throw mappingRefusal(
      "Functional mapping dates must be valid calendar dates.",
      "functional_mapping_date_invalid",
      "Provide valid effectiveFrom and effectiveTo dates in YYYY-MM-DD format.",
      "effectiveFrom",
    );
  }
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) {
    throw mappingRefusal(
      "A functional mapping cannot end before it becomes effective.",
      "functional_mapping_date_range_invalid",
      "Choose an effectiveTo date on or after effectiveFrom.",
      "effectiveTo",
    );
  }
  if (!(FUNCTIONAL_CATEGORIES as readonly string[]).includes(input.functionKey)) {
    throw mappingRefusal(
      "The functional category is not supported.",
      "functional_mapping_function_invalid",
      "Choose program, management_general, or fundraising.",
      "functionKey",
    );
  }
  if (input.functionKey !== "program" && input.programKey) {
    throw mappingRefusal(
      "A program key can only be assigned to the program function.",
      "functional_mapping_program_key_invalid",
      "Remove programKey or map the subject to program.",
      "programKey",
    );
  }
  if (!input.actorId || !input.reason.trim()) {
    throw mappingRefusal(
      "A user and a reason are required for a functional mapping change.",
      "functional_mapping_audit_required",
      "Sign in and enter the reason for the mapping change before saving it.",
      !input.actorId ? "actorId" : "reason",
    );
  }
}

async function auditMapping(
  runner: SqlExecutor,
  input: { orgId: string; rowId: string; actorId: string; action: string; before: unknown; after: unknown; reason: string },
): Promise<void> {
  const recorded = await runner.execute<{ id: string }>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (
      ${input.orgId}, 'functional_mappings', ${input.rowId}, ${input.action},
      ${JSON.stringify({ before: input.before, after: input.after, reason: input.reason })}::jsonb,
      ${input.actorId}
    ) returning id
  `);
  if (recorded.rows.length !== 1) {
    throw new NonprofitError({
      message: "The functional mapping change was not recorded in audit history.",
      status: 409,
      code: "functional_mapping_audit_missing",
      remedy: "Retry the mapping change after checking the audit service.",
    });
  }
}

/** Create an effective-dated mapping while keeping the prior schedule intact. */
export async function setFunctionalMapping(input: SetFunctionalMappingInput): Promise<FunctionalMapping> {
  validateMappingInput(input);
  const departmentId = input.departmentId ?? null;
  const projectId = input.projectId ?? null;
  const programKey = input.functionKey === "program" ? input.programKey?.trim() || null : null;
  const reason = input.reason.trim();

  return withOrgTransaction(input.orgId, () => inDbTransaction(async (tx) => {
    if (!(await lockAndCheckOrgFeature(tx, input.orgId, "functionalExpenses"))) {
      throw functionalFeatureOff();
    }

    const prior = (await tx.execute<FunctionalMappingRow>(sql`
      select id, org_id, department_id, project_id, function, program_key,
             effective_from::text, effective_to::text, created_at::text, created_by::text
        from functional_mappings
       where org_id = ${input.orgId}
         and department_id is not distinct from ${departmentId}
         and project_id is not distinct from ${projectId}
         and effective_to is null
         and effective_from < ${input.effectiveFrom}::date
       for update
    `)).rows[0];

    if (prior) {
      const closed = await tx.execute<FunctionalMappingRow>(sql`
        update functional_mappings
           set effective_to = ${input.effectiveFrom}::date - 1,
               updated_at = now(), updated_by = ${input.actorId}
         where org_id = ${input.orgId} and id = ${prior.id} and effective_to is null
        returning id, org_id, department_id, project_id, function, program_key,
                  effective_from::text, effective_to::text, created_at::text, created_by::text
      `);
      const previous = closed.rows[0];
      if (!previous) {
        throw new NonprofitError({
          message: "The previous functional mapping changed before the new mapping could be saved.",
          status: 409,
          code: "functional_mapping_stale",
          remedy: "Reload the functional mapping schedule and retry with a current effective date.",
        });
      }
      await auditMapping(tx, {
        orgId: input.orgId,
        rowId: prior.id,
        actorId: input.actorId,
        action: "update",
        before: toMapping(prior),
        after: toMapping(previous),
        reason,
      });
    }

    const overlaps = await tx.execute<{ id: string }>(sql`
      select id from functional_mappings
       where org_id = ${input.orgId}
         and department_id is not distinct from ${departmentId}
         and project_id is not distinct from ${projectId}
         and daterange(effective_from, effective_to, '[]') &&
             daterange(${input.effectiveFrom}::date, ${input.effectiveTo ?? null}::date, '[]')
       for update
    `);
    if (overlaps.rows.length > 0) {
      throw mappingRefusal(
        "The functional mapping period overlaps an existing mapping for this department or project.",
        "functional_mapping_period_overlap",
        "Choose an effective date after the existing mapping ends, or correct the existing schedule with setFunctionalMapping.",
        "effectiveFrom",
      );
    }

    let inserted: { rows: FunctionalMappingRow[] };
    try {
      inserted = await tx.execute<FunctionalMappingRow>(sql`
        insert into functional_mappings
          (org_id, department_id, project_id, function, program_key, effective_from, effective_to,
           created_by, updated_by)
        values (
          ${input.orgId}, ${departmentId}, ${projectId}, ${input.functionKey}, ${programKey},
          ${input.effectiveFrom}::date, ${input.effectiveTo ?? null}::date, ${input.actorId}, ${input.actorId}
        )
        returning id, org_id, department_id, project_id, function, program_key,
                  effective_from::text, effective_to::text, created_at::text, created_by::text
      `);
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
      const dbError = cause as { code?: unknown; constraint?: unknown };
      if (dbError.code === "23P01" && typeof dbError.constraint === "string" &&
          dbError.constraint.startsWith("functional_mappings_")) {
        throw mappingRefusal(
          "The functional mapping period overlaps a mapping saved at the same time.",
          "functional_mapping_period_overlap",
          "Reload the department or project schedule and choose an effective period with no overlap.",
          "effectiveFrom",
        );
      }
      throw error;
    }
    const row = inserted.rows[0];
    if (!row) {
      throw new NonprofitError({
        message: "The functional mapping was not saved.",
        status: 409,
        code: "functional_mapping_write_missing",
        remedy: "Retry the mapping change after checking the nonprofit setup record.",
      });
    }
    const saved = toMapping(row);
    await auditMapping(tx, {
      orgId: input.orgId,
      rowId: saved.id,
      actorId: input.actorId,
      action: "insert",
      before: null,
      after: saved,
      reason,
    });
    return saved;
  }));
}

export async function listFunctionalMappings(orgId: string): Promise<FunctionalMapping[]> {
  return withOrgContext(orgId, async () => {
    if (!(await orgFeatureEnabled(orgId, "functionalExpenses", db))) throw functionalFeatureOff();
    const rows = await db.execute<FunctionalMappingRow>(sql`
      select id, org_id, department_id, project_id, function, program_key,
             effective_from::text, effective_to::text, created_at::text, created_by::text
        from functional_mappings
       where org_id = ${orgId}
       order by coalesce(department_id, project_id), effective_from, id
    `);
    return rows.rows.map(toMapping);
  });
}

export type FunctionalLine = {
  accountName: string;
  departmentId: string | null;
  projectId: string | null;
  postingDate: string;
};

export type FunctionalAssignment = {
  functionKey: FunctionalCategory;
  programKey: string | null;
};

function appliesOn(mapping: FunctionalMapping, line: FunctionalLine): boolean {
  return (mapping.departmentId !== null && mapping.departmentId === line.departmentId ||
    mapping.projectId !== null && mapping.projectId === line.projectId) &&
    mapping.effectiveFrom <= line.postingDate &&
    (mapping.effectiveTo === null || mapping.effectiveTo >= line.postingDate);
}

/** Resolve an expense line without inventing a default function. */
export function resolveFunctionalAssignment(
  line: FunctionalLine,
  mappings: readonly FunctionalMapping[],
): FunctionalAssignment {
  const candidates = mappings.filter((mapping) => appliesOn(mapping, line));
  const department = candidates.find((mapping) => mapping.departmentId === line.departmentId && line.departmentId !== null);
  const project = candidates.find((mapping) => mapping.projectId === line.projectId && line.projectId !== null);
  if (department && project &&
      (department.functionKey !== project.functionKey || department.programKey !== project.programKey)) {
    throw mappingRefusal(
      `Expense account ${line.accountName} has department and project mappings that assign different functions.`,
      "functional_mapping_conflict",
      "Align the effective department and project mappings with setFunctionalMapping before running the functional statement.",
    );
  }
  const mapping = department ?? project;
  if (!mapping) {
    throw mappingRefusal(
      `Expense account ${line.accountName} has no effective functional mapping for ${line.postingDate}.`,
      "functional_mapping_missing",
      "Add an effective department or project mapping with setFunctionalMapping, then rerun the functional statement.",
    );
  }
  return { functionKey: mapping.functionKey, programKey: mapping.programKey };
}

export type SharedCostTarget = {
  key: string;
  functionKey: FunctionalCategory;
  programKey?: string | null;
  weight: string;
};

export type SharedCostSplit = {
  total: string;
  targets: Array<SharedCostTarget & { amount: string; share: string; residual: string }>;
  functionTotals: Record<FunctionalCategory, string>;
  disclosure: {
    allocationRuleKey: string;
    allocationRuleName: string;
    driverKey: string;
    driverName: string;
    driverUnit: string;
    asOf: string;
    residualPolicy: AllocationResidualPolicy;
  };
};

/** Split a shared cost using the allocation kernel's exact residual policy. */
export function splitSharedCost(input: {
  total: string;
  targets: readonly SharedCostTarget[];
  allocationRuleKey: string;
  allocationRuleName: string;
  driverKey: string;
  driverName: string;
  driverUnit: string;
  asOf: string;
}): SharedCostSplit {
  for (const [field, value] of Object.entries({
    allocationRuleKey: input.allocationRuleKey,
    allocationRuleName: input.allocationRuleName,
    driverKey: input.driverKey,
    driverName: input.driverName,
    driverUnit: input.driverUnit,
    asOf: input.asOf,
  })) {
    if (!value.trim()) {
      throw mappingRefusal(
        `A shared-cost allocation is missing its disclosed ${field}.`,
        "functional_allocation_disclosure_missing",
        "Choose a published allocation rule and driver with a name, unit, and effective date.",
        field,
      );
    }
  }
  const residualPolicy: AllocationResidualPolicy = "largest_share";
  let apportioned: ApportionResult;
  try {
    apportioned = apportionTargets(
      input.total,
      input.targets.map(({ key, weight }) => ({ key, weight })),
      residualPolicy,
    );
  } catch (error) {
    if (error instanceof AllocationApportionError && error.code === "no_driver_weight") {
      throw mappingRefusal(
        "The disclosed allocation driver has no positive weight for the shared cost.",
        "functional_allocation_driver_empty",
        "Enter positive driver values for the rule's target departments or projects before allocating the cost.",
      );
    }
    throw mappingRefusal(
      error instanceof Error ? error.message : "The allocation driver could not split the shared cost.",
      "functional_allocation_invalid",
      "Correct the published allocation rule and driver weights, then rerun the functional statement.",
    );
  }
  const splitTargets = apportioned.targets.map((share) => {
    const target = input.targets.find((candidate) => candidate.key === share.key);
    if (!target) {
      throw new NonprofitError({
        message: "The allocation kernel returned a target that was not in the disclosed driver.",
        status: 409,
        code: "functional_allocation_target_missing",
        remedy: "Reload the published allocation rule and its driver values before splitting the shared cost.",
      });
    }
    return { ...target, ...share };
  });
  const units = splitTargets.reduce((sum, target) => sum + toUnits(target.amount), 0n);
  if (units !== toUnits(input.total)) {
    throw new NonprofitError({
      message: "The disclosed functional allocation does not tie to the shared cost.",
      status: 409,
      code: "functional_allocation_out_of_balance",
      remedy: "Correct the allocation rule and driver values so every cost target is included.",
    });
  }
  const totals: Record<FunctionalCategory, bigint> = {
    program: 0n,
    management_general: 0n,
    fundraising: 0n,
  };
  for (const target of splitTargets) totals[target.functionKey] += toUnits(target.amount);
  return {
    total: fromUnits(units),
    targets: splitTargets,
    functionTotals: {
      program: fromUnits(totals.program),
      management_general: fromUnits(totals.management_general),
      fundraising: fromUnits(totals.fundraising),
    },
    disclosure: {
      allocationRuleKey: input.allocationRuleKey,
      allocationRuleName: input.allocationRuleName,
      driverKey: input.driverKey,
      driverName: input.driverName,
      driverUnit: input.driverUnit,
      asOf: input.asOf,
      residualPolicy,
    },
  };
}
