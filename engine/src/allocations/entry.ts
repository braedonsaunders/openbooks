import { randomUUID } from "node:crypto";
import { fromUnits, normalizeDecimal, roundDiv, toUnits } from "../money.ts";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { listRulesInEffect, selectRule } from "./match.ts";
import type {
  AllocationMode,
  AllocationRuleTarget,
  AllocationRuleVersion,
  DriverVector,
  LineCoordinate,
  RuleInEffect,
} from "./types.ts";

/**
 * Allocation kernel, entry mode (shard A4).
 *
 * `explodeDocumentLine` turns one entered line into child drafts; pure and
 * exact (bigint money, never floats). `planEntryDistributions` decides, per
 * submitted line, whether to explode (explicit key or automatic match),
 * regenerate an edited group, keep a locked/unchanged group, or collapse an
 * un-split request. Both are pure: the web save path (and the import writer)
 * does the rule loading and lineage persistence around them.
 *
 * Amount apportionment here is a local exact fallback until A1's
 * `apportion()` lands; its contract (relative weights, rounding residual to
 * the residual-policy target) intentionally mirrors the kernel design so the
 * swap is mechanical.
 */

export type EntryAllocationErrorCode =
  | "unknown_key"
  | "misconfigured_rule"
  | "unsupported_basis"
  | "no_driver_weight"
  | "invalid_line";

export class EntryAllocationError extends Error {
  code: EntryAllocationErrorCode;
  constructor(code: EntryAllocationErrorCode, message: string) {
    super(message);
    this.name = "EntryAllocationError";
    this.code = code;
  }
}

/** One submitted line plus the entry-mode request fields. */
export interface EntryLineInput {
  accountId: string;
  amount: string;
  quantity?: string | null;
  unit?: string | null;
  unitPrice?: string | null;
  itemId?: string | null;
  description?: string | null;
  taxCodeId?: string | null;
  taxGroupId?: string | null;
  partyId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  subsidiaryId?: string | null;
  stockLocationId?: string | null;
  extraDims?: Record<string, string>;
  custom?: Record<string, unknown>;
  isBillable?: boolean | null;
  /** Rule key for an explicit explode request; wins over matching and groups. */
  distributionKey?: string | null;
  /** Stored group this submitted line belongs to (re-save matching). */
  distributionGroupId?: string | null;
  /** Hand-edited children are never regenerated. */
  distributionLocked?: boolean | null;
}

export interface EntryDocumentContext {
  kind: string;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  subsidiaryId?: string | null;
  extraDims?: Record<string, string>;
  /** Stored groups collapsing back to one line each. */
  unsplitDistributionGroups?: string[];
}

/** A planned output line: stamps resolved, request key consumed. */
export interface PlannedEntryLine {
  accountId: string;
  amount: string;
  quantity: string | null;
  unit: string | null;
  unitPrice: string | null;
  itemId: string | null;
  description: string | null;
  taxCodeId: string | null;
  taxGroupId: string | null;
  partyId: string | null;
  departmentId: string | null;
  projectId: string | null;
  locationId: string | null;
  classId: string | null;
  subsidiaryId: string | null;
  stockLocationId: string | null;
  extraDims: Record<string, string>;
  custom: Record<string, unknown>;
  isBillable: boolean | null;
  distributionGroupId: string | null;
  distributionRuleId: string | null;
  distributionVersionId: string | null;
  distributionLocked: boolean;
}

/** Lineage before ids are known; the caller stamps document/child ids. */
export interface PlannedEntryLineage {
  ruleId: string;
  versionId: string;
  definitionHash: string;
  driverId?: string | null;
  driverValue?: string | null;
  driverTotal?: string | null;
  share?: string | null;
  amount: string;
  residual: string;
  /** Index into the plan's lines; the caller maps it to the inserted row id. */
  targetLineIndex: number;
  /** Replaced stored child (regenerations); null on a fresh explode — the
   * entered parent line is ephemeral, replaced wholesale, so entry lineage
   * anchors on the document plus the new child. */
  sourceDocumentLineId?: string | null;
}

