import {
  valueAllowed,
  type DimensionAssignment,
  type SegmentDependencyRule,
} from "@openbooks/engine/organization/segment-dependency-rules";
import { CLEAR_SEGMENT, INHERIT_SEGMENT } from "./segment-assignments";

/**
 * Line pickers offer only the segment values the line's other values allow
 * on the document date (segment value dependencies). The posting kernel and
 * the save path still decide; a value already chosen stays listed so the
 * line shows what it holds and the save names the conflict.
 */
export function dependentOptions<T extends { value: string }>(
  options: readonly T[],
  rules: readonly SegmentDependencyRule[],
  segmentId: string | undefined,
  line: DimensionAssignment,
  onDate: string,
  selected?: string | null,
): T[] {
  if (!segmentId || rules.length === 0 || !/^\d{4}-\d{2}-\d{2}$/.test(onDate)) return [...options];
  return options.filter(
    (option) =>
      option.value === "" ||
      option.value === INHERIT_SEGMENT ||
      option.value === CLEAR_SEGMENT ||
      option.value === selected ||
      valueAllowed(rules, segmentId, option.value, line, onDate),
  );
}

/** The rules carried on the segment options handed to a drawer, without duplicates. */
export function collectDependencyRules(
  segments: readonly { dependencies?: readonly SegmentDependencyRule[] }[],
): SegmentDependencyRule[] {
  const byId = new Map<string, SegmentDependencyRule>();
  for (const segment of segments)
    for (const rule of segment.dependencies ?? []) byId.set(rule.id, rule);
  return [...byId.values()];
}

/** A line's effective custom segment values: line overrides over header defaults. */
export function lineExtraDims(
  header: Readonly<Record<string, string | null>>,
  row: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Record<string, string | null> {
  const out: Record<string, string | null> = { ...header };
  for (const key of keys) {
    const value = row[`seg_${key}`];
    if (value === CLEAR_SEGMENT) out[key] = null;
    else if (typeof value === "string" && value !== "" && value !== INHERIT_SEGMENT)
      out[key] = value;
  }
  return out;
}
