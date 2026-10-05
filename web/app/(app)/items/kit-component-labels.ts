/**
 * A recipe line's readable identity. The component picker only offers
 * eligible choices, but the recipe keeps every line it was given — so the
 * label resolves from the line's own catalog snapshot (code, name) rather
 * than from the picker's choices. Only a line with no joined catalog row
 * falls back to a short storage id, and callers pair that fallback with
 * the unknown-component notice instead of presenting it as the name.
 */
export interface KitComponentIdentity {
  componentItemId: string
  code: string | null
  name: string | null
}

export function componentLabel(line: KitComponentIdentity): string {
  const code = line.code?.trim() ?? ''
  const name = line.name?.trim() ?? ''
  if (code && name) return `${code} · ${name}`
  if (name) return name
  if (code) return code
  return line.componentItemId.slice(0, 8)
}

/** Whether the joined catalog row stands behind the line. The API answers
 *  this explicitly with the joined row id; blank code or name alone proves
 *  nothing about the row behind them. */
export function isComponentIdentityMissing(joinedId: string | null): boolean {
  return joinedId == null
}

export interface EffectiveWindow {
  from: string | null
  to: string | null
}

/** Which caption a recipe line's effectivity window needs. The overview
 *  keeps every stored line including expired ones, so a bounded window
 *  names its dates and only an unbounded line stays captionless — the
 *  everyday reader never mistakes history for double consumption. */
export function effectiveWindowKind(window: EffectiveWindow): 'range' | 'from' | 'ended' | 'evergreen' {
  if (window.from && window.to) return 'range'
  if (window.from) return 'from'
  if (window.to) return 'ended'
  return 'evergreen'
}