/** Stored-group snapshot the caller loads for re-save matching. */
export interface StoredEntryGroup {
  groupId: string;
  ruleId: string;
  versionId: string;
  locked: boolean;
  /** Exact Σ of the stored members' amounts. */
  total: string;
  /** Stored child ids; the first anchors regeneration lineage. */
  memberIds: string[];
}

export interface ExplodeOptions {
  driverVector?: DriverVector;
  /** Dimension the driver vector is keyed by (explicit driver-basis targets). */
  driverDimension?: string;
  /** Materialize dynamic targets (dimension values with weight > minWeight). */
  resolveDynamicTargets?: (
    version: AllocationRuleVersion,
    line: EntryLineInput,
  ) => AllocationRuleTarget[];
  /** Injected for deterministic tests; defaults to a random UUID. */
  groupId?: string;
}

export interface ExplodeResult {
  children: PlannedEntryLine[];
  /** Per-child apportionment evidence, aligned with children. */
  apportionments: { share: string; amount: string; residual: string; driverValue: string | null }[];
  /** Σ of the driver vector behind a driver basis (null otherwise). */
  driverTotal: string | null;
}

export interface PlanOptions {
  /** Explicit-key rules resolved by the caller (key → rule in effect). */
  explicitRules?: Map<string, RuleInEffect>;
  driverVectors?: Map<string, DriverVector>;
  driverDimensions?: Map<string, string>;
  resolveDynamicTargets?: ExplodeOptions["resolveDynamicTargets"];
  resolveAccountGroup?: (dimension: string, groupKey: string) => Set<string>;
  /** Stored groups of the document, for re-save matching. */
  existingGroups?: Map<string, StoredEntryGroup>;
  /** Injected for deterministic tests; defaults to random UUIDs. */
  newGroupId?: () => string;
}

export interface EntryPlan {
  lines: PlannedEntryLine[];
  lineage: PlannedEntryLineage[];
  /** True when the line set structurally changed (explode/regenerate/collapse). */
  exploded: boolean;
}

export type KeyedEntryRuleLookup =
  | { status: "not_found" }
  | { status: "wrong_mode"; mode: AllocationMode }
  | { status: "inactive" }
  | { status: "ok"; rule: RuleInEffect };

/**
 * Resolve one explicit distributionKey for the entry path, distinguishing an
 * unknown key from a rule that exists but cannot fire here (wrong mode, or
 * inactive / no published version in effect) so the save error says exactly
 * which. Only entry-mode rules can explode document lines.
 */
export async function loadEntryRuleByKey(
  orgId: string,
  key: string,
  asOf?: string,
): Promise<KeyedEntryRuleLookup> {
  const head = (
    await db.execute<{ mode: string }>(sql`
      select mode from allocation_rules where org_id = ${orgId} and key = ${key} limit 1
    `)
  ).rows[0];
  if (!head) return { status: "not_found" };
  if (head.mode !== "entry") return { status: "wrong_mode", mode: head.mode as AllocationMode };
  const rules = await listRulesInEffect({ orgId, mode: "entry", asOf });
  const rule = rules.find((candidate) => candidate.rule.key === key) ?? null;
  if (rule === null) return { status: "inactive" };
  return { status: "ok", rule };
}

const WEIGHT_SCALE = 10_000_000_000n;
const SHARE_SCALE = 10_000_000_000n;

function parseWeight(value: string, what: string): bigint {
  let normalized: string;
  try {
    normalized = normalizeDecimal(value, 10);
  } catch {
    throw new EntryAllocationError("misconfigured_rule", `${what} "${value}" is not an exact decimal`);
  }
  const negative = normalized.startsWith("-");
  const digits = normalized.replace("-", "").replace(".", "");
  const units = BigInt(digits);
  if (units < 0n) throw new EntryAllocationError("misconfigured_rule", `${what} must not be negative`);
  return negative ? -units : units;
}

function formatScaled(units: bigint, places: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = 10n ** BigInt(places);
  return `${negative ? "-" : ""}${abs / base}.${(abs % base).toString().padStart(places, "0")}`;
}

