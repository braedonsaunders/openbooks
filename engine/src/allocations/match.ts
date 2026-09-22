import { businessToday } from "../platform/business-date.ts";
import { listRulesInEffect as listRulesInEffectByWindow } from "./rules.ts";
import type {
  AccountScope,
  AllocationApplyPolicy,
  AllocationMode,
  AllocationRuleVersion,
  DimensionFilters,
  LineCoordinate,
  MatchResult,
  RuleInEffect,
  UntaggableDimension,
} from "./types.ts";

/**
 * Allocation kernel, entry/post matcher (shard A4).
 *
 * Pure `matchLine` / `selectRule` decide which rule fires for one line;
 * `listEntryRulesInEffect` narrows A1's canonical window-based listing to the
 * heads' current versions for an as-of date. Post mode (A5) reuses the pure
 * matcher; entry mode (A4) wires it into the document save path.
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
 * Entry-oriented rule candidates: A1's canonical window-based listing
 * (rules.ts listRulesInEffect) narrowed to the head's current published
 * version, with an optional apply-policy filter. Entry (and post) consumers
 * match against these; the canonical cross-mode listing stays in rules.ts.
 */
export async function listEntryRulesInEffect(request: RulesInEffectRequest): Promise<RuleInEffect[]> {
  const modes =
    request.mode === undefined ? (["entry"] as AllocationMode[]) : Array.isArray(request.mode) ? request.mode : [request.mode];
  if (modes.length === 0) return [];
  // Rules in effect are read as of the org's business day, never the UTC day
  // (which is tomorrow in the evening for the Americas).
  const asOf = request.asOf ?? (await businessToday(request.orgId));
  const policies =
    request.applyPolicy === undefined
      ? null
      : new Set(Array.isArray(request.applyPolicy) ? request.applyPolicy : [request.applyPolicy]);
  const out: RuleInEffect[] = [];
  for (const mode of modes) {
    const rules = await listRulesInEffectByWindow({ orgId: request.orgId, mode, onDate: asOf });
    for (const rule of rules) {
      if (rule.version.id !== rule.rule.currentVersionId) continue;
      if (policies !== null && !policies.has(rule.version.applyPolicy)) continue;
      out.push(rule);
    }
  }
  out.sort((a, b) =>
    a.rule.sortOrder !== b.rule.sortOrder
      ? a.rule.sortOrder - b.rule.sortOrder
      : a.rule.key < b.rule.key
        ? -1
        : a.rule.key > b.rule.key
          ? 1
          : 0,
  );
  return out;
}
