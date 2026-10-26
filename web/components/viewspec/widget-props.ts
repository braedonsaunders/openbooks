import type { ReactNode } from "react";
import { isFieldRef, resolvePath } from "@braedonsaunders/appkit-viewspec";

export type WidgetRenderer = (
  props: Record<string, unknown>,
  scope?: unknown,
  searchParams?: Record<string, string | string[] | undefined>,
) => ReactNode;

export function str(props: Record<string, unknown>, key: string): string | undefined {
  const value = props[key];
  return typeof value === "string" ? value : undefined;
}

/** Finite numbers only: NaN and Infinity are treated as absent, so a widget
 *  falls back to its default rather than rendering a `NaN`. */
export function num(props: Record<string, unknown>, key: string): number | undefined {
  const value = props[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function stringRecord(
  props: Record<string, unknown>,
  key: string,
): Record<string, string> | undefined {
  const value = props[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Resolve any field references in a widget's props against the current scope.
 * One level deep — enough for per-item widgets inside `repeat`, and shallow
 * enough that it stays a lookup rather than a traversal language.
 */
export function resolveWidgetProps(
  props: Record<string, unknown> | undefined,
  scope: unknown,
): Record<string, unknown> {
  if (!props) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    out[key] = isFieldRef(value) ? resolvePath(scope, value.$) : value;
  }
  return out;
}