/**
 * Exact apportionment of one total across relative weights: every share is
 * rounded half-away-from-zero and the rounding remainder lands on the
 * residual-policy target, so the parts always sum to the total.
 */
function apportionExact(
  totalUnits: bigint,
  weights: bigint[],
  residualIndex: number,
): { amounts: bigint[]; residual: bigint } {
  const weightTotal = weights.reduce((acc, w) => acc + w, 0n);
  if (weightTotal <= 0n) {
    throw new EntryAllocationError("no_driver_weight", "allocation weights sum to zero — nothing to apportion to");
  }
  const amounts = weights.map((w) => roundDiv(totalUnits * w, weightTotal));
  const placed = amounts.reduce((acc, a) => acc + a, 0n);
  const residual = totalUnits - placed;
  amounts[residualIndex]! += residual;
  return { amounts, residual };
}

function moneyUnits(amount: string): bigint {
  try {
    return toUnits(amount);
  } catch {
    throw new EntryAllocationError("invalid_line", `line amount "${amount}" is not exact ledger money`);
  }
}

function parseQuantity(value: string): bigint {
  try {
    return BigInt(normalizeDecimal(value, 8).replace("-", "").replace(".", "")) * (value.trim().startsWith("-") ? -1n : 1n);
  } catch {
    throw new EntryAllocationError("invalid_line", `line quantity "${value}" is not an exact decimal`);
  }
}

function targetValueInDimension(target: AllocationRuleTarget, dimension: string): string | null | undefined {
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
    default: {
      if (dimension.startsWith("extra:")) {
        return target.extraDims?.[dimension.slice("extra:".length)] ?? null;
      }
      return null;
    }
  }
}

interface WeightedTarget {
  target: AllocationRuleTarget;
  weight: bigint;
}

function fixedPercentWeights(targets: AllocationRuleTarget[]): WeightedTarget[] {
  const remainders = targets.filter((t) => t.isRemainder);
  if (remainders.length > 1) {
    throw new EntryAllocationError("misconfigured_rule", "at most one target may take the remainder");
  }
  const explicit = targets.filter((t) => !t.isRemainder);
  const weighted = explicit.map((t) => {
    if (t.fixedPercent === null || t.fixedPercent === undefined) {
      throw new EntryAllocationError(
        "misconfigured_rule",
        `target "${t.label ?? t.id}" needs a fixed percent or the remainder flag`,
      );
    }
    return { target: t, weight: parseWeight(t.fixedPercent, "fixed percent") };
  });
  const explicitTotal = weighted.reduce((acc, w) => acc + w.weight, 0n);
  if (explicitTotal > 100n * WEIGHT_SCALE) {
    throw new EntryAllocationError("misconfigured_rule", "fixed percents sum to more than 100");
  }
  if (remainders.length === 1) {
    return [...weighted, { target: remainders[0]!, weight: 100n * WEIGHT_SCALE - explicitTotal }];
  }
  if (explicitTotal === 0n) {
    throw new EntryAllocationError("misconfigured_rule", "fixed percents sum to zero — nothing to apportion to");
  }
  // No remainder and under 100: weights are relative, so the children still
  // sum to the entered amount (the entry-mode no-lost-cent invariant).
  return weighted;
}

function driverWeights(
  targets: AllocationRuleTarget[],
  opts: ExplodeOptions,
): { weighted: WeightedTarget[]; driverTotal: string | null } {
  const vector = opts.driverVector;
  const weighted = targets.map((t) => {
    let weight = "0";
    if (t.weight !== null && t.weight !== undefined) {
      weight = t.weight;
    } else if (vector && opts.driverDimension) {
      weight = vector.get(targetValueInDimension(t, opts.driverDimension) ?? "") ?? "0";
    }
    return { target: t, weight: parseWeight(weight, "driver weight") };
  });
  let driverTotal: string | null = null;
  if (vector) {
    try {
      let total = 0n;
      for (const value of vector.values()) total += parseWeight(value, "driver value");
      driverTotal = formatScaled(total / (WEIGHT_SCALE / 10000n), 4);
    } catch {
      driverTotal = null;
    }
  }
  return { weighted, driverTotal };
}

