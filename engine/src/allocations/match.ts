import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import type {
  AccountScope,
  AllocationApplyPolicy,
  AllocationMode,
  AllocationRuleTarget,
  AllocationRuleVersion,
  DimensionFilters,
  DynamicTarget,
  LineCoordinate,
  MatchResult,
  RuleInEffect,
  UntaggableDimension,
} from "./types.ts";

/**
 * Allocation kernel, entry/post matcher (shard A4).
 *
 * Pure `matchLine` / `selectRule` decide which rule fires for one line;
 * `listRulesInEffect` loads the candidate set (entry mode by default) for an
 * as-of date. Post mode (A5) reuses the pure matcher; entry mode (A4) wires
 * it into the document save path.
 */

export type AccountGroupResolver = (dimension: string, groupKey: string) => Set<string>;

export interface SelectRuleOptions {
  /** Restrict candidates to these apply policies (entry auto-explode passes 'automatic'). */
  applyPolicy?: AllocationApplyPolicy | AllocationApplyPolicy[];
  resolveAccountGroup?: AccountGroupResolver;
}

const DIMENSION_ID_KEYS = [
  "departmentIds",
  "locationIds",
  "classIds",
  "projectIds",
  "subsidiaryIds",
  "partyIds",
  "itemIds",
] as const;

type DimensionIdKey = (typeof DIMENSION_ID_KEYS)[number];

function lineValueFor(line: LineCoordinate, key: DimensionIdKey): string | null | undefined {
  switch (key) {
    case "departmentIds":
      return line.departmentId;
    case "locationIds":
      return line.locationId;
    case "classIds":
      return line.classId;
    case "projectIds":
      return line.projectId;
    case "subsidiaryIds":
      return line.subsidiaryId;
    case "partyIds":
      return line.partyId;
    case "itemIds":
      return line.itemId;
  }
}

const UNTAGGED_DIMENSION_VALUE: Record<UntaggableDimension, (line: LineCoordinate) => unknown> = {
  department: (line) => line.departmentId,
  location: (line) => line.locationId,
  class: (line) => line.classId,
  project: (line) => line.projectId,
};

function isUntagged(value: unknown): boolean {
  return value === null || value === undefined || value === "";
}

function nonEmptyStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry): entry is string => typeof entry === "string" && entry.length > 0)
  );
}

function matchAccountScope(
  scope: AccountScope,
  line: LineCoordinate,
  resolveAccountGroup?: AccountGroupResolver,
): boolean {
  switch (scope.kind) {
    case "any":
      return true;
    case "accounts":
      return scope.accountIds.includes(line.accountId);
    case "account_group": {
      const members = resolveAccountGroup?.(scope.dimension, scope.groupKey);
      return members?.has(line.accountId) ?? false;
    }
  }
}

/**
 * Pure applicability check: does this rule version consider this line?
 * Every present predicate must hold (AND); absent predicates match anything.
 * Specificity counts the present predicates that matched, so the most
 * constrained rule wins in selectRule. A non-match reports specificity 0 —
 * the count is only meaningful when matched is true.
 */
export function matchLine(
  version: AllocationRuleVersion,
  line: LineCoordinate,
  resolveAccountGroup?: AccountGroupResolver,
): MatchResult {
  let specificity = 0;

  const kinds = version.documentKinds;
  if (kinds !== null && kinds !== undefined && kinds.length > 0) {
    if (line.documentKind === null || line.documentKind === undefined || !kinds.includes(line.documentKind)) {
      return { matched: false, specificity: 0 };
    }
    specificity += 1;
  }

  if (!matchAccountScope(version.accountScope, line, resolveAccountGroup)) {
    return { matched: false, specificity: 0 };
  }
  if (version.accountScope.kind !== "any") specificity += 1;

  const filters: DimensionFilters = version.dimensionFilters ?? {};
  for (const key of DIMENSION_ID_KEYS) {
    const ids = filters[key];
    if (!nonEmptyStrings(ids)) continue;
    const value = lineValueFor(line, key);
    if (value === null || value === undefined || !ids.includes(value)) {
      return { matched: false, specificity: 0 };
    }
    specificity += 1;
  }

  const extraDims = filters.extraDims;
  if (extraDims !== null && extraDims !== undefined && typeof extraDims === "object") {
    for (const [segmentKey, ids] of Object.entries(extraDims)) {
      if (!nonEmptyStrings(ids)) continue;
      const value = line.extraDims?.[segmentKey];
      if (value === null || value === undefined || !ids.includes(value)) {
        return { matched: false, specificity: 0 };
      }
      specificity += 1;
    }
  }

  const untagged = filters.requireUntagged;
  if (Array.isArray(untagged) && untagged.length > 0) {
    const allUntagged = untagged.every((dimension) => {
      const read = UNTAGGED_DIMENSION_VALUE[dimension];
      return read === undefined || isUntagged(read(line));
    });
    if (!allUntagged) return { matched: false, specificity: 0 };
    specificity += 1;
  }

  return { matched: true, specificity };
}

