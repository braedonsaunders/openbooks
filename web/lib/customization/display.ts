import { DEFAULT_VIEW_NAME } from '../../../engine/src/provisioning/default-view-name.ts'

/**
 * Display names for resolved customization rows.
 *
 * Provisioned baselines use the shared name in
 * engine/src/provisioning/default-view-name.ts while the catalog carries the
 * translated system-default names. An unrenamed baseline row must render as
 * the translated default; a row the tenant renamed keeps its own name.
 */

export function displayListViewName(
  storedName: string | null | undefined,
  translatedDefault: string,
): string {
  if (!storedName || storedName === DEFAULT_VIEW_NAME) return translatedDefault
  return storedName
}