function residualIndexFor(targets: AllocationRuleTarget[], weights: bigint[], version: AllocationRuleVersion): number {
  switch (version.residualPolicy) {
    case "first_target":
      return 0;
    case "last_target":
      return targets.length - 1;
    case "explicit_target": {
      const index = targets.findIndex((t) => t.id === version.residualTargetId);
      if (index === -1) {
        throw new EntryAllocationError(
          "misconfigured_rule",
          "the residual target does not name one of this version's targets",
        );
      }
      return index;
    }
    case "largest_share": {
      let best = 0;
      for (let i = 1; i < weights.length; i++) {
        if (weights[i]! > weights[best]!) best = i;
      }
      return best;
    }
  }
}

/** Minimal mustache-style renderer for entry presentation templates. */
export function renderAllocationTemplate(
  template: string,
  vars: Record<string, Record<string, string | null | undefined> | string | null | undefined>,
): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (placeholder, path: string) => {
    const parts = String(path).split(".");
    let current: unknown = vars;
    for (const part of parts) {
      if (current === null || current === undefined || typeof current !== "object") return placeholder;
      current = (current as Record<string, unknown>)[part];
    }
    return current === null || current === undefined ? placeholder : String(current);
  });
}

/**
 * Explode one entered line across a rule's targets. Amount is apportioned
 * exactly; quantity (when the line carries one) is apportioned proportionally
 * at 8dp; economics (item, description, tax, party, billing flags, custom)
 * are inherited; target account/dimensions override.
 */
export function explodeDocumentLine(
  line: EntryLineInput,
  ruleInEffect: RuleInEffect,
  opts: ExplodeOptions = {},
): ExplodeResult {
  const { version } = ruleInEffect;
  if (version.basisKind === "stepped") {
    throw new EntryAllocationError(
      "unsupported_basis",
      `rule "${ruleInEffect.rule.key}" uses a stepped basis, which entry-mode explosion does not support`,
    );
  }

  let targets: AllocationRuleTarget[];
  if (version.targetKind === "dynamic") {
    if (!opts.resolveDynamicTargets) {
      throw new EntryAllocationError(
        "misconfigured_rule",
        `rule "${ruleInEffect.rule.key}" has dynamic targets but no resolver was provided`,
      );
    }
    targets = [...opts.resolveDynamicTargets(version, line)].sort((a, b) => a.sequence - b.sequence);
    if (targets.length === 0) {
      throw new EntryAllocationError(
        "no_driver_weight",
        `rule "${ruleInEffect.rule.key}" resolved to no targets — nothing to apportion to`,
      );
    }
  } else {
    targets = [...ruleInEffect.targets].sort((a, b) => a.sequence - b.sequence);
    if (targets.length === 0) {
      throw new EntryAllocationError(
        "misconfigured_rule",
        `rule "${ruleInEffect.rule.key}" has no targets to explode into`,
      );
    }
  }

  let weighted: WeightedTarget[];
  let driverTotal: string | null = null;
  if (version.basisKind === "driver") {
    const resolved = driverWeights(
      version.targetKind === "dynamic"
        ? targets.map((t) => ({ ...t, weight: t.weight ?? "0" }))
        : targets,
      opts,
    );
    weighted = resolved.weighted;
    driverTotal = resolved.driverTotal;
  } else {
    weighted = fixedPercentWeights(targets);
  }

  const weights = weighted.map((w) => w.weight);
  const ordered = weighted.map((w) => w.target);
  const residualIdx = residualIndexFor(ordered, weights, version);

  const totalUnits = moneyUnits(line.amount);
  const { amounts, residual } = apportionExact(totalUnits, weights, residualIdx);

  let quantities: bigint[] | null = null;
  if (line.quantity !== null && line.quantity !== undefined) {
    const qtyUnits = parseQuantity(line.quantity);
    quantities = apportionExact(qtyUnits, weights, residualIdx).amounts;
  }

  const groupId = opts.groupId ?? randomUUID();
  const children: PlannedEntryLine[] = ordered.map((t, i) => ({
    accountId: t.targetAccountId ?? line.accountId,
    amount: fromUnits(amounts[i]!),
    quantity: quantities === null ? null : formatScaled(quantities[i]!, 8),
    unit: line.unit ?? null,
    unitPrice: line.unitPrice ?? null,
    itemId: line.itemId ?? null,
    description:
      version.lineDescriptionTemplate !== null && version.lineDescriptionTemplate !== undefined
        ? renderAllocationTemplate(version.lineDescriptionTemplate, {
            rule: { key: ruleInEffect.rule.key, name: ruleInEffect.rule.name },
            target: { label: t.label, sequence: String(t.sequence) },
          })
        : (line.description ?? null),
    taxCodeId: line.taxCodeId ?? null,
    taxGroupId: line.taxGroupId ?? null,
    partyId: line.partyId ?? null,
    departmentId: t.departmentId ?? line.departmentId ?? null,
    projectId: t.projectId ?? line.projectId ?? null,
    locationId: t.locationId ?? line.locationId ?? null,
    classId: t.classId ?? line.classId ?? null,
    subsidiaryId: t.subsidiaryId ?? line.subsidiaryId ?? null,
    stockLocationId: line.stockLocationId ?? null,
    extraDims: { ...(line.extraDims ?? {}), ...(t.extraDims ?? {}) },
    custom: line.custom ?? {},
    isBillable: line.isBillable ?? null,
    distributionGroupId: groupId,
    distributionRuleId: ruleInEffect.rule.id,
    distributionVersionId: version.id,
    distributionLocked: false,
  }));

  const isDriverBasis = version.basisKind === "driver";
  const apportionments = ordered.map((_, i) => ({
    share:
      totalUnits === 0n
        ? "0.0000000000"
        : formatScaled(
            roundDiv((amounts[i]! < 0n ? -amounts[i]! : amounts[i]!) * SHARE_SCALE, totalUnits < 0n ? -totalUnits : totalUnits),
            10,
          ),
    amount: fromUnits(amounts[i]!),
    residual: i === residualIdx ? fromUnits(residual) : "0.0000",
    driverValue: isDriverBasis ? formatScaled(weights[i]! / (WEIGHT_SCALE / 10000n), 4) : null,
  }));

  return { children, apportionments, driverTotal };
}

