/**
 * Placeholder-draft activation (F-t03-001).
 *
 * "New project" starts life as an inactive placeholder (`is_active = false`,
 * status `active`): activation requires a real name. Saving the
 * creation-completing name therefore activates the project; every later save
 * leaves `is_active` alone so an operator's explicit deactivation survives
 * ordinary edits.
 */

/** The name the draft-creation endpoint stamps on placeholder projects. */
export const PROJECT_PLACEHOLDER_NAME = 'New project'

/** True while the project still carries no operator-given name. */
export function isProjectPlaceholderName(name: string | null | undefined): boolean {
  const trimmed = (name ?? '').trim()
  return trimmed === '' || trimmed === PROJECT_PLACEHOLDER_NAME
}

/**
 * Whether a successful save should also flip the project active: only when
 * the persisted row is still an inactive placeholder and the saved name is
 * real. Returns false for already-active rows, for deactivated real projects,
 * and for saves that keep a placeholder name.
 */
export function shouldAutoActivateProject(
  persistedName: string | null | undefined,
  persistedIsActive: boolean,
  nextName: string,
): boolean {
  if (persistedIsActive) return false
  if (!isProjectPlaceholderName(persistedName)) return false
  return !isProjectPlaceholderName(nextName)
}
