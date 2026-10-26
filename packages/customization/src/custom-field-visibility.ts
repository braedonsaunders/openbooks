/**
 * Role visibility for custom field values. Pure and client-safe: the server
 * read and write paths and the form components apply this one rule.
 *
 * A definition with a non-empty `allowedRoles` list is visible only to
 * viewers holding one of those role keys, plus viewers who manage custom
 * fields. An absent or empty list leaves the field open to every role. A
 * malformed list is not interpreted loosely: it restricts the field to
 * managers, so an unreadable configuration never widens access.
 */

export interface CustomFieldViewer {
  /** Role keys (app_roles.key) the viewer holds. */
  roleKeys: readonly string[];
  /**
   * True for super administrators, holders of the admin role, and holders of
   * admin.custom_fields.manage. Managers see every field.
   */
  canManageCustomFields: boolean;
}

export interface CustomFieldVisibilityDef {
  key: string;
  config: { allowedRoles?: unknown } | null | undefined;
}

type CustomFieldAudience =
  { kind: "open" } | { kind: "roles"; roles: readonly string[] } | { kind: "managers" };

export function customFieldAudience(def: CustomFieldVisibilityDef): CustomFieldAudience {
  const config = def.config;
  if (config === null || config === undefined || config.allowedRoles === undefined)
    return { kind: "open" };
  const roles = config.allowedRoles;
  if (!Array.isArray(roles)) return { kind: "managers" };
  if (roles.length === 0) return { kind: "open" };
  if (roles.some((role) => typeof role !== "string" || role.trim() === ""))
    return { kind: "managers" };
  return { kind: "roles", roles: roles as string[] };
}

export function customFieldVisible(
  def: CustomFieldVisibilityDef,
  viewer: CustomFieldViewer,
): boolean {
  if (viewer.canManageCustomFields) return true;
  const audience = customFieldAudience(def);
  if (audience.kind === "open") return true;
  if (audience.kind === "managers") return false;
  return audience.roles.some((role) => viewer.roleKeys.includes(role));
}

export function visibleCustomFieldDefs<T extends CustomFieldVisibilityDef>(
  defs: readonly T[],
  viewer: CustomFieldViewer,
): T[] {
  return defs.filter((def) => customFieldVisible(def, viewer));
}

/** Keys of the definitions the viewer cannot see. Unknown keys are not listed. */
export function hiddenCustomFieldKeys(
  defs: readonly CustomFieldVisibilityDef[],
  viewer: CustomFieldViewer,
): Set<string> {
  return new Set(defs.filter((def) => !customFieldVisible(def, viewer)).map((def) => def.key));
}

/**
 * Copy of a stored custom bag without the values of fields the viewer cannot
 * see. Keys with no definition are kept: they are system metadata, not
 * configurable fields, and carry no role restriction.
 */
export function redactHiddenCustomValues<T extends Record<string, unknown> | null | undefined>(
  defs: readonly CustomFieldVisibilityDef[],
  viewer: CustomFieldViewer,
  custom: T,
): T {
  if (custom === null || custom === undefined) return custom;
  const hidden = hiddenCustomFieldKeys(defs, viewer);
  if (hidden.size === 0) return custom;
  const visible: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(custom)) {
    if (!hidden.has(key)) visible[key] = value;
  }
  return visible as T;
}
