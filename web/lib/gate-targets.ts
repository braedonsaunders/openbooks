/**
 * Shared denial destinations (F-t13-002/003/007/008, F-t12-001, F-t03-012).
 *
 * A route that exists but is gated off must explain itself: which feature or
 * permission is required and where it is turned on (or who can grant it) —
 * never a bare 404 or a silent bounce home. These builders are the single
 * place that maps a gate outcome to its explanation page, so every gate
 * names the same destinations. Pure (no imports): lib/authz,
 * lib/super-admin, lib/feature-gates and lib/compliance all depend on this
 * module, and none of them may depend on each other.
 */

/** Explanation page for a disabled feature: names it, links to Features. */
export function featureRequiredHref(featureKey: string): string {
  return `/feature-required?feature=${encodeURIComponent(featureKey)}`;
}

export function parseFeatureRequiredParam(
  value: string | string[] | undefined,
): string | null {
  const key = Array.isArray(value) ? value[0] : value;
  // Feature keys are camelCase slugs; anything else is a crafted URL, not a
  // gate outcome — the page answers not-found for those (honest nonexistent).
  return key && /^[a-zA-Z][a-zA-Z0-9]*$/.test(key) ? key : null;
}

/**
 * Explanation page for a refused visitor: either a missing permission
 * (names the key, points at an administrator) or the operator-only platform
 * console (no permission key exists for that — `scope=platform` selects its
 * copy). Exactly one of the two options is honored; scope wins when both
 * arrive, and neither is required — the refusal itself is real either way.
 */
export function accessDeniedHref(options?: { permission?: string; scope?: string }): string {
  if (options?.scope === "platform") return "/access-denied?scope=platform";
  const permission = options?.permission;
  return permission
    ? `/access-denied?permission=${encodeURIComponent(permission)}`
    : "/access-denied";
}