function plainLine(line: EntryLineInput): PlannedEntryLine {
  return {
    accountId: line.accountId,
    amount: line.amount,
    quantity: line.quantity ?? null,
    unit: line.unit ?? null,
    unitPrice: line.unitPrice ?? null,
    itemId: line.itemId ?? null,
    description: line.description ?? null,
    taxCodeId: line.taxCodeId ?? null,
    taxGroupId: line.taxGroupId ?? null,
    partyId: line.partyId ?? null,
    departmentId: line.departmentId ?? null,
    projectId: line.projectId ?? null,
    locationId: line.locationId ?? null,
    classId: line.classId ?? null,
    subsidiaryId: line.subsidiaryId ?? null,
    stockLocationId: line.stockLocationId ?? null,
    extraDims: { ...(line.extraDims ?? {}) },
    custom: line.custom ?? {},
    isBillable: line.isBillable ?? null,
    distributionGroupId: null,
    distributionRuleId: null,
    distributionVersionId: null,
    distributionLocked: false,
  };
}

function keptMember(line: EntryLineInput, stored: StoredEntryGroup): PlannedEntryLine {
  const planned = plainLine(line);
  planned.distributionGroupId = stored.groupId;
  planned.distributionRuleId = stored.ruleId;
  planned.distributionVersionId = stored.versionId;
  // Tri-state: an explicit true locks, an explicit false unlocks (the line
  // grid's unlock affordance), an absent flag preserves the stored group
  // value. Locking is group-level (any locked child locks the group).
  planned.distributionLocked =
    line.distributionLocked === true ? true : line.distributionLocked === false ? false : stored.locked;
  return planned;
}

