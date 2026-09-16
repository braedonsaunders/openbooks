import { createHash } from "node:crypto";
import { fromUnits, toUnits } from "../money.ts";
import type { AllocationMode, AllocationRuleTarget, AllocationRuleVersion } from "./types.ts";

/** One machine-readable reason a rule version cannot publish. */
export interface AllocationValidationProblem {
  code: string;
  message: string;
  field?: string;
  targetId?: string;
}

/** A sibling PUBLISHED version of the same rule (effective-window overlap). */
export interface PublishedSiblingWindow {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

/** The driver row a driver-basis version points at, resolved by the service. */
export interface KnownDriver {
  id: string;
  dimension: string;
  isActive: boolean;
}

/**
 * Everything validateRuleVersion needs beyond the version and its targets.
 * The service loads this inside its transaction (siblings, driver row,
 * live posting books); the pure check itself does no I/O.
 */
export interface RuleVersionValidationContext {
  orgId: string;
  ruleId: string;
  mode: AllocationMode;
  /** Other published versions of the same rule (self excluded by the service). */
  publishedVersions: PublishedSiblingWindow[];
  /** Resolved driver row when the version names one; null when it names none. */
  driver?: KnownDriver | null;
  /** Ids of active posts_gl books in the org. */
  activePostingBookIds: string[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const KNOWN_DIMENSIONS = new Set(["department", "location", "class", "project", "subsidiary"]);

function isDimension(dimension: string): boolean {
  return KNOWN_DIMENSIONS.has(dimension) || dimension.startsWith("extra:");
}

function dimensionValueOf(target: AllocationRuleTarget, dimension: string): string | null | undefined {
  switch (dimension) {
    case "department":
      return target.departmentId;
    case "location":
      return target.locationId;
    case "class":
      return target.classId;
    case "project":
      return target.projectId;
    case "subsidiary":
      return target.subsidiaryId;
    default:
      if (dimension.startsWith("extra:")) return target.extraDims?.[dimension.slice("extra:".length)];
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tier-shape check for a stepped basis (no total needed — coverage is a run concern). */
function steppedTierProblems(basisConfig: Record<string, unknown>): string[] {
  const tiers: unknown = basisConfig["tiers"];
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return ["stepped basis needs basis_config.tiers with at least one tier"];
  }
  const problems: string[] = [];
  let prev: bigint | null = null;
  tiers.forEach((tier, index) => {
    const what = `stepped tier ${index + 1}`;
    if (!isRecord(tier)) {
      problems.push(`${what} must be an object`);
      return;
    }
    const upTo: unknown = tier["upTo"];
    if (upTo === null || upTo === undefined) {
      if (index !== tiers.length - 1) problems.push(`open ${what} must be the last tier`);
      return;
    }
    let cap: bigint;
    try {
      cap = toUnits(String(upTo));
    } catch {
      problems.push(`${what} bound is not ledger money: "${String(upTo)}"`);
      return;
    }
    if (cap < 0n) {
      problems.push(`${what} bound is negative: "${String(upTo)}"`);
      return;
    }
    if (prev !== null && cap <= prev) problems.push(`${what} bound must ascend past ${fromUnits(prev)}`);
    prev = cap;
  });
  return problems;
}

function percentProblems(targets: AllocationRuleTarget[]): AllocationValidationProblem[] {
  const problems: AllocationValidationProblem[] = [];
  const remainders = targets.filter((t) => t.isRemainder === true);
  if (remainders.length > 1) {
    problems.push({
      code: "remainder_count",
      message: "at most one target may take the remainder",
      field: "is_remainder",
    });
  }
  let sum = 0n;
  let sumValid = true;
  for (const t of targets) {
    const key = t.id ?? `sequence:${t.sequence}`;
    if (t.isRemainder === true) continue;
    if (t.fixedPercent === null || t.fixedPercent === undefined) {
      problems.push({
        code: "fixed_percent_missing",
        message: `target "${key}" needs a percent on a fixed_percent basis`,
        field: "fixed_percent",
        targetId: t.id,
      });
      sumValid = false;
      continue;
    }
    let units: bigint;
    try {
      units = toUnits(t.fixedPercent);
    } catch {
      problems.push({
        code: "fixed_percent_range",
        message: `target "${key}" percent is not a 4dp number within (0, 100]: "${t.fixedPercent}"`,
        field: "fixed_percent",
        targetId: t.id,
      });
      sumValid = false;
      continue;
    }
    if (units <= 0n || units > 100n * 10_000n) {
      problems.push({
        code: "fixed_percent_range",
        message: `target "${key}" percent must be within (0, 100]: "${t.fixedPercent}"`,
        field: "fixed_percent",
        targetId: t.id,
      });
      sumValid = false;
      continue;
    }
    sum += units;
  }
  if (!sumValid) return problems;
  if (sum > 100n * 10_000n) {
    problems.push({
      code: "fixed_percent_sum",
      message: `fixed percents sum past 100 (${fromUnits(sum)}); refusing to invent money`,
      field: "fixed_percent",
    });
  } else if (remainders.length === 0 && sum < 100n * 10_000n) {
    problems.push({
      code: "fixed_percent_sum",
      message: `fixed percents sum to ${fromUnits(sum)} below 100 with no remainder target; refusing to drop money`,
      field: "fixed_percent",
    });
  }
  return problems;
}

function windowsOverlap(
  aFrom: string,
  aTo: string | null,
  bFrom: string,
  bTo: string | null,
): boolean {
  // Closed intervals; a null end is unbounded.
  return aFrom <= (bTo ?? "9999-12-31") && bFrom <= (aTo ?? "9999-12-31");
}

/**
 * Mode-specific, basis, impact, residual, book-scope and overlap checks for
 * one rule version. Returns typed problems; an empty array means the version
 * may publish. Drafts may carry problems — only publish refuses them.
 */
export function validateRuleVersion(
  version: AllocationRuleVersion,
  targets: AllocationRuleTarget[],
  ctx: RuleVersionValidationContext,
): AllocationValidationProblem[] {
  const problems: AllocationValidationProblem[] = [];

  if (!DATE_PATTERN.test(version.effectiveFrom)) {
    problems.push({
      code: "effective_window",
      message: `effective_from is not a date: "${version.effectiveFrom}"`,
      field: "effectiveFrom",
    });
  }
  if (version.effectiveTo !== null && version.effectiveTo !== undefined) {
    if (!DATE_PATTERN.test(version.effectiveTo)) {
      problems.push({
        code: "effective_window",
        message: `effective_to is not a date: "${version.effectiveTo}"`,
        field: "effectiveTo",
      });
    } else if (version.effectiveTo < version.effectiveFrom) {
      problems.push({
        code: "effective_window",
        message: "effective_to must be on or after effective_from",
        field: "effectiveTo",
      });
    }
  }
  for (const sib of ctx.publishedVersions) {
    if (sib.id === version.id) continue;
    if (windowsOverlap(version.effectiveFrom, version.effectiveTo ?? null, sib.effectiveFrom, sib.effectiveTo)) {
      problems.push({
        code: "effective_overlap",
        message: `effective window overlaps published version ${sib.id} (${sib.effectiveFrom}..${sib.effectiveTo ?? "open"})`,
        field: "effectiveFrom",
      });
      break;
    }
  }

  if (version.bookScope === "books") {
    const ids = Array.isArray(version.bookIds) ? version.bookIds : [];
    if (ids.length === 0) {
      problems.push({
        code: "book_scope",
        message: "book_scope 'books' needs at least one book id",
        field: "bookIds",
      });
    } else {
      const live = new Set(ctx.activePostingBookIds);
      const outside = ids.filter((id) => !live.has(id));
      if (outside.length > 0) {
        problems.push({
          code: "book_scope",
          message: `book_scope 'books' names books that are not active posting books: ${outside.join(", ")}`,
          field: "bookIds",
        });
      }
    }
  }

  if (ctx.mode === "entry") {
    if (version.applyPolicy !== "automatic" && version.applyPolicy !== "suggest" && version.applyPolicy !== "manual") {
      problems.push({
        code: "apply_policy",
        message: `entry mode needs an apply policy (automatic, suggest, manual): "${version.applyPolicy}"`,
        field: "applyPolicy",
      });
    }
    if (version.targetKind === "explicit" && targets.length === 0) {
      problems.push({
        code: "targets_empty",
        message: "entry mode needs explicit targets or a dynamic target population",
        field: "targetKind",
      });
    }
  }
  if (ctx.mode === "period") {
    if (version.sourceMeasure !== "period_activity" && version.sourceMeasure !== "period_end_balance" && version.sourceMeasure !== "ytd_activity") {
      problems.push({
        code: "source_measure",
        message: `period mode needs a source measure: "${version.sourceMeasure}"`,
        field: "sourceMeasure",
      });
    }
  }

  if (version.targetKind === "explicit") {
    if (targets.length === 0) {
      problems.push({
        code: "targets_empty",
        message: "explicit target kind needs at least one target",
        field: "targetKind",
      });
    }
    const sequences = new Set<number>();
    for (const t of targets) {
      if (sequences.has(t.sequence)) {
        problems.push({
          code: "target_sequence",
          message: `duplicate target sequence: ${t.sequence}`,
          field: "sequence",
          targetId: t.id,
        });
      }
      sequences.add(t.sequence);
    }
  } else {
    const dimension: unknown = version.dynamicTarget?.dimension;
    if (typeof dimension !== "string" || dimension === "") {
      problems.push({
        code: "dynamic_dimension",
        message: "dynamic targets need a dimension",
        field: "dynamicTarget",
      });
    } else if (!isDimension(dimension)) {
      problems.push({
        code: "dynamic_dimension",
        message: `unknown dynamic target dimension: "${dimension}"`,
        field: "dynamicTarget",
      });
    }
    const minWeight: unknown = version.dynamicTarget?.minWeight;
    if (minWeight !== undefined && minWeight !== null) {
      const parsed = Number(String(minWeight));
      if (!Number.isFinite(parsed) || parsed < 0) {
        problems.push({
          code: "dynamic_min_weight",
          message: `dynamic minWeight must be a non-negative decimal: "${String(minWeight)}"`,
          field: "dynamicTarget",
        });
      }
    }
    const include = version.dynamicTarget?.include ?? [];
    const exclude = version.dynamicTarget?.exclude ?? [];
    if (include.some((id) => exclude.includes(id))) {
      problems.push({
        code: "dynamic_include_exclude",
        message: "dynamic target include and exclude must not share values",
        field: "dynamicTarget",
      });
    }
  }

  if (version.basisKind === "fixed_percent" && version.targetKind === "explicit") {
    problems.push(...percentProblems(targets));
  } else if (version.basisKind === "driver") {
    if (version.driverId === null || version.driverId === undefined) {
      problems.push({ code: "driver_missing", message: "driver basis needs a driver", field: "driverId" });
    } else if (ctx.driver === null || ctx.driver === undefined) {
      problems.push({
        code: "driver_unknown",
        message: `driver does not exist in this organization: "${version.driverId}"`,
        field: "driverId",
      });
    } else {
      if (!ctx.driver.isActive) {
        problems.push({ code: "driver_inactive", message: `driver "${ctx.driver.id}" is not active`, field: "driverId" });
      }
      const dimension = ctx.driver.dimension;
      if (!isDimension(dimension)) {
        problems.push({
          code: "driver_dimension",
          message: `driver "${ctx.driver.id}" has an unknown dimension: "${dimension}"`,
          field: "driverId",
        });
      } else if (version.targetKind === "dynamic") {
        if (String(version.dynamicTarget?.dimension ?? "") !== dimension) {
          problems.push({
            code: "driver_dimension",
            message: `driver dimension "${dimension}" does not match the dynamic target dimension "${version.dynamicTarget?.dimension ?? ""}"`,
            field: "dynamicTarget",
          });
        }
      } else {
        for (const t of targets) {
          if (dimensionValueOf(t, dimension) === null || dimensionValueOf(t, dimension) === undefined) {
            problems.push({
              code: "driver_dimension",
              message: `target "${t.id ?? `sequence:${t.sequence}`}" carries no ${dimension} value for the driver`,
              field: dimension,
              targetId: t.id,
            });
          }
        }
      }
    }
  } else if (version.basisKind === "stepped") {
    for (const message of steppedTierProblems(isRecord(version.basisConfig) ? version.basisConfig : {})) {
      problems.push({ code: "stepped_tiers", message, field: "basisConfig" });
    }
  }

  if (version.offsetAccountId !== null && version.offsetAccountId !== undefined && version.impact !== "reclass") {
    problems.push({
      code: "offset_impact",
      message: `offset account only applies to reclass impact, not ${version.impact}`,
      field: "offsetAccountId",
    });
  }

  if (version.residualPolicy === "explicit_target") {
    if (version.residualTargetId === null || version.residualTargetId === undefined) {
      problems.push({
        code: "residual_target",
        message: "explicit_target residual policy needs a residual target",
        field: "residualTargetId",
      });
    } else if (version.targetKind === "explicit" && !targets.some((t) => t.id === version.residualTargetId)) {
      problems.push({
        code: "residual_target",
        message: `explicit residual target does not exist: "${version.residualTargetId}"`,
        field: "residualTargetId",
      });
    }
  }

  return problems;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/** 4dp-canonical form for numeric target columns (DB numeric pads on read). */
function canonicalDecimal(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  try {
    return fromUnits(toUnits(value));
  } catch {
    return value;
  }
}

function sortedStrings(value: unknown): unknown {
  return Array.isArray(value) ? [...value].map(String).sort() : value;
}

/**
 * sha256 over the canonical JSON of a version plus its targets (targets by
 * sequence, sets sorted, numerics in 4dp canonical form). Stable across
 * insert order and across a numeric write/read round-trip, so publish can
 * stamp it and any later reader can recompute it from the frozen row.
 */
export function definitionHash(version: AllocationRuleVersion, targets: AllocationRuleTarget[]): string {
  const dimensionFilters: Record<string, unknown> = isRecord(version.dimensionFilters) ? { ...version.dimensionFilters } : {};
  for (const [key, value] of Object.entries(dimensionFilters)) {
    if (Array.isArray(value)) dimensionFilters[key] = sortedStrings(value);
    else if (isRecord(value)) {
      const inner: Record<string, unknown> = {};
      for (const [ik, iv] of Object.entries(value)) inner[ik] = Array.isArray(iv) ? sortedStrings(iv) : iv;
      dimensionFilters[key] = inner;
    }
  }
  const accountScope: Record<string, unknown> = isRecord(version.accountScope) ? { ...version.accountScope } : {};
  if (Array.isArray(accountScope["accountIds"])) accountScope["accountIds"] = sortedStrings(accountScope["accountIds"]);
  const dynamicTarget: Record<string, unknown> = isRecord(version.dynamicTarget)
    ? { ...(version.dynamicTarget as Record<string, unknown>) }
    : {};
  if (Array.isArray(dynamicTarget["include"])) dynamicTarget["include"] = sortedStrings(dynamicTarget["include"]);
  if (Array.isArray(dynamicTarget["exclude"])) dynamicTarget["exclude"] = sortedStrings(dynamicTarget["exclude"]);

  const definition = {
    ruleId: version.ruleId,
    versionNo: version.versionNo,
    effectiveFrom: version.effectiveFrom,
    effectiveTo: version.effectiveTo ?? null,
    bookScope: version.bookScope,
    bookIds: sortedStrings(version.bookIds ?? []),
    documentKinds: version.documentKinds === null || version.documentKinds === undefined ? null : sortedStrings(version.documentKinds),
    accountScope,
    dimensionFilters,
    applyPolicy: version.applyPolicy,
    sourceMeasure: version.sourceMeasure,
    basisKind: version.basisKind,
    driverId: version.driverId ?? null,
    driverAsOf: version.driverAsOf,
    basisConfig: version.basisConfig ?? {},
    targetKind: version.targetKind,
    dynamicTarget,
    impact: version.impact,
    offsetAccountId: version.offsetAccountId ?? null,
    residualPolicy: version.residualPolicy,
    residualTargetId: version.residualTargetId ?? null,
    solveMethod: version.solveMethod,
    runPolicy: version.runPolicy,
    runOffsetDays: version.runOffsetDays,
    approvalFlowId: version.approvalFlowId ?? null,
    memoTemplate: version.memoTemplate ?? null,
    lineDescriptionTemplate: version.lineDescriptionTemplate ?? null,
    targets: [...targets]
      .sort((a, b) => a.sequence - b.sequence)
      .map((t) => ({
        sequence: t.sequence,
        targetAccountId: t.targetAccountId ?? null,
        departmentId: t.departmentId ?? null,
        locationId: t.locationId ?? null,
        classId: t.classId ?? null,
        projectId: t.projectId ?? null,
        subsidiaryId: t.subsidiaryId ?? null,
        extraDims: t.extraDims ?? {},
        fixedPercent: canonicalDecimal(t.fixedPercent),
        weight: canonicalDecimal(t.weight),
        isRemainder: t.isRemainder ?? false,
        label: t.label ?? null,
      })),
  };
  return createHash("sha256").update(JSON.stringify(canonicalize(definition))).digest("hex");
}
