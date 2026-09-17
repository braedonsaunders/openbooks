/**
 * Display names for resolved customization rows.
 *
 * Provisioned baselines are seeded in English (see
 * engine/src/customization-defaults.ts) while the catalog carries the
 * translated system-default names. An unrenamed baseline row must render as
 * the translated default; a row the tenant renamed keeps its own name.
 * `display.test.ts` pins the seed reference so the two cannot drift apart.
 */

/** English name the provisioning seed gives the baseline list view. */
export const SEEDED_DEFAULT_VIEW_NAME = 'Default view'

export function displayListViewName(
  storedName: string | null | undefined,
  translatedDefault: string,
): string {
  if (!storedName || storedName === SEEDED_DEFAULT_VIEW_NAME) return translatedDefault
  return storedName
}