function effectiveCoordinate(doc: EntryDocumentContext, line: EntryLineInput): LineCoordinate {
  return {
    accountId: line.accountId,
    subsidiaryId: line.subsidiaryId ?? doc.subsidiaryId ?? null,
    departmentId: line.departmentId ?? doc.departmentId ?? null,
    locationId: line.locationId ?? doc.locationId ?? null,
    classId: line.classId ?? doc.classId ?? null,
    projectId: line.projectId ?? doc.projectId ?? null,
    partyId: line.partyId ?? null,
    extraDims: { ...(doc.extraDims ?? {}), ...(line.extraDims ?? {}) },
    documentKind: doc.kind,
    itemId: line.itemId ?? null,
    amount: line.amount,
  };
}

function sumMoney(amounts: string[]): string {
  let total = 0n;
  for (const amount of amounts) total += moneyUnits(amount);
  return fromUnits(total);
}

function toLineage(
  rule: RuleInEffect,
  result: ExplodeResult,
  baseIndex: number,
  sourceDocumentLineId: string | null,
): PlannedEntryLineage[] {
  return result.apportionments.map((a, i) => ({
    ruleId: rule.rule.id,
    versionId: rule.version.id,
    definitionHash: rule.version.definitionHash ?? "",
    driverId: rule.version.driverId,
    driverValue: a.driverValue,
    driverTotal: result.driverTotal,
    share: a.share,
    amount: a.amount,
    residual: a.residual,
    targetLineIndex: baseIndex + i,
    sourceDocumentLineId,
  }));
}

/**
 * Decide the fate of every submitted line: explicit distributionKey wins and
 * explodes; otherwise an automatic matching rule explodes (a misconfigured
 * automatic rule leaves the line plain rather than breaking the save);
 * members of a stored group regenerate when their submitted sum changed and
 * neither side locked them; locked or unchanged groups are kept; un-split
 * requests collapse to one line at the first member's coordinates.
 */