/**
 * Most specific matching candidate wins; ties break by sort_order (lower
 * first) then rule key (byte order — deterministic across locales).
 */
export function selectRule(
  candidates: RuleInEffect[],
  line: LineCoordinate,
  opts: SelectRuleOptions = {},
): RuleInEffect | null {
  const allowed =
    opts.applyPolicy === undefined
      ? null
      : new Set(Array.isArray(opts.applyPolicy) ? opts.applyPolicy : [opts.applyPolicy]);
  let best: RuleInEffect | null = null;
  let bestSpecificity = -1;
  for (const candidate of candidates) {
    if (allowed !== null && !allowed.has(candidate.version.applyPolicy)) continue;
    const result = matchLine(candidate.version, line, opts.resolveAccountGroup);
    if (!result.matched) continue;
    if (
      best === null ||
      result.specificity > bestSpecificity ||
      (result.specificity === bestSpecificity &&
        (candidate.rule.sortOrder < best.rule.sortOrder ||
          (candidate.rule.sortOrder === best.rule.sortOrder && candidate.rule.key < best.rule.key)))
    ) {
      best = candidate;
      bestSpecificity = result.specificity;
    }
  }
  return best;
}

export interface RulesInEffectRequest {
  orgId: string;
  /** Candidate modes. Defaults to entry (the document-save matcher). */
  mode?: AllocationMode | AllocationMode[];
  /** Versions whose [effective_from, effective_to] window contains this date. Defaults to today (UTC). */
  asOf?: string;
  /** Restrict to these apply policies. */
  applyPolicy?: AllocationApplyPolicy | AllocationApplyPolicy[];
}

/**
 * Load active rules with their published version in force on the as-of date,
 * plus that version's explicit targets (sequence order). Only published
 * versions carry a definition hash, so only they can stamp lineage.
 */
