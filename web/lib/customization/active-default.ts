/**
 * resolveFormLayout and resolveListView both select only is_active rows
 * before picking isDefault. A stored default that is inactive is a save
 * no resolve can observe — refuse it at the write, and name the remedies
 * the designer already exposes (activate, or unset default first).
 */

export type CustomizationDefaultKind = 'view' | 'form'

export type DefaultFlags = {
  isDefault: boolean
  isActive: boolean
}

/** Merge a PATCH onto the row that would be stored. Omitted flags stay. */
export function nextDefaultFlags(
  existing: DefaultFlags,
  patch: { isDefault?: boolean; isActive?: boolean },
): DefaultFlags {
  return {
    isDefault: patch.isDefault !== undefined ? patch.isDefault : existing.isDefault,
    isActive: patch.isActive !== undefined ? patch.isActive : existing.isActive,
  }
}

export function refuseInactiveDefault(args: {
  kind: CustomizationDefaultKind
  isDefault: boolean
  isActive: boolean
}): { ok: true } | { ok: false; error: string } {
  if (args.isDefault && !args.isActive) {
    return {
      ok: false,
      error: `An inactive ${args.kind} cannot be the default — activate it, or unset default before deactivating`,
    }
  }
  return { ok: true }
}
