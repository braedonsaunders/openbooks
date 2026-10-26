/**
 * Segment value dependencies ("filtered by"): a rule allows one value of a
 * segment only together with listed values of a controlling segment — for
 * example class X only with department A or B. Either side may be a custom
 * segment or a built-in dimension (subsidiary, department, class, location,
 * project). A line that carries the dependent value and either no value or
 * an unlisted value of the controlling segment violates the rule.
 *
 * Rules apply on the transaction's date (optional effective window) while
 * the Segment dependencies feature is on. The same evaluation serves the
 * posting kernel (every source), document saves, line pickers and the open
 * document validation report, so none of them can disagree. Posted history
 * is never re-evaluated. This module is the pure evaluation (no database
 * access), safe for line pickers in the browser.
 */

export const SEGMENT_DEPENDENCIES_FEATURE = "segmentDependencies";

export interface SegmentSideDefinition {
  id: string;
  key: string;
  name: string;
  sourceKind: "builtin" | "custom";
  storageColumn: string | null;
}

/**
 * One allowed pairing: `valueId` of `segment` is allowed with
 * `allowedValueId` of `controlling`. The pairings effective on a date for one
 * dependent value and controlling segment form that value's allowed set.
 */
export interface SegmentDependencyRule {
  id: string;
  segment: SegmentSideDefinition;
  valueId: string;
  valueLabel: string;
  controlling: SegmentSideDefinition;
  allowedValueId: string;
  allowedLabel: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
}

/** The dimension values a line carries after header inheritance. */
export interface DimensionAssignment {
  subsidiaryId?: string | null;
  departmentId?: string | null;
  projectId?: string | null;
  locationId?: string | null;
  classId?: string | null;
  extraDims?: Readonly<Record<string, unknown>> | null;
}

export interface SegmentDependencyViolation {
  ruleId: string;
  segmentName: string;
  valueLabel: string;
  controllingName: string;
  controllingValueId: string | null;
  allowedLabels: string[];
}

const STORAGE_FIELDS: Record<string, keyof DimensionAssignment> = {
  subsidiary_id: "subsidiaryId",
  department_id: "departmentId",
  project_id: "projectId",
  location_id: "locationId",
  class_id: "classId",
};

/** The value a line carries for one segment, or null. */
export function assignedValue(
  segment: Pick<SegmentSideDefinition, "sourceKind" | "storageColumn" | "key">,
  line: DimensionAssignment,
): string | null {
  if (segment.sourceKind === "builtin") {
    const field = segment.storageColumn ? STORAGE_FIELDS[segment.storageColumn] : undefined;
    const value = field ? line[field] : null;
    return typeof value === "string" && value !== "" ? value : null;
  }
  const value = line.extraDims?.[segment.key];
  return typeof value === "string" && value !== "" ? value : null;
}

/** Whether a pairing applies on a date (inclusive window; null bounds are open). */
export function ruleEffectiveOn(
  rule: Pick<SegmentDependencyRule, "effectiveFrom" | "effectiveTo">,
  onDate: string,
): boolean {
  return (
    (rule.effectiveFrom === null || rule.effectiveFrom <= onDate) &&
    (rule.effectiveTo === null || rule.effectiveTo >= onDate)
  );
}

interface AllowedSet {
  first: SegmentDependencyRule;
  allowed: Map<string, string>;
}

/** The allowed sets governing one dependent value on a date, keyed by controlling segment. */
function allowedSets(
  rules: readonly SegmentDependencyRule[],
  onDate: string,
  matches: (rule: SegmentDependencyRule) => boolean,
): AllowedSet[] {
  const sets = new Map<string, AllowedSet>();
  for (const rule of rules) {
    if (!ruleEffectiveOn(rule, onDate) || !matches(rule)) continue;
    const key = `${rule.segment.id}|${rule.valueId}|${rule.controlling.id}`;
    const set = sets.get(key) ?? { first: rule, allowed: new Map<string, string>() };
    set.allowed.set(rule.allowedValueId, rule.allowedLabel);
    sets.set(key, set);
  }
  return [...sets.values()];
}

/** Every allowed set the line breaks on the date. Pure. */
export function segmentDependencyViolations(
  rules: readonly SegmentDependencyRule[],
  line: DimensionAssignment,
  onDate: string,
): SegmentDependencyViolation[] {
  const violations: SegmentDependencyViolation[] = [];
  for (const set of allowedSets(
    rules,
    onDate,
    (rule) => assignedValue(rule.segment, line) === rule.valueId,
  )) {
    const controllingValue = assignedValue(set.first.controlling, line);
    if (controllingValue !== null && set.allowed.has(controllingValue)) continue;
    violations.push({
      ruleId: set.first.id,
      segmentName: set.first.segment.name,
      valueLabel: set.first.valueLabel,
      controllingName: set.first.controlling.name,
      controllingValueId: controllingValue,
      allowedLabels: [...set.allowed.values()],
    });
  }
  return violations;
}

/** Operator-facing refusal for one violation, naming the line and the remedy. */
export function describeViolation(
  violation: SegmentDependencyViolation,
  lineLabel: string,
): string {
  const allowed = violation.allowedLabels.join(" or ");
  const found =
    violation.controllingValueId === null
      ? `no ${violation.controllingName.toLowerCase()}`
      : `another ${violation.controllingName.toLowerCase()}`;
  return `${lineLabel}: ${violation.segmentName} "${violation.valueLabel}" is allowed only with ${violation.controllingName} ${allowed}, but the line has ${found}. Choose ${violation.controllingName} ${allowed} on the line, choose a different ${violation.segmentName.toLowerCase()}, or change the dependency rule under Setup → Segments.`;
}

/**
 * Whether a candidate value of a segment may be offered on a line, given the
 * line's other values: false when an effective rule on that value names a
 * controlling segment whose current value is not allowed. Pickers use this
 * to filter their options; the kernel still decides.
 */
export function valueAllowed(
  rules: readonly SegmentDependencyRule[],
  segmentId: string,
  valueId: string,
  line: DimensionAssignment,
  onDate: string,
): boolean {
  for (const set of allowedSets(
    rules,
    onDate,
    (rule) => rule.segment.id === segmentId && rule.valueId === valueId,
  )) {
    const controllingValue = assignedValue(set.first.controlling, line);
    if (controllingValue === null || !set.allowed.has(controllingValue)) return false;
  }
  return true;
}