export async function listRulesInEffect(request: RulesInEffectRequest): Promise<RuleInEffect[]> {
  const modes = request.mode === undefined ? ["entry"] : Array.isArray(request.mode) ? request.mode : [request.mode];
  if (modes.length === 0) return [];
  const asOf = request.asOf ?? new Date().toISOString().slice(0, 10);
  const policies =
    request.applyPolicy === undefined
      ? null
      : Array.isArray(request.applyPolicy)
        ? request.applyPolicy
        : [request.applyPolicy];

  const rows = (
    await db.execute<{
      ruleId: string;
      ruleKey: string;
      ruleName: string;
      ruleDescription: string | null;
      ruleMode: AllocationMode;
      sortOrder: number;
      isSystem: boolean;
      versionId: string;
      versionNo: number;
      effectiveFrom: string;
      effectiveTo: string | null;
      bookScope: AllocationRuleVersion["bookScope"];
      bookIds: string[];
      documentKinds: string[] | null;
      accountScope: AccountScope;
      dimensionFilters: DimensionFilters;
      applyPolicy: AllocationApplyPolicy;
      sourceMeasure: AllocationRuleVersion["sourceMeasure"];
      basisKind: AllocationRuleVersion["basisKind"];
      driverId: string | null;
      driverAsOf: AllocationRuleVersion["driverAsOf"];
      basisConfig: Record<string, unknown>;
      targetKind: AllocationRuleVersion["targetKind"];
      dynamicTarget: Partial<DynamicTarget>;
      impact: AllocationRuleVersion["impact"];
      offsetAccountId: string | null;
      residualPolicy: AllocationRuleVersion["residualPolicy"];
      residualTargetId: string | null;
      solveMethod: AllocationRuleVersion["solveMethod"];
      runPolicy: AllocationRuleVersion["runPolicy"];
      runOffsetDays: number;
      approvalFlowId: string | null;
      memoTemplate: string | null;
      lineDescriptionTemplate: string | null;
      definitionHash: string;
    }>(sql`
      select r.id as "ruleId", r.key as "ruleKey", r.name as "ruleName",
             r.description as "ruleDescription", r.mode as "ruleMode",
             r.sort_order as "sortOrder", r.is_system as "isSystem",
             v.id as "versionId", v.version_no as "versionNo",
             v.effective_from as "effectiveFrom", v.effective_to as "effectiveTo",
             v.book_scope as "bookScope", v.book_ids as "bookIds",
             v.document_kinds as "documentKinds", v.account_scope as "accountScope",
             v.dimension_filters as "dimensionFilters", v.apply_policy as "applyPolicy",
             v.source_measure as "sourceMeasure", v.basis_kind as "basisKind",
             v.driver_id as "driverId", v.driver_as_of as "driverAsOf",
             v.basis_config as "basisConfig", v.target_kind as "targetKind",
             v.dynamic_target as "dynamicTarget", v.impact as "impact",
             v.offset_account_id as "offsetAccountId", v.residual_policy as "residualPolicy",
             v.residual_target_id as "residualTargetId", v.solve_method as "solveMethod",
             v.run_policy as "runPolicy", v.run_offset_days as "runOffsetDays",
             v.approval_flow_id as "approvalFlowId", v.memo_template as "memoTemplate",
             v.line_description_template as "lineDescriptionTemplate",
             v.definition_hash as "definitionHash"
        from allocation_rules r
        join allocation_rule_versions v
          on v.org_id = r.org_id and v.id = r.current_version_id
       where r.org_id = ${request.orgId}
         and r.is_active
         and r.mode = any(${`{${modes.join(",")}}`}::text[])
         and v.status = 'published'
         and v.definition_hash is not null
         and v.effective_from <= ${asOf}::date
         and (v.effective_to is null or v.effective_to >= ${asOf}::date)
         ${policies === null ? sql`` : sql`and v.apply_policy = any(${`{${policies.join(",")}}`}::text[])`}
       order by r.sort_order, r.key
    `)
  ).rows;

  if (rows.length === 0) return [];

  const versionIds = [...new Set(rows.map((row) => row.versionId))];
  const targetRows = (
    await db.execute<{
      versionId: string;
      targetId: string;
      sequence: number;
      targetAccountId: string | null;
      departmentId: string | null;
      locationId: string | null;
      classId: string | null;
      projectId: string | null;
      subsidiaryId: string | null;
      extraDims: Record<string, string>;
      fixedPercent: string | null;
      weight: string | null;
      isRemainder: boolean;
      label: string | null;
    }>(sql`
      select version_id as "versionId", id as "targetId", sequence,
             target_account_id as "targetAccountId", department_id as "departmentId",
             location_id as "locationId", class_id as "classId",
             project_id as "projectId", subsidiary_id as "subsidiaryId",
             extra_dims as "extraDims", fixed_percent as "fixedPercent",
             weight, is_remainder as "isRemainder", label
        from allocation_rule_targets
       where org_id = ${request.orgId}
         and version_id = any(${`{${versionIds.join(",")}}`}::uuid[])
       order by sequence
    `)
  ).rows;

  const targetsByVersion = new Map<string, AllocationRuleTarget[]>();
  for (const row of targetRows) {
    const list = targetsByVersion.get(row.versionId) ?? [];
    list.push({
      id: row.targetId,
      sequence: Number(row.sequence),
      targetAccountId: row.targetAccountId,
      departmentId: row.departmentId,
      locationId: row.locationId,
      classId: row.classId,
      projectId: row.projectId,
      subsidiaryId: row.subsidiaryId,
      extraDims: row.extraDims ?? {},
      fixedPercent: row.fixedPercent,
      weight: row.weight,
      isRemainder: row.isRemainder === true,
      label: row.label,
    });
    targetsByVersion.set(row.versionId, list);
  }

  return rows.map((row) => ({
    rule: {
      id: row.ruleId,
      orgId: request.orgId,
      key: row.ruleKey,
      name: row.ruleName,
      description: row.ruleDescription,
      mode: row.ruleMode,
      sortOrder: Number(row.sortOrder),
      isActive: true,
      isSystem: row.isSystem === true,
      currentVersionId: row.versionId,
    },
    version: {
      id: row.versionId,
      orgId: request.orgId,
      ruleId: row.ruleId,
      versionNo: Number(row.versionNo),
      status: "published",
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      bookScope: row.bookScope,
      bookIds: row.bookIds ?? [],
      documentKinds: row.documentKinds,
      accountScope: row.accountScope ?? { kind: "any" },
      dimensionFilters: row.dimensionFilters ?? {},
      applyPolicy: row.applyPolicy,
      sourceMeasure: row.sourceMeasure,
      basisKind: row.basisKind,
      driverId: row.driverId,
      driverAsOf: row.driverAsOf,
      basisConfig: (row.basisConfig ?? {}) as Record<string, unknown>,
      targetKind: row.targetKind,
      dynamicTarget: row.dynamicTarget ?? {},
      impact: row.impact,
      offsetAccountId: row.offsetAccountId,
      residualPolicy: row.residualPolicy,
      residualTargetId: row.residualTargetId,
      solveMethod: row.solveMethod,
      runPolicy: row.runPolicy,
      runOffsetDays: Number(row.runOffsetDays),
      approvalFlowId: row.approvalFlowId,
      memoTemplate: row.memoTemplate,
      lineDescriptionTemplate: row.lineDescriptionTemplate,
      definitionHash: row.definitionHash,
      publishedAt: null,
      publishedBy: null,
    } satisfies AllocationRuleVersion,
    targets: targetsByVersion.get(row.versionId) ?? [],
  }));
}
