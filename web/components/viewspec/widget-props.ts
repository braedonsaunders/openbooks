import type { ReactNode } from 'react'

export type WidgetRenderer = (props: Record<string, unknown>) => ReactNode

export function str(props: Record<string, unknown>, key: string): string | undefined {
  const value = props[key]
  return typeof value === 'string' ? value : undefined
}

/** Finite numbers only: NaN and Infinity are treated as absent, so a widget
 *  falls back to its default rather than rendering a `NaN`. */
export function num(props: Record<string, unknown>, key: string): number | undefined {
  const value = props[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Exact decimal text for financial props; JSON numbers are deliberately refused. */
export function decimalText(props: Record<string, unknown>, key: string): string | undefined {
  const value = props[key]
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) return undefined
  return value.trim()
}

export function stringRecord(props: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = props[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}
