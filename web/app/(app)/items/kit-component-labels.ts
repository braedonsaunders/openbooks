/**
 * A recipe line's readable identity. The component picker only offers
 * eligible choices, but the recipe keeps every line it was given — so the
 * label resolves from the line's own catalog snapshot (code, name, active
 * state) rather than from the picker's choices. A line whose item row is
 * gone has no name left; it falls back to a short storage id and callers
 * pair that with the unknown-component notice instead of a bare id.
 */
export interface KitComponentIdentity {
  id: string
  code: string | null
  name: string | null
  isActive: boolean | null
}

export function componentLabel(line: KitComponentIdentity): string {
  const code = line.code?.trim() ?? ''
  const name = line.name?.trim() ?? ''
  if (code && name) return `${code} · ${name}`
  if (name) return name
  if (code) return code
  return line.id.slice(0, 8)
}

export function isComponentIdentityMissing(line: KitComponentIdentity): boolean {
  return (line.code?.trim() ?? '') === '' && (line.name?.trim() ?? '') === ''
}