export function planEntryDistributions(
  doc: EntryDocumentContext,
  lines: EntryLineInput[],
  rulesInEffect: RuleInEffect[],
  opts: PlanOptions = {},
): EntryPlan {
  const existingGroups = opts.existingGroups ?? new Map<string, StoredEntryGroup>();
  const explicitRules = opts.explicitRules ?? new Map<string, RuleInEffect>();
  const unsplit = new Set(doc.unsplitDistributionGroups ?? []);
  const mintGroupId = opts.newGroupId ?? (() => randomUUID());

  const memberIndicesByGroup = new Map<string, number[]>();
  lines.forEach((line, index) => {
    if (line.distributionKey !== null && line.distributionKey !== undefined && line.distributionKey !== "") return;
    const groupId = line.distributionGroupId;
    if (groupId !== null && groupId !== undefined && groupId !== "" && !unsplit.has(groupId)) {
      const list = memberIndicesByGroup.get(groupId) ?? [];
      list.push(index);
      memberIndicesByGroup.set(groupId, list);
    }
  });

  const lineage: PlannedEntryLineage[] = [];
  let exploded = false;

  const output: PlannedEntryLine[] = [];
  const handled = new Array(lines.length).fill(false) as boolean[];

  lines.forEach((line, index) => {
    const key = line.distributionKey;
    if (key !== null && key !== undefined && key !== "") {
      const rule = explicitRules.get(key) ?? rulesInEffect.find((r) => r.rule.key === key) ?? null;
      if (rule === null) {
        throw new EntryAllocationError("unknown_key", `distributionKey "${key}" does not match a rule in effect`);
      }
      const result = explodeDocumentLine(line, rule, {
        driverVector: opts.driverVectors?.get(rule.rule.id),
        driverDimension: opts.driverDimensions?.get(rule.rule.id),
        resolveDynamicTargets: opts.resolveDynamicTargets,
        groupId: mintGroupId(),
      });
      const base = output.length;
      output.push(...result.children);
      lineage.push(...toLineage(rule, result, base, null));
      handled[index] = true;
      exploded = true;
    }
  });

  // Collapse requests first: one line per group at the first member's coordinates.
  const collapsedGroups = new Set<string>();
  lines.forEach((line, index) => {
    const groupId = line.distributionGroupId;
    if (groupId === null || groupId === undefined || groupId === "" || !unsplit.has(groupId)) return;
    if (collapsedGroups.has(groupId)) {
      handled[index] = true;
      return;
    }
    collapsedGroups.add(groupId);
    const members = lines
      .map((candidate, i) => ({ candidate: candidate!, i }))
      .filter(({ candidate }) => candidate.distributionGroupId === groupId && !candidate.distributionKey);
    const first = members[0]!.candidate;
    const total = sumMoney(members.map(({ candidate }) => candidate.amount));
    let quantity: string | null = null;
    if (members.every(({ candidate }) => candidate.quantity !== null && candidate.quantity !== undefined)) {
      let qtyTotal = 0n;
      for (const { candidate } of members) qtyTotal += parseQuantity(candidate.quantity!);
      quantity = formatScaled(qtyTotal, 8);
    }
    const collapsed: PlannedEntryLine = {
      ...plainLine({ ...first, amount: total, quantity }),
      amount: total,
      quantity,
    };
    output.push(collapsed);
    handled[index] = true;
    exploded = true;
  });

  // Stored-group members: regenerate on sum change, else keep.
  for (const [groupId, indices] of memberIndicesByGroup) {
    const stored = existingGroups.get(groupId);
    if (stored === undefined) {
      // Unknown group: strip the stamps and match each member fresh below.
      for (const i of indices) {
        const stripped: EntryLineInput = { ...lines[i]!, distributionGroupId: null, distributionLocked: null };
        lines[i] = stripped;
      }
      continue;
    }
    const members = indices.map((i) => lines[i]!);
    const locked = members.some((m) => m.distributionLocked === true)
      ? true
      : members.some((m) => m.distributionLocked === false)
        ? false
        : stored.locked;
    const submittedTotal = sumMoney(members.map((m) => m.amount));
    if (locked || submittedTotal === stored.total) {
      members.forEach((member, k) => {
        output.push(keptMember(member, { ...stored, locked }));
        handled[indices[k]!] = true;
      });
      continue;
    }
    const rule = rulesInEffect.find((r) => r.rule.id === stored.ruleId) ?? null;
    if (rule === null) {
      // The producing rule is gone: keep the submitted lines as-is rather
      // than destroying the user's edit.
      members.forEach((member, k) => {
        output.push(keptMember(member, stored));
        handled[indices[k]!] = true;
      });
      continue;
    }
    const first = members[0]!;
    let quantity: string | null = null;
    if (members.every((m) => m.quantity !== null && m.quantity !== undefined)) {
      let qtyTotal = 0n;
      for (const m of members) qtyTotal += parseQuantity(m.quantity!);
      quantity = formatScaled(qtyTotal, 8);
    }
    const result = explodeDocumentLine({ ...first, amount: submittedTotal, quantity }, rule, {
      driverVector: opts.driverVectors?.get(rule.rule.id),
      driverDimension: opts.driverDimensions?.get(rule.rule.id),
      resolveDynamicTargets: opts.resolveDynamicTargets,
      groupId,
    });
    const base = output.length;
    output.push(...result.children);
    lineage.push(...toLineage(rule, result, base, stored.memberIds[0] ?? null));
    for (const i of indices) handled[i] = true;
    exploded = true;
  }

  // Everything left: automatic match or plain.
  lines.forEach((line, index) => {
    if (handled[index]) return;
    const coordinate = effectiveCoordinate(doc, line);
    const rule = selectRule(rulesInEffect, coordinate, {
      applyPolicy: "automatic",
      resolveAccountGroup: opts.resolveAccountGroup,
    });
    if (rule === null) {
      output.push(plainLine(line));
      return;
    }
    try {
      const result = explodeDocumentLine(line, rule, {
        driverVector: opts.driverVectors?.get(rule.rule.id),
        driverDimension: opts.driverDimensions?.get(rule.rule.id),
        resolveDynamicTargets: opts.resolveDynamicTargets,
        groupId: mintGroupId(),
      });
      const base = output.length;
      output.push(...result.children);
      lineage.push(...toLineage(rule, result, base, null));
      exploded = true;
    } catch (error) {
      if (!(error instanceof EntryAllocationError)) throw error;
      output.push(plainLine(line));
    }
  });

  return { lines: output, lineage, exploded };
}
