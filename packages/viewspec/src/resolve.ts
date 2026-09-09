/**
 * Field resolution — the single, deliberately dumb indirection in ViewSpec.
 *
 * Resolving a `FieldRef` is a dot-path lookup and nothing else. There is no
 * expression evaluation, no function call, no fallback chain, no coercion of
 * one type into another. If a page needs a computed value, the loader computes
 * it and the spec binds the result; that constraint is the reason a tenant- or
 * agent-authored spec cannot become an execution surface.
 *
 * Prototype-pollution guard: path segments are rejected if they name
 * `__proto__`, `constructor`, or `prototype`. A spec is untrusted data and a
 * dot path is the one place it touches property lookup, so the check belongs
 * here rather than at the schema edge — it holds for every caller.
 */

import { isFieldRef, type FieldRef, type Value } from './types.ts'

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

export class SpecResolutionError extends Error {
  readonly name = 'SpecResolutionError'
}

/**
 * Read a dot path off a scope object. Returns `undefined` for a missing path
 * rather than throwing — a missing optional field is normal, and the renderer
 * decides how to present absence (fallback text, omitted widget).
 */
export function resolvePath(scope: unknown, path: string): unknown {
  const segments = path.split('.')
  let current: unknown = scope
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) {
      throw new SpecResolutionError(`illegal field path segment: ${segment}`)
    }
    if (current === null || current === undefined) return undefined
    if (typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/** Resolve a `Value<T>`: literals pass through, refs read from scope. */
export function resolveValue<T>(value: Value<T> | undefined, scope: unknown): T | undefined {
  if (value === undefined) return undefined
  if (isFieldRef(value)) return resolvePath(scope, value.$) as T | undefined
  return value
}

/** Resolve a required string, falling back to '' so a renderer never prints
 *  `undefined` into the document. */
export function resolveText(value: Value | undefined, scope: unknown): string {
  const resolved = resolveValue(value, scope)
  return resolved === undefined || resolved === null ? '' : String(resolved)
}

/** Resolve a ref that must yield an array (table rows). */
export function resolveRows(ref: FieldRef, scope: unknown): unknown[] {
  const value = resolvePath(scope, ref.$)
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new SpecResolutionError(`field "${ref.$}" must be an array of rows`)
  }
  return value
}

/** Resolve a ref that must yield a finite number (pagination counters). */
export function resolveNumber(ref: FieldRef, scope: unknown): number {
  const value = resolvePath(scope, ref.$)
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) {
    throw new SpecResolutionError(`field "${ref.$}" must be a number`)
  }
  return n
}
